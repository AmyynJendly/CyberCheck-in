// POST /api/teams/swap { event_id, attendee_a, attendee_b } — two people trade teams in one step.
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { swapMembers } from "@/lib/teams";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  return json(
    await swapMembers(staff, {
      eventId: requireUuid(body.event_id, "event_id"),
      attendeeA: requireUuid(body.attendee_a, "attendee_a"),
      attendeeB: requireUuid(body.attendee_b, "attendee_b"),
    }),
  );
});
