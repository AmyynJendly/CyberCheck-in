// GET /api/events/:id/backup — printable HTML backup list ("Save as PDF" from the browser).
import { NextResponse } from "next/server";
import { route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { buildBackupHtml } from "@/lib/backup";
import { audit } from "@/lib/audit";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const staff = await requireStaff(req);
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const { html, rows } = await buildBackupHtml(event);
  await audit({ staffId: staff.id, action: "backup_list", eventId: event.id, details: { rows } });
  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
});
