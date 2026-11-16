// Admin tools for the email template: preview and test send.
import { buildQrEmail, deliver, type QrEmail } from "./email";
import { query } from "./db";
import { HttpError } from "./http";
import { newQrToken } from "./ids";
import { qrPng } from "./qr";

async function sample(eventId: string, subject: unknown, body: unknown, to: string): Promise<QrEmail> {
  const r = await query<{
    name: string;
    location: string | null;
    membership_fee: number;
    email_subject: string | null;
    email_body: string | null;
    days: { day_date: string; label: string | null; access: string; entry_fee: number }[];
  }>(
    `select e.name, e.location, e.membership_fee, e.email_subject, e.email_body,
            coalesce((select json_agg(json_build_object('day_date', d.day_date, 'label', d.label, 'access', d.access, 'entry_fee', d.entry_fee) order by d.day_date)
                        from event_days d where d.event_id = e.id), '[]') as days
       from events e where e.id = $1`,
    [eventId],
  );
  const e = r.rows[0];
  if (!e) throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
  // A QR that isn't anyone's ticket (scanning it says "Invalid").
  const png = await qrPng(newQrToken());
  return buildQrEmail(
    to,
    {
      fullName: "Yasmine Gharbi",
      eventName: e.name,
      location: e.location,
      days: e.days,
      shortCode: "K7Q9XM",
      membershipFee: e.membership_fee,
      subjectTemplate: typeof subject === "string" ? subject : e.email_subject,
      bodyTemplate: typeof body === "string" ? body : e.email_body,
    },
    png,
  );
}

export async function previewEmail(eventId: string, subject: unknown, body: unknown) {
  const m = await sample(eventId, subject, body, "preview@example.com");
  const dataUri = `data:image/png;base64,${m.png.toString("base64")}`;
  return { subject: m.subject, html: m.html.replace("cid:qr", dataUri), text: m.text };
}

export async function sendTestEmail(eventId: string, to: string, subject: unknown, body: unknown) {
  const m = await sample(eventId, subject, body, to);
  await deliver({ ...m, subject: `[TEST] ${m.subject}` });
}
