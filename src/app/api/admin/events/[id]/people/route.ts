import { json, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { getEventDays, requireEvent } from "@/lib/events";
import { getPeople } from "@/lib/overview";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  await requireStaff(req, "admin");
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const [days, people] = await Promise.all([getEventDays(event.id), getPeople(event.id)]);
  return json({ days, people });
});
