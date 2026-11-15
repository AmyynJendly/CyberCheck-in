import { json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { updateEvent } from "@/lib/admin";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PATCH { name?, slug?, location?, is_active?, regenerate_secret? }
export const PATCH = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const id = requireUuid((await ctx.params).id, "event id");
  return json(await updateEvent(admin, id, await readJson(req)));
});
