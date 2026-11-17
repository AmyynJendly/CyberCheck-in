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
import { emailMode, requireEnv, optionalEnv } from "./env";
import { qrPng } from "./qr";
import { prettyDate } from "./time";
import { looksLikeEmail } from "./validate";
import { DEFAULT_BODY, DEFAULT_SUBJECT } from "./email-defaults";
import { EMAIL_LOGO_PNG_BASE64 } from "./email-logo";

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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "Consolas,'Courier New','SF Mono',Monaco,monospace";
// The sessions are "stages" with card suits; the last day is the joker (final stage).
const SUITS = [
  ["♠", "#0284c7"],
  ["♦", "#d97706"],
  ["♣", "#16a34a"],
  ["♥", "#dc2626"],
] as const;
// A forwarded ticket lets someone else in: always say so.
const KEEP_PRIVATE = "Don't share this code. It works once per day.";
const shortDate = (day: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`));

/**
 * Render the email: the club's access-pass design (dark header, pass, QR,
 * checkpoint list, dark footer), with every style inline so Gmail and Outlook
 * show it as designed. The admin's text goes at the top (plain text: blank lines
 * separate paragraphs, "# " starts a headline, **bold**, {{placeholders}}). The
 * pass holder's name, the QR, the backup code, the checkpoints and the entry
 * rules are always added.
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
  const paragraphs = (ctx.bodyTemplate?.trim() || DEFAULT_BODY)
    .replace(/\r\n/g, "\n")
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

  const final = ctx.days.length > 1 ? ctx.days.length - 1 : -1;
  const checkpoints = ctx.days.map((d, i) => ({
    icon: i === final ? "🃏" : SUITS[i % SUITS.length][0],
    color: i === final ? "#92400e" : SUITS[i % SUITS.length][1],
    label: d.label || prettyDate(d.day_date),
    date: shortDate(d.day_date),
    stage: i === final ? "Final Stage" : `Stage ${i + 1}`,
    final: i === final,
    // Who gets in, next to the date (only when some day is not free for everyone).
    rule: access.length ? (d.access === "members" ? "Members only" : d.access === "members_or_fee" ? `Members free · others ${fmtDT(d.entry_fee ?? 5)}` : "Free entry") : "",
  }));
  const heading =
    final > 0 ? `Event checkpoints (${final} session${final === 1 ? "" : "s"} + ${checkpoints[final].label})` : ctx.days.length ? "Event checkpoint" : "";

  // Plain text, for mail apps that don't show HTML.
  const text = [
    ...paragraphs.map((p) => fill(p).replace(/^#\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")),
    `Pass holder: ${ctx.fullName}`,
    "[Your QR code is attached as qr.png] Show it at each session entrance.",
    `Backup code (if the QR doesn't work): ${ctx.shortCode}`,
    heading && [`${heading}:`, ...checkpoints.map((c) => `- ${c.label} · ${c.date} (${c.stage})`)].join("\n"),
    access.length ? ["Entry:", ...access.map((l) => `- ${l}`)].join("\n") : "",
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
        if (k === "code") return `<b style="font-family:${MONO};letter-spacing:2px;color:#0f172a">${esc(ctx.shortCode)}</b>`;
        const v = values[k];
        if (v === undefined) return m;
        return k === "name" || k === "event" ? `<strong>${esc(v)}</strong>` : esc(v);
      })
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/\n/g, "<br>");
  const cell = "padding:9px 14px;border-bottom:1px solid #edf2f7;color:#334155;font-size:13px";
  const rows = checkpoints
    .map((c, i) => {
      const last = i === checkpoints.length - 1 ? ";border-bottom:none" : "";
      return `<tr${c.final ? ' style="background:#fffbeb"' : ""}>
<td style="${cell}${last}${c.final ? ";font-weight:700;color:#92400e" : ""}"><span style="font-weight:700;margin-right:6px;color:${c.color}">${c.icon}</span>${esc(c.label)}<br><span style="font-size:12px;font-weight:400;color:#64748b">${c.date}${c.rule ? ` · ${c.rule}` : ""}</span></td>
<td style="${cell}${last};text-align:right;font-size:12px;${c.final ? "font-weight:700;color:#b45309" : "color:#64748b"}">${c.stage}</td>
</tr>`;
    })
    .join("\n");
  const logo = emailLogo();

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(ctx.eventName)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:24px 12px;font-family:${FONT};color:#1e293b">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;border-collapse:separate">

<tr><td style="background:#0f172a;padding:30px 20px 22px;text-align:center;border-radius:16px 16px 0 0">
${logo ? `<img src="cid:logo" width="76" alt="Cyber Trace" style="display:block;width:76px;height:auto;margin:0 auto 12px;border:0">` : ""}
<div style="font-size:11px;font-weight:700;color:#eab308;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 4px">Cyber Trace Club</div>
<h1 style="font-size:22px;font-weight:800;letter-spacing:0.5px;margin:0;color:#ffffff;line-height:1.3">${esc(ctx.eventName)}</h1>
${ctx.tagline?.trim() ? `<div style="font-size:12px;color:#94a3b8;margin-top:6px;letter-spacing:1px">${esc(ctx.tagline.trim())}</div>` : ""}
</td></tr>

<tr><td style="padding:26px 24px 16px;text-align:center">
<div style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;letter-spacing:1px;text-transform:uppercase;margin:0 0 14px;border:1px solid #fde68a">Official Access Pass</div>
${paragraphs
  .map((p) =>
    /^#\s+/.test(p)
      ? `<h2 style="font-size:20px;font-weight:700;color:#0f172a;margin:0 0 10px;line-height:1.35">${para(p.replace(/^#\s+/, ""))}</h2>`
      : `<p style="font-size:14px;line-height:1.6;color:#475569;margin:0 auto 12px;max-width:440px">${para(p)}</p>`,
  )
  .join("\n")}
<div style="border-top:2px dashed #cbd5e1;margin:22px 0 20px;height:0;line-height:0;font-size:0">&nbsp;</div>
<div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px">Pass holder</div>
<div style="font-family:${MONO};font-size:19px;font-weight:800;color:#1e3a8a;letter-spacing:0.8px;margin:0 0 14px;line-height:1.3">${esc(ctx.fullName)}</div>
<div style="display:inline-block;padding:12px;background:#ffffff;border:2px solid #e2e8f0;border-radius:14px;margin:0 0 12px"><img src="cid:qr" width="290" height="290" alt="Your QR access pass" style="display:block;width:290px;height:290px;border:0"></div>
<div style="font-family:${MONO};font-size:12px;color:#64748b;margin:0 0 22px;letter-spacing:1px">BACKUP CODE: <b style="font-size:15px;color:#0f172a;letter-spacing:3px">${esc(ctx.shortCode)}</b></div>
${
  checkpoints.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:left;margin:6px 0 12px">
<tr><td colspan="2" style="background:#f1f5f9;padding:10px 14px;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;border-radius:10px 10px 0 0">${esc(heading)}</td></tr>
${rows}
</table>`
    : ""
}
${
  ctx.days.some((d) => d.access === "members" || d.access === "members_or_fee")
    ? `<div style="font-size:12px;line-height:1.55;color:#64748b;margin:0 0 6px;padding:0 4px">Not a member? Join at the desk for <b style="color:#334155">${fmtDT(ctx.membershipFee ?? 15)}</b>: valid for the whole academic year, and every day is free.</div>`
    : ""
}
</td></tr>

<tr><td style="background:#0f172a;color:#94a3b8;padding:22px 20px;text-align:center;font-size:12px;line-height:1.6;border-radius:0 0 16px 16px">
<p style="margin:0 0 6px">Please present this QR code at each session entrance.${ctx.location ? ` · ${esc(ctx.location)}` : ""}</p>
<p style="margin:0 0 6px">${esc(KEEP_PRIVATE)}</p>
<p style="margin:0">Organized by <b style="color:#f8fafc">Cyber Trace Club</b></p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;

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
    qr_token: string;
    short_code: string;
    email_attempts: number;
    event_name: string;
    location: string | null;
    membership_fee: number;
    email_subject: string | null;
    email_body: string | null;
    email_tagline: string | null;
    days: { day_date: string; label: string | null; access: string; entry_fee: number }[];
  }>(
    `select a.id, a.event_id, a.full_name, a.email, a.qr_token, a.short_code, a.email_attempts,
            e.name as event_name, e.location, e.membership_fee, e.email_subject, e.email_body, e.email_tagline,
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

  try {
    const png = await qrPng(a.qr_token);
    const msg = buildQrEmail(
      a.email,
      {
        fullName: a.full_name,
        eventName: a.event_name,
        location: a.location,
        days: a.days,
        shortCode: a.short_code,
        membershipFee: a.membership_fee,
        tagline: a.email_tagline,
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
  await auditSafe({ staffId: opts.staffId, action: "email_sent", eventId: a.event_id, attendeeId: a.id, details: { reason: opts.reason, to: a.email, mode: emailMode() } });
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
  const out: DrainResult = { sent: 0, failed: 0, deferred: 0, remaining: 0, busy: false };
  const holder = randomUUID();

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
