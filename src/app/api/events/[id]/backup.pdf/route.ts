// GET /api/events/:id/backup.pdf — kept for SPEC compatibility. The backup list
// is a printable HTML page (print → "Save as PDF"), so redirect there.
import { NextResponse } from "next/server";
import { route, type RouteCtx } from "@/lib/http";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const id = requireUuid((await ctx.params).id, "event id");
  return NextResponse.redirect(new URL(`/api/events/${id}/backup`, req.url), 307);
});
