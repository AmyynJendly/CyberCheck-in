// POST /api/form-submit — called by the Google Apps Script bound to an event's form.
import { query } from "@/lib/db";
import { HttpError, json, readJson, route } from "@/lib/http";
import { safeEqual } from "@/lib/ids";
import { auditSafe } from "@/lib/audit";
import { cleanAttendeeFields, ingestFormSubmission } from "@/lib/attendees";
import { runAfterResponse, sendAttendeeEmail } from "@/lib/email";
import { cleanText } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const DUMMY_SECRET = "x".repeat(32);

export const POST = route(async (req) => {
  const body = await readJson(req);
  const slug = cleanText(body.event_slug, 64)?.toLowerCase();
  if (!slug) throw new HttpError(400, "BAD_REQUEST", "event_slug is required.");
  const secret = req.headers.get("x-form-secret") ?? "";

  const r = await query<{ id: string; form_secret: string }>("select id, form_secret from events where slug = $1", [slug]);
  const event = r.rows[0];
  // Always do one constant-time compare, even for unknown slugs.
  const secretOk = safeEqual(secret, event?.form_secret ?? DUMMY_SECRET) && !!event;
  if (!secretOk) {
    await auditSafe({ action: "form_rejected", eventId: event?.id ?? null, details: { event_slug: slug, reason: event ? "bad_secret" : "unknown_event" } });
    throw new HttpError(401, "UNAUTHORIZED", "Wrong event or form secret.");
  }

  const responseId = cleanText(body.response_id, 200);
  if (!responseId) throw new HttpError(400, "BAD_REQUEST", "response_id is required.");
  const fields = cleanAttendeeFields(body);

  const result = await ingestFormSubmission(event.id, responseId, fields);
  if (result.sendEmail) {
    // Respond first; Vercel keeps the function alive for this (next/server `after`).
    await runAfterResponse(() => sendAttendeeEmail(result.attendeeId, { reason: "form" }));
  }
  return json({ ok: true, outcome: result.outcome, attendee_id: result.attendeeId, email_queued: result.sendEmail });
});
