import { json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { updateStaff } from "@/lib/admin";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PATCH { name?, role?, is_active?, pin?, unlock? }
export const PATCH = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const id = requireUuid((await ctx.params).id, "staff id");
  return json(await updateStaff(admin, id, await readJson(req)));
});
