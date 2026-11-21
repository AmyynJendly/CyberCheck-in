// QR emails: template rendering, Gmail SMTP delivery, and a single-sender queue.
//
// Why a queue: when registration opens, dozens of form responses can arrive in
// the same minute. Opening one Gmail connection per response makes Gmail
// throttle or block the account. Instead every new attendee is marked
// email_status='pending', and ONE sender at a time (a DB lease, safe with
// Supabase's pooler) works through the queue over a single reused SMTP
// connection. Temporary Gmail errors leave the email pending and it's retried
// (up to MAX_ATTEMPTS); only permanent errors mark it 'failed'.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { query } from "./db";
import { auditSafe } from "./audit";
import { emailMode, isPlaceholder, requireEnv, optionalEnv } from "./env";
import { qrPng } from "./qr";
import { prettyDate } from "./time";
import { looksLikeEmail } from "./validate";
import { DEFAULT_BODY, DEFAULT_SUBJECT } from "./email-defaults";
import { EMAIL_LOGO_PNG_BASE64 } from "./email-logo";
import { DEFAULT_DESIGN, EMAIL_DESIGNS, esc, renderEmail, type Block, type Checkpoint, type EmailDesign } from "./email-designs";

export interface QrEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  png: Buffer;
  /** The club logo (inline image "cid:logo"), or null when none is set. */
  logo: Buffer | null;
  shortCode: string;
}

export interface EmailContext {
  fullName: string;
  eventName: string;
  location: string | null;
  days: { day_date: string; label: string | null; access?: string; entry_fee?: number }[];
  shortCode: string;
  membershipFee?: number;
  /** Line under the event name in the header (Admin → Emails), e.g. the edition theme. */
  tagline?: string | null;
  /** "borderland" (default) or "classic" — see email-designs.ts. */
  design?: string | null;
  /** Custom template from Admin → Emails; null/empty = the defaults in email-defaults.ts. */
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
}

let logoCache: Buffer | null | undefined;
function emailLogo(): Buffer | null {
  return (logoCache ??= EMAIL_LOGO_PNG_BASE64 ? Buffer.from(EMAIL_LOGO_PNG_BASE64, "base64") : null);
}

export const fmtDT = (n: number) => `${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)} DT`;

/** One line per day explaining who gets in free. Empty when every day is free. */
export function accessLines(ctx: Pick<EmailContext, "days" | "membershipFee">): string[] {
  if (!ctx.days.some((d) => d.access && d.access !== "free")) return [];
  const fee = fmtDT(ctx.membershipFee ?? 15);
  const lines = ctx.days.map((d) => {
    const name = d.label || prettyDate(d.day_date);
    if (d.access === "members") return `${name}: club members only. Not a member? Join at the desk for ${fee}.`;
    if (d.access === "members_or_fee") return `${name}: free for club members, ${fmtDT(d.entry_fee ?? 5)} for everyone else.`;
    return `${name}: free for everyone.`;
  });
  lines.push(`Club membership costs ${fee}, is valid for the whole academic year, and makes every day free.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export { DEFAULT_BODY, DEFAULT_SUBJECT, PLACEHOLDERS } from "./email-defaults";

const MONO = "Consolas,'Courier New','SF Mono',Monaco,monospace";
// The sessions are "stages", each a card suit; the last day is the Joker (final stage).
const SUITS = ["♠", "♦", "♣", "♥"] as const;
// A forwarded ticket lets someone else in: always say so.
const KEEP_PRIVATE = "Don't share this code. It works once per day.";
const shortDate = (day: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`));

/**
 * Render the email in the event's design (src/lib/email-designs.ts), every style
 * inline so Gmail and Outlook show it as designed. The admin's text is plain
 * text: blank lines separate paragraphs, "# " starts a headline, **bold**,
 * {{placeholders}}; text after a "---" line goes below the session list (notes).
 * The player's name, the QR, the backup code, the sessions and the entry rules
 * are always added.
 */
export function buildQrEmail(to: string, ctx: EmailContext, png: Buffer): QrEmail {
  const access = accessLines(ctx);
  const dates = ctx.days.map((d) => `${d.label ? d.label + " — " : ""}${prettyDate(d.day_date)}`);
  const values: Record<string, string> = {
    name: ctx.fullName,
    event: ctx.eventName,
    code: ctx.shortCode,
    dates: dates.length ? `When: ${dates.join("; ")}` : "",
    location: ctx.location ? `Where: ${ctx.location}` : "",
    entry: access.length ? ["Entry:", ...access.map((l) => `- ${l}`)].join("\n") : "",
  };
  const fill = (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k === "qr" ? "" : (values[k] ?? m)));
  const subject = fill(ctx.subjectTemplate?.trim() || DEFAULT_SUBJECT).replace(/\s+/g, " ").trim();

  // The admin's text: paragraphs, minus what the layout always shows (the QR) and empty placeholders.
  const toParagraphs = (s: string) =>
    s
      .replace(/\{\{\s*qr\s*\}\}/g, "")
      .split(/\n{2,}/)
      .map((p) =>
        p
          .split("\n")
          .filter((line) => !/^\s*\{\{\s*(dates|location|entry)\s*\}\}\s*$/.test(line) || values[line.replace(/[{}\s]/g, "")])
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
  const [topText, ...noteParts] = (ctx.bodyTemplate?.trim() || DEFAULT_BODY).replace(/\r\n/g, "\n").split(/^\s*-{3,}\s*$/m);
  const top = toParagraphs(topText);
  const notes = toParagraphs(noteParts.join("\n\n"));

  const final = ctx.days.length > 1 ? ctx.days.length - 1 : -1;
  const checkpoints: Checkpoint[] = ctx.days.map((d, i) => ({
    index: i,
    suit: SUITS[i % SUITS.length],
    label: d.label || prettyDate(d.day_date),
    date: shortDate(d.day_date),
    // Who gets in, next to the date (only when some day is not free for everyone).
    rule: access.length ? (d.access === "members" ? "Members only" : d.access === "members_or_fee" ? `Members free · others ${fmtDT(d.entry_fee ?? 5)}` : "Free entry") : "",
    stage: i === final ? "Final Stage" : `Stage ${i + 1}`,
    final: i === final,
  }));
  const heading = final > 0 ? `${final} session${final === 1 ? "" : "s"} + ${checkpoints[final].label}` : ctx.days.length ? "1 day" : "";

  // Plain text, for mail apps that don't show HTML.
  const plain = (p: string) => fill(p).replace(/^#\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1");
  const text = [
    ...top.map(plain),
    `Player: ${ctx.fullName}`,
    "[Your QR code is attached as qr.png] Show it at each session entrance.",
    `Backup code (if the QR doesn't work): ${ctx.shortCode}`,
    heading && [`Sessions (${heading}):`, ...checkpoints.map((c) => `- ${c.label} · ${c.date} (${c.stage})`)].join("\n"),
    access.length ? ["Entry:", ...access.map((l) => `- ${l}`)].join("\n") : "",
    ...notes.map(plain),
    ctx.location ? `Where: ${ctx.location}` : "",
    KEEP_PRIVATE,
    "Organized by Cyber Trace Club",
  ]
    .filter(Boolean)
    .join("\n\n");

  // HTML
  const para = (p: string) =>
    esc(p)
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
        if (k === "code") return `<b style="font-family:${MONO};letter-spacing:2px">${esc(ctx.shortCode)}</b>`;
        const v = values[k];
        if (v === undefined) return m;
        return k === "name" || k === "event" ? `<strong>${esc(v)}</strong>` : esc(v);
      })
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/\n/g, "<br>");
  // "# " makes its own line a headline; the lines under it stay normal text.
  const blocks = (ps: string[]): Block[] =>
    ps.flatMap((p) => {
      if (!/^#\s+/.test(p)) return [{ headline: false, html: para(p) }];
      const [first, ...rest] = p.replace(/^#\s+/, "").split("\n");
      const body = rest.join("\n").trim();
      return [{ headline: true, html: para(first) }, ...(body ? [{ headline: false, html: para(body) }] : [])];
    });
  const logo = emailLogo();
  const design: EmailDesign = EMAIL_DESIGNS.includes(ctx.design as EmailDesign) ? (ctx.design as EmailDesign) : DEFAULT_DESIGN;
  const html = renderEmail(design, {
    eventName: ctx.eventName,
    tagline: ctx.tagline?.trim() ?? "",
    fullName: ctx.fullName,
    shortCode: ctx.shortCode,
    location: ctx.location,
    top: blocks(top),
    notes: blocks(notes),
    checkpoints,
    heading,
    joinFee: ctx.days.some((d) => d.access === "members" || d.access === "members_or_fee") ? fmtDT(ctx.membershipFee ?? 15) : null,
    logo: !!logo,
    keepPrivate: KEEP_PRIVATE,
  });

  return { to, subject, html, text, png, logo, shortCode: ctx.shortCode };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type G = { __ctTransport?: Transporter; __ctOutbox?: QrEmail[] };
const g = globalThis as G;

/** In DEV_EMAIL_MODE=log, every "sent" email is also kept here (used by tests). */
export function devOutbox(): QrEmail[] {
  return (g.__ctOutbox ??= []);
}

function transport(): Transporter {
  if (!g.__ctTransport) {
    g.__ctTransport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: requireEnv("GMAIL_USER"), pass: requireEnv("GMAIL_APP_PASSWORD").replace(/\s+/g, "") },
      // One reused connection: Gmail-friendly and much faster than a login per email.
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return g.__ctTransport;
}

async function deliverLog(msg: QrEmail): Promise<void> {
  devOutbox().push(msg);
  const dir = optionalEnv("DEV_EMAIL_DIR") ?? path.join(process.cwd(), "dev-emails");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${stamp}-${msg.shortCode}`;
  await writeFile(path.join(dir, `${base}-qr.png`), msg.png);
  if (msg.logo) await writeFile(path.join(dir, "logo.png"), msg.logo);
  // Saved HTML points at the images on disk so you can open it in a browser.
  await writeFile(path.join(dir, `${base}.html`), msg.html.replace("cid:qr", `${base}-qr.png`).replace("cid:logo", "logo.png"));
  if (!process.env.VITEST) {
    console.log(
      ["──────── DEV_EMAIL_MODE=log (not sent) ────────", `To:      ${msg.to}`, `Subject: ${msg.subject}`, `QR PNG:  ${path.join(dir, `${base}-qr.png`)}`, "", msg.text, "───────────────────────────────────────────────"].join("\n"),
    );
  }
}

async function deliverSmtp(msg: QrEmail): Promise<void> {
  await transport().sendMail({
    from: { name: "Cybertrace Club", address: requireEnv("GMAIL_USER") },
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: [
      { filename: "qr.png", content: msg.png, contentType: "image/png", cid: "qr", contentDisposition: "inline" },
      ...(msg.logo ? [{ filename: "logo.png", content: msg.logo, contentType: "image/png", cid: "logo", contentDisposition: "inline" as const }] : []),
      { filename: "qr.png", content: msg.png, contentType: "image/png" },
    ],
  });
}

type Gauge = { inFlight: number; maxInFlight: number };
/** How many emails were being delivered at the same moment (tests check it never exceeds 1 via the queue). */
export function deliveryGauge(): Gauge {
  return ((globalThis as { __ctGauge?: Gauge }).__ctGauge ??= { inFlight: 0, maxInFlight: 0 });
}

export async function deliver(msg: QrEmail): Promise<void> {
  const gauge = deliveryGauge();
  gauge.inFlight++;
  gauge.maxInFlight = Math.max(gauge.maxInFlight, gauge.inFlight);
  try {
    if (emailMode() === "log") {
      await new Promise((r) => setTimeout(r, 2)); // let concurrency show up in tests
      return await deliverLog(msg);
    }
    return await deliverSmtp(msg);
  } finally {
    gauge.inFlight--;
  }
}

/** Gmail / network hiccups worth retrying later (vs. a bad address). */
export function isTransientMailError(err: unknown): boolean {
  const e = err as { responseCode?: number; code?: string };
  // Login problems are configuration (app password not set / revoked): keep emails queued until it's fixed.
  if (e?.code === "EAUTH") return true;
  if (typeof e?.responseCode === "number") return e.responseCode >= 400 && e.responseCode < 500;
  return ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNRESET", "EAUTH", "EENVELOPE_TEMP"].includes(e?.code ?? "") || /placeholder|Missing environment/i.test(String((err as Error)?.message ?? ""));
}

// ---------------------------------------------------------------------------
// Send one attendee their QR
// ---------------------------------------------------------------------------

export type SendReason = "form" | "walk_in" | "resend" | "retry" | "import" | "queue";

export interface SendOutcome {
  ok: boolean;
  email_status: "none" | "sent" | "failed" | "pending";
  error?: string;
  transient?: boolean;
}

export const MAX_ATTEMPTS = 5;

async function loadForEmail(attendeeId: string) {
  const r = await query<{
    id: string;
    event_id: string;
    full_name: string;
    email: string | null;
    alt_email: string | null;
    qr_token: string;
    short_code: string;
    email_attempts: number;
    event_name: string;
    location: string | null;
    membership_fee: number;
    email_subject: string | null;
    email_body: string | null;
    email_tagline: string | null;
    email_design: string | null;
    days: { day_date: string; label: string | null; access: string; entry_fee: number }[];
  }>(
    `select a.id, a.event_id, a.full_name, a.email, a.alt_email, a.qr_token, a.short_code, a.email_attempts,
            e.name as event_name, e.location, e.membership_fee, e.email_subject, e.email_body, e.email_tagline, e.email_design,
            coalesce((select json_agg(json_build_object('day_date', d.day_date, 'label', d.label, 'access', d.access, 'entry_fee', d.entry_fee) order by d.day_date)
                        from event_days d where d.event_id = e.id), '[]') as days
       from attendees a join events e on e.id = a.event_id where a.id = $1`,
    [attendeeId],
  );
  return r.rows[0] ?? null;
}

/**
 * Render + send one attendee's QR email and record the outcome.
 * `queued`: called by the queue worker — a temporary error leaves the email
 * pending for a later retry instead of marking it failed.
 */
export async function sendAttendeeEmail(attendeeId: string, opts: { reason: SendReason; staffId?: string | null; queued?: boolean }): Promise<SendOutcome> {
  const a = await loadForEmail(attendeeId);
  if (!a) throw new Error(`attendee ${attendeeId} not found`);

  if (!a.email) {
    await query("update attendees set email_status = 'none', email_error = null where id = $1", [a.id]);
    return { ok: false, email_status: "none", error: "No email address." };
  }

  const fail = async (error: string, transient: boolean): Promise<SendOutcome> => {
    const short = error.slice(0, 500);
    const attempts = a.email_attempts + 1;
    const keepPending = opts.queued && transient && attempts < MAX_ATTEMPTS;
    await query("update attendees set email_status = $2, email_error = $3, email_attempts = $4, updated_at = now() where id = $1", [
      a.id,
      keepPending ? "pending" : "failed",
      short,
      attempts,
    ]);
    if (!keepPending) {
      await auditSafe({ staffId: opts.staffId, action: "email_failed", eventId: a.event_id, attendeeId: a.id, details: { reason: opts.reason, to: a.email, error: short } });
    }
    return { ok: false, email_status: keepPending ? "pending" : "failed", error: short, transient };
  };

  if (!looksLikeEmail(a.email)) return fail("Invalid email address.", false);
  // Registered with two addresses: one message to both.
  const to = a.alt_email && a.alt_email !== a.email && looksLikeEmail(a.alt_email) ? `${a.email}, ${a.alt_email}` : a.email;

  try {
    const png = await qrPng(a.qr_token);
    const msg = buildQrEmail(
      to,
      {
        fullName: a.full_name,
        eventName: a.event_name,
        location: a.location,
        days: a.days,
        shortCode: a.short_code,
        membershipFee: a.membership_fee,
        tagline: a.email_tagline,
        design: a.email_design,
        subjectTemplate: a.email_subject,
        bodyTemplate: a.email_body,
      },
      png,
    );
    await deliver(msg);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), isTransientMailError(err));
  }

  await query("update attendees set email_status = 'sent', email_error = null, email_sent_at = now(), email_attempts = 0 where id = $1", [a.id]);
  await auditSafe({ staffId: opts.staffId, action: "email_sent", eventId: a.event_id, attendeeId: a.id, details: { reason: opts.reason, to, mode: emailMode() } });
  return { ok: true, email_status: "sent" };
}

// ---------------------------------------------------------------------------
// Queue worker
// ---------------------------------------------------------------------------

const LEASE = "email-sender";
const LEASE_SECONDS = 90;

async function acquireLease(holder: string): Promise<boolean> {
  const r = await query(
    `insert into job_leases (name, holder, locked_until) values ($1, $2, now() + make_interval(secs => $3))
     on conflict (name) do update set holder = excluded.holder, locked_until = excluded.locked_until
       where job_leases.locked_until < now()
     returning holder`,
    [LEASE, holder, LEASE_SECONDS],
  );
  return r.rowCount === 1;
}
async function renewLease(holder: string): Promise<boolean> {
  const r = await query("update job_leases set locked_until = now() + make_interval(secs => $3) where name = $1 and holder = $2", [LEASE, holder, LEASE_SECONDS]);
  return r.rowCount === 1;
}
async function releaseLease(holder: string): Promise<void> {
  await query("update job_leases set locked_until = now() where name = $1 and holder = $2", [LEASE, holder]);
}

export interface DrainResult {
  sent: number;
  failed: number;
  deferred: number;
  remaining: number;
  busy: boolean; // another sender holds the queue
  not_configured: boolean; // no Gmail app password yet: nothing was tried
}

/** Can real emails go out? (Log mode always can.) Without the Gmail app password, queued emails just wait. */
export function smtpReady(): boolean {
  if (emailMode() === "log") return true;
  const user = optionalEnv("GMAIL_USER");
  const pass = optionalEnv("GMAIL_APP_PASSWORD");
  return !!user && !!pass && !isPlaceholder(user) && !isPlaceholder(pass);
}

export async function pendingEmailCount(eventId?: string | null): Promise<number> {
  const r = await query<{ n: number }>(
    "select count(*)::int as n from attendees where email_status = 'pending' and email is not null and ($1::uuid is null or event_id = $1)",
    [eventId ?? null],
  );
  return r.rows[0].n;
}

/**
 * Send pending emails one at a time until the queue is empty or the time
 * budget runs out. Safe to call from anywhere, any number of times: only one
 * caller sends, the others return immediately (busy).
 */
export async function drainEmailQueue(opts: { budgetMs?: number; gapMs?: number } = {}): Promise<DrainResult> {
  const budget = opts.budgetMs ?? 40_000;
  const gap = opts.gapMs ?? (emailMode() === "log" ? 0 : 250);
  const started = Date.now();
  const out: DrainResult = { sent: 0, failed: 0, deferred: 0, remaining: 0, busy: false, not_configured: false };
  const holder = randomUUID();
  // No Gmail password yet: don't try (each try would use up one of the email's attempts).
  if (!smtpReady()) {
    out.not_configured = true;
    out.remaining = await pendingEmailCount();
    return out;
  }

  let stop = false;
  while (!stop && Date.now() - started < budget) {
    if (!(await acquireLease(holder))) {
      out.busy = true;
      break;
    }
    try {
      work: for (;;) {
        const batch = await query<{ id: string }>(
          "select id from attendees where email_status = 'pending' and email is not null order by updated_at, created_at limit 10",
        );
        if (!batch.rowCount) break;
        for (const { id } of batch.rows) {
          if (Date.now() - started > budget) break work;
          const r = await sendAttendeeEmail(id, { reason: "queue", queued: true });
          if (r.ok) out.sent++;
          else if (r.email_status === "pending") {
            out.deferred++;
            stop = true; // Gmail is pushing back: stop now, the next run retries.
            break work;
          } else out.failed++;
          if (!(await renewLease(holder))) {
            stop = true;
            break work;
          }
          if (gap) await new Promise((res) => setTimeout(res, gap));
        }
      }
    } finally {
      await releaseLease(holder);
    }
    // Something may have been queued while we were releasing (its own sender saw us busy): look once more.
    if (stop || (await pendingEmailCount()) === 0) break;
  }
  out.remaining = await pendingEmailCount();
  return out;
}

/** Run work after the HTTP response is sent (Vercel waitUntil via next/server `after`). */
export async function runAfterResponse(task: () => Promise<unknown>): Promise<void> {
  const safe = () =>
    task().catch((err) => {
      console.error("[after] background task failed", err);
    });
  try {
    const { after } = await import("next/server");
    after(safe);
  } catch {
    // Outside a Next.js request (scripts, tests): just run it now.
    await safe();
  }
}

/** Kick the queue after the response (form submissions, walk-ins, imports). */
export function drainAfterResponse(): Promise<void> {
  return runAfterResponse(() => drainEmailQueue({ budgetMs: 45_000 }));
}
