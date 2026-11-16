// GET /api/events/:id/report.xlsx — admins only. The final report: one sheet per
// day with everyone who attended, then a Statistics sheet.
import { NextResponse } from "next/server";
import { route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { buildReportWorkbook, getReportData } from "@/lib/report";
import { audit } from "@/lib/audit";
import { tunisDate } from "@/lib/time";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const data = await getReportData(event.id);
  const xlsx = await buildReportWorkbook(data);
  await audit({ staffId: admin.id, action: "export", eventId: event.id, details: { format: "xlsx", rows: data.totals.checkins } });
  return new NextResponse(new Uint8Array(xlsx), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${event.slug}-final-report-${tunisDate()}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
});
