// GET /api/events/:id/export.csv[?day_id=] — admins only. Without day_id: everyone, all days.
// With day_id: the people checked in that day (download it after each session).
import { NextResponse } from "next/server";
import { HttpError, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { buildDayCsv, buildEventCsv } from "@/lib/csv";
import { audit } from "@/lib/audit";
import { tunisDate } from "@/lib/time";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const dayId = optionalUuid(req.nextUrl.searchParams.get("day_id"), "day_id");
  let csv: string;
  let rows: number;
  let filename: string;
  if (dayId) {
    const r = await buildDayCsv(event.id, dayId);
    if (!r.day) throw new HttpError(404, "DAY_NOT_FOUND", "That day doesn't belong to this event.");
    ({ csv, rows } = r);
    filename = `${event.slug}-${r.day.day_date}-${r.day.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
  } else {
    ({ csv, rows } = await buildEventCsv(event.id));
    filename = `${event.slug}-all-${tunisDate()}.csv`;
  }
  await audit({ staffId: admin.id, action: "export", eventId: event.id, details: { format: "csv", rows, day_id: dayId } });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
