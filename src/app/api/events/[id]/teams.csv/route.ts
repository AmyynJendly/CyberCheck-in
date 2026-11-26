// GET /api/events/:id/teams.csv — admins only. Every team and its members, then who is here without a team.
import { NextResponse } from "next/server";
import { route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { csvLine } from "@/lib/csv";
import { audit } from "@/lib/audit";
import { tunisDate } from "@/lib/time";
import { teamStatus, teamsCsvRows } from "@/lib/teams";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const { settings, rows, teamless } = await teamsCsvRows(event.id);
  const lines = [csvLine(["Team", "Open to others", "Team status", "Members", "Here", "Member name", "Here today", "Club member", "Paid today", "Email", "Phone", "Added"])];
  for (const r of rows)
    lines.push(
      csvLine([
        r.team,
        r.closed ? "no (closed)" : "yes",
        teamStatus(r.count, settings),
        `${r.count}/${settings.team_max}`,
        r.here_count,
        r.reserved ? `${r.name} (not registered yet)` : r.name,
        r.here ? "yes" : "no",
        r.reserved ? "" : r.member ? "yes" : "no",
        r.paid ?? "",
        r.email ?? "",
        r.phone ?? "",
        r.source === "sheet" ? "team sheet" : "at the door",
      ]),
    );
  for (const p of teamless) lines.push(csvLine(["(no team)", "", "", "", "", p.name, "yes", p.member ? "yes" : "no", "", p.email ?? "", p.phone ?? "", ""]));
  await audit({ staffId: admin.id, action: "export", eventId: event.id, details: { format: "teams_csv", rows: rows.length + teamless.length } });
  return new NextResponse("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${event.slug}-teams-${tunisDate()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
