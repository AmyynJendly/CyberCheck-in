// GET /api/admin/members?q — list/search the membership list. POST — add one member.
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { addMember, defaultValidUntil, memberCounts, searchMembers } from "@/lib/members";
import { tunisDate } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  await requireStaff(req, "admin");
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const [members, counts] = await Promise.all([searchMembers(q, 300), memberCounts(tunisDate())]);
  return json({ members, counts, default_valid_until: defaultValidUntil() });
});

export const POST = route(async (req) => {
  const admin = await requireStaff(req, "admin");
  return json(await addMember(admin, await readJson(req)), 201);
});
