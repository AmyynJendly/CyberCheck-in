import { NextResponse } from "next/server";
import { route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { buildEventCsv } from "@/lib/csv";
import { audit } from "@/lib/audit";
import { tunisDate } from "@/lib/time";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const staff = await requireStaff(req);
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const { csv, rows } = await buildEventCsv(event.id);
  await audit({ staffId: staff.id, action: "export", eventId: event.id, details: { format: "csv", rows } });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${event.slug}-checkins-${tunisDate()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
