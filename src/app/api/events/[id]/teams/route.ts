// GET /api/events/:id/teams[?day_id=] — teams, their members (here today or not) and who is here. HR and admins.
import { json, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { teamBoard } from "@/lib/teams";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const staff = await requireStaff(req);
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const dayId = staff.role === "admin" ? optionalUuid(req.nextUrl.searchParams.get("day_id"), "day_id") : null;
  return json(await teamBoard(event.id, dayId));
});
