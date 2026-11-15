import { json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { deleteDay, updateDay } from "@/lib/admin";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = RouteCtx<{ id: string; dayId: string }>;

export const PATCH = route<Ctx>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const p = await ctx.params;
  return json(await updateDay(admin, requireUuid(p.id, "event id"), requireUuid(p.dayId, "day id"), await readJson(req)));
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const p = await ctx.params;
  return json(await deleteDay(admin, requireUuid(p.id, "event id"), requireUuid(p.dayId, "day id")));
});
