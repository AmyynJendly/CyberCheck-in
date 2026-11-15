// GET /api/members/search?q — staff look up the membership list (to link someone who says they're a member).
import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { searchMembers } from "@/lib/members";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  await requireStaff(req);
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (q.trim().length < 2) return json({ members: [] });
  return json({ members: await searchMembers(q, 20) });
});
