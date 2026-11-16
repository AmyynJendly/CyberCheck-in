// POST /api/admin/attendees/:id/payment  { kind: "membership" | "entry" | "member", day_id? }
// Admin panel: record a payment (or a verified membership) without a check-in.
import { HttpError, json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { recordAdminPayment } from "@/lib/payments";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const body = await readJson(req);
  if (body.kind !== "membership" && body.kind !== "entry" && body.kind !== "member") throw new HttpError(400, "BAD_REQUEST", "kind must be membership, entry or member.");
  return json(await recordAdminPayment(admin, requireUuid((await ctx.params).id, "attendee id"), body.kind, optionalUuid(body.day_id, "day_id")));
});
