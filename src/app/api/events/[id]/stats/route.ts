import { json, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { getEventStats } from "@/lib/stats";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  await requireStaff(req);
  const id = requireUuid((await ctx.params).id, "event id");
  await requireEvent(id);
  const dayId = optionalUuid(req.nextUrl.searchParams.get("day_id"), "day_id");
  return json(await getEventStats(id, { dayId }));
});
