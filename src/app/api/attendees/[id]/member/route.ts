// POST /api/attendees/:id/member  { member_id } — "this person is that member".
import { json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { linkAttendeeToMember } from "@/lib/members";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const staff = await requireStaff(req);
  const attendeeId = requireUuid((await ctx.params).id, "attendee id");
  const body = await readJson(req);
  return json(await linkAttendeeToMember(staff, attendeeId, requireUuid(body.member_id, "member_id")));
});
