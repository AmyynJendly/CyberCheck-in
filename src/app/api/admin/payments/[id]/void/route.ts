// POST /api/admin/payments/:id/void  { reason? }
import { json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { voidPayment } from "@/lib/payments";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const id = requireUuid((await ctx.params).id, "payment id");
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  return json(await voidPayment(admin, id, body.reason));
});
