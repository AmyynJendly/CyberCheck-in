// GET /api/events/:id/payments?day_id — cash collected, per staff member and as a list.
import { json, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { getPayments } from "@/lib/payments";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  await requireStaff(req);
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const dayId = optionalUuid(req.nextUrl.searchParams.get("day_id"), "day_id");
  return json(await getPayments(event.id, dayId));
});
