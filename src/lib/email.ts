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
  days: { day_date: string; label: string | null }[];
  shortCode: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildQrEmail(to: string, ctx: EmailContext, png: Buffer): QrEmail {
  const dates = ctx.days.map((d) => `${d.label ? d.label + " — " : ""}${prettyDate(d.day_date)}`);
  const subject = `Your check-in QR code — ${ctx.eventName}`;

  const text = [
    `Hi ${ctx.fullName},`,
    "",
    `You're registered for ${ctx.eventName}.`,
    dates.length ? `Date${dates.length > 1 ? "s" : ""}: ${dates.join("; ")}` : "",
    ctx.location ? `Location: ${ctx.location}` : "",
    "",
    "Show the attached QR code (qr.png) at the entrance.",
    `If the QR doesn't work, give this code at the desk: ${ctx.shortCode}`,
    "",
    "Don't share this code. It works once per day.",
    "",
    "— Cybertrace Club",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue','Segoe UI',Roboto,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f7;padding:24px 0">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td>
  <p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#0a7f94;margin:0 0 8px">Cybertrace Club</p>
  <h1 style="font-size:22px;margin:0 0 16px">Hi ${esc(ctx.fullName)},</h1>
  <p style="font-size:16px;line-height:1.5;margin:0 0 12px">You're registered for <strong>${esc(ctx.eventName)}</strong>.</p>
  ${dates.length ? `<p style="font-size:15px;line-height:1.5;margin:0 0 4px"><strong>When:</strong> ${dates.map(esc).join("<br>")}</p>` : ""}
  ${ctx.location ? `<p style="font-size:15px;line-height:1.5;margin:0 0 4px"><strong>Where:</strong> ${esc(ctx.location)}</p>` : ""}
  <p style="font-size:15px;line-height:1.5;margin:16px 0 8px">Show this QR code at the entrance:</p>
  <p style="text-align:center;margin:0 0 16px"><img src="cid:qr" alt="Your check-in QR code" width="260" height="260" style="width:260px;height:260px;border:1px solid #e5e7eb;border-radius:8px"></p>
  <p style="font-size:15px;line-height:1.5;margin:0 0 6px">If the QR doesn't work, give this code at the desk:</p>
  <p style="font-size:34px;font-weight:bold;letter-spacing:6px;font-family:'Courier New',monospace;text-align:center;margin:0 0 16px;color:#0a7f94">${esc(ctx.shortCode)}</p>
  <p style="font-size:14px;line-height:1.5;margin:0;color:#b91c1c"><strong>Don't share this code. It works once per day.</strong></p>
  <p style="font-size:13px;color:#6b7280;margin:24px 0 0">— Cybertrace Club</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  return { to, subject, html, text, png, shortCode: ctx.shortCode };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type G = { __ctTransport?: Transporter; __ctOutbox?: QrEmail[]; __ctMailQueue?: Promise<unknown> };
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
      [
        "──────── DEV_EMAIL_MODE=log (not sent) ────────",
        `To:      ${msg.to}`,
        `Subject: ${msg.subject}`,
        `QR PNG:  ${path.join(dir, `${base}-qr.png`)}`,
        "",
        msg.text,
        "───────────────────────────────────────────────",
      ].join("\n"),
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

/** One email at a time per server instance — no bursts at Gmail. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__ctMailQueue ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  g.__ctMailQueue = next.catch(() => {});
  return next;
}

export async function deliver(msg: QrEmail): Promise<void> {
  return serialized(() => (emailMode() === "log" ? deliverLog(msg) : deliverSmtp(msg)));
}

// ---------------------------------------------------------------------------
// Send an attendee their QR and record the outcome.
// ---------------------------------------------------------------------------

export type SendReason = "form" | "walk_in" | "resend" | "retry";

export interface SendOutcome {
  ok: boolean;
  email_status: "none" | "sent" | "failed";
  error?: string;
}

export async function sendAttendeeEmail(attendeeId: string, opts: { reason: SendReason; staffId?: string | null }): Promise<SendOutcome> {
  const r = await query<{
    id: string;
    event_id: string;
    full_name: string;
    email: string | null;
    qr_token: string;
    short_code: string;
    event_name: string;
    location: string | null;
  }>(
    `select a.id, a.event_id, a.full_name, a.email, a.qr_token, a.short_code, e.name as event_name, e.location
       from attendees a join events e on e.id = a.event_id where a.id = $1`,
    [attendeeId],
  );
  const a = r.rows[0];
  if (!a) throw new Error(`attendee ${attendeeId} not found`);

  if (!a.email) {
    await query("update attendees set email_status = 'none', email_error = null where id = $1", [a.id]);
    return { ok: false, email_status: "none", error: "No email address." };
  }

  const fail = async (error: string): Promise<SendOutcome> => {
    const short = error.slice(0, 500);
    await query("update attendees set email_status = 'failed', email_error = $2 where id = $1", [a.id, short]);
    await auditSafe({ staffId: opts.staffId, action: "email_failed", eventId: a.event_id, attendeeId: a.id, details: { reason: opts.reason, to: a.email, error: short } });
    return { ok: false, email_status: "failed", error: short };
  };

  if (!looksLikeEmail(a.email)) return fail("Invalid email address.");

  try {
    const days = await query<{ day_date: string; label: string | null }>(
      "select day_date, label from event_days where event_id = $1 order by day_date",
      [a.event_id],
    );
    const png = await qrPng(a.qr_token);
    const msg = buildQrEmail(
      a.email,
      { fullName: a.full_name, eventName: a.event_name, location: a.location, days: days.rows, shortCode: a.short_code },
      png,
    );
    await deliver(msg);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  await query("update attendees set email_status = 'sent', email_error = null, email_sent_at = now() where id = $1", [a.id]);
  await auditSafe({ staffId: opts.staffId, action: "email_sent", eventId: a.event_id, attendeeId: a.id, details: { reason: opts.reason, to: a.email, mode: emailMode() } });
  return { ok: true, email_status: "sent" };
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
