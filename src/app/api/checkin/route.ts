// POST /api/checkin  { event_id, token, event_day_id? }  → always 200 with { status }
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { withTeam } from "@/lib/teams";
import { checkInByToken } from "@/lib/checkin";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  const eventId = requireUuid(body.event_id, "event_id");
  const result = await checkInByToken({
    staff,
    eventId,
    token: body.token,
    overrideDayId: optionalUuid(body.event_day_id, "event_day_id"),
  });
  return json(await withTeam(eventId, result));
});
