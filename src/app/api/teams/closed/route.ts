// POST /api/teams/closed { team_id, closed } — open or close a team (HR).
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { setTeamClosed } from "@/lib/teams";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  return json(await setTeamClosed(staff, requireUuid(body.team_id, "team_id"), body.closed === true));
});
