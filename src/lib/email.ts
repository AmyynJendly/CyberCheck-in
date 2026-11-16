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

export interface QrEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  png: Buffer;
  shortCode: string;
}

export interface EmailContext {
  fullName: string;
  eventName: string;
  location: string | null;
  days: { day_date: string; label: string | null; access?: string; entry_fee?: number }[];
  shortCode: string;
  membershipFee?: number;
  /** Custom template from Admin → Emails; null/empty = the defaults below. */
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
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

export const DEFAULT_SUBJECT = "Your check-in QR code — {{event}}";
export const DEFAULT_BODY = `Hi {{name}},

You're registered for {{event}}.
{{dates}}
{{location}}

Show this QR code at the entrance:
{{qr}}

If the QR doesn't work, give this code at the desk: {{code}}

{{entry}}

Don't share this code. It works once per day.

— Cybertrace Club`;

export const PLACEHOLDERS = ["name", "event", "code", "qr", "dates", "location", "entry"] as const;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const QR_HTML = `<p style="text-align:center;margin:8px 0 16px"><img src="cid:qr" alt="Your check-in QR code" width="260" height="260" style="width:260px;height:260px;border:1px solid #e5e5ea;border-radius:10px"></p>`;

/**
 * Render the email. The template is plain text: blank lines separate
 * paragraphs, {{placeholders}} are filled in. {{qr}} and {{code}} are always
 * present — added at the end if the template leaves them out.
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
  const subject = (ctx.subjectTemplate?.trim() || DEFAULT_SUBJECT).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k === "qr" ? "" : (values[k] ?? m))).replace(/\s+/g, " ").trim();

  let body = (ctx.bodyTemplate?.trim() || DEFAULT_BODY).replace(/\r\n/g, "\n");
  if (!/\{\{\s*qr\s*\}\}/.test(body)) body += "\n\n{{qr}}";
  if (!/\{\{\s*code\s*\}\}/.test(body)) body += "\n\nBackup code (if the QR doesn't work): {{code}}";
  // Block placeholders get their own paragraph.
  body = body.replace(/[ \t]*\{\{\s*(qr|entry)\s*\}\}[ \t]*/g, "\n\n{{$1}}\n\n");

  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.split("\n").filter((line) => !/^\s*\{\{\s*(dates|location|entry)\s*\}\}\s*$/.test(line) || values[line.replace(/[{}\s]/g, "")]).join("\n"))
    .map((p) => p.trim())
    .filter(Boolean);

  // Plain text
  const text = paragraphs
    .map((p) => (p === "{{qr}}" ? "[Your QR code is attached as qr.png]" : p.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => values[k] ?? m)))
    .join("\n\n");

  // HTML
  const htmlParas = paragraphs.map((p) => {
    if (p === "{{qr}}") return QR_HTML;
    if (p === "{{entry}}") {
      return `<div style="background:#f2f2f7;border-radius:10px;padding:12px 14px;margin:0 0 14px"><p style="font-size:14px;font-weight:bold;margin:0 0 6px">Entry</p><ul style="font-size:14px;line-height:1.5;margin:0;padding-left:18px">${access.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`;
    }
    const inner = esc(p)
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
        if (k === "code") {
          return `<strong style="font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:22px;letter-spacing:4px;color:#0a7f94;white-space:nowrap">${esc(ctx.shortCode)}</strong>`;
        }
        const v = values[k];
        if (v === undefined) return m;
        return k === "name" || k === "event" ? `<strong>${esc(v)}</strong>` : esc(v);
      })
      .replace(/\n/g, "<br>");
    return `<p style="font-size:16px;line-height:1.5;margin:0 0 14px">${inner}</p>`;
  });

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue','Segoe UI',Roboto,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f7;padding:24px 0">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:28px">
<tr><td>
<p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#0a7f94;margin:0 0 14px">Cybertrace Club</p>
${htmlParas.join("\n")}
</td></tr></table>
</td></tr></table>
</body></html>`;

  return { to, subject, html, text, png, shortCode: ctx.shortCode };
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
  // Saved HTML points at the PNG on disk so you can open it in a browser.
  await writeFile(path.join(dir, `${base}.html`), msg.html.replace("cid:qr", `${base}-qr.png`));
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
    days: { day_date: string; label: string | null; access: string; entry_fee: number }[];
  }>(
    `select a.id, a.event_id, a.full_name, a.email, a.qr_token, a.short_code, a.email_attempts,
            e.name as event_name, e.location, e.membership_fee, e.email_subject, e.email_body,
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
