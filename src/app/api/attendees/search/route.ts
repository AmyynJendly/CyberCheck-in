// GET /api/attendees/search?event_id&q[&day_id]
import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { searchAttendees } from "@/lib/attendees";
import { requireEvent, resolveEventDay } from "@/lib/events";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  const staff = await requireStaff(req);
  const sp = req.nextUrl.searchParams;
  const eventId = requireUuid(sp.get("event_id"), "event_id");
  await requireEvent(eventId);
  const day = await resolveEventDay(eventId, { staff, overrideDayId: optionalUuid(sp.get("day_id"), "day_id") });
  const results = await searchAttendees(eventId, sp.get("q") ?? "", day?.id ?? null);
  return json({ day_id: day?.id ?? null, results });
});
