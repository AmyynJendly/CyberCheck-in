// POST /api/teams/rename { team_id, name }
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { renameTeam } from "@/lib/teams";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  return json(await renameTeam(staff, requireUuid(body.team_id, "team_id"), body.name));
});
