// POST /api/checkin/undo  { checkin_id }
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { undoCheckin } from "@/lib/checkin";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  return json(await undoCheckin({ staff, checkinId: requireUuid(body.checkin_id, "checkin_id") }));
});
