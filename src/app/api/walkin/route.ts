// POST /api/walkin  { event_id, full_name, phone?, email?, class_year?, team_name?, payment?, event_day_id? }
import { HttpError, json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { cleanAttendeeFields, createWalkIn } from "@/lib/attendees";
import { runAfterResponse, sendAttendeeEmail } from "@/lib/email";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  const payment = body.payment ?? null;
  if (payment !== null && payment !== "membership" && payment !== "entry") throw new HttpError(400, "BAD_REQUEST", "payment must be membership or entry.");
  const result = await createWalkIn({
    payment,
    staff,
    eventId: requireUuid(body.event_id, "event_id"),
    fields: cleanAttendeeFields(body),
    overrideDayId: optionalUuid(body.event_day_id, "event_day_id"),
  });
  if (result.status === "OK" && result.email_queued) {
    await runAfterResponse(() => sendAttendeeEmail(result.attendee_id, { reason: "walk_in", staffId: staff.id }));
  }
  return json(result);
});
