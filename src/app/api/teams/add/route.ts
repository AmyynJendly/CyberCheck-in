// POST /api/teams/add { event_id, attendee_id, team_id? | new_name? (+ closed?), force?, move?, reserved_id? }
// → { status: OK | ALREADY_IN_TEAM | IN_OTHER_TEAM | FULL | SIMILAR, ... }
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { addToTeam } from "@/lib/teams";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  return json(
    await addToTeam(staff, {
      eventId: requireUuid(body.event_id, "event_id"),
      attendeeId: requireUuid(body.attendee_id, "attendee_id"),
      teamId: optionalUuid(body.team_id, "team_id"),
      newName: body.new_name,
      closed: body.closed === true,
      force: body.force === true,
      move: body.move === true,
      reservedId: optionalUuid(body.reserved_id, "reserved_id"),
    }),
  );
});
