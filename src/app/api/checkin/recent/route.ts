// GET /api/checkin/recent?event_id — my last 20 check-ins (for /recent).
import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { recentCheckinsByStaff } from "@/lib/checkin";
import { optionalUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  const staff = await requireStaff(req);
  const eventId = optionalUuid(req.nextUrl.searchParams.get("event_id"), "event_id");
  return json({ checkins: await recentCheckinsByStaff(staff, eventId) });
});
