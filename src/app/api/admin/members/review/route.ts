// GET /api/admin/members/review — "already a member" claims made at the door, waiting for an admin.
import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { membersToReview } from "@/lib/members";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  await requireStaff(req, "admin");
  return json({ members: await membersToReview() });
});
