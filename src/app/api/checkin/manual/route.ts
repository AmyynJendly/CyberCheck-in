// POST /api/checkin/manual  { attendee_id, event_id, event_day_id? }
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { withTeam } from "@/lib/teams";
import { checkInAttendee } from "@/lib/checkin";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  const eventId = requireUuid(body.event_id, "event_id");
  const result = await checkInAttendee({
    staff,
    eventId,
    attendeeId: requireUuid(body.attendee_id, "attendee_id"),
    overrideDayId: optionalUuid(body.event_day_id, "event_day_id"),
  });
  return json(await withTeam(eventId, result));
});
