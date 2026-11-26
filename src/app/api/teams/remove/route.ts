// POST /api/teams/remove { member_id } — out of the team (a claimed reserved spot goes back to reserved).
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { removeFromTeam } from "@/lib/teams";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  return json(await removeFromTeam(staff, requireUuid(body.member_id, "member_id")));
});
