import { json, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { deleteMember } from "@/lib/members";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const DELETE = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  return json(await deleteMember(admin, requireUuid((await ctx.params).id, "member id")));
});
