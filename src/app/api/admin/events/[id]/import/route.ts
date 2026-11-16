// POST /api/admin/events/:id/import  { text, mapping?, meanings?, dry_run? }
// Paste a sheet: the registration stand's sheet, or any list of registrations.
// dry_run → the columns found, a guess of which is which, the checkbox answers
// and how every row will be read. Without dry_run → import (idempotent):
// missing people are added and emailed their QR; people who already got it are
// not emailed again; "paid at the stand" is recorded (see src/lib/stand.ts).
import { HttpError, json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { analyzeSheet, importStandRows, interpretRows, type EnrollMeaning, type Mapping } from "@/lib/stand";
import { drainAfterResponse } from "@/lib/email";
import { getEventDays } from "@/lib/events";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const COLS = ["name", "email", "phone", "enrollment", "paid"] as const;
const MEANINGS: EnrollMeaning[] = ["sessions", "main", "both", "none"];

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const body = await readJson(req);
  if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "BAD_REQUEST", "Paste the sheet first.");
  if (body.text.length > 2_000_000) throw new HttpError(400, "TOO_LARGE", "That sheet is too large.");

  const analysis = analyzeSheet(body.text);
  const mapping: Mapping = { ...analysis.mapping };
  if (body.mapping && typeof body.mapping === "object") {
    for (const c of COLS) {
      const v = (body.mapping as Record<string, unknown>)[c];
      if (v === null || v === -1) delete mapping[c];
      else if (Number.isInteger(v) && (v as number) >= 0 && (v as number) < analysis.headers.length) mapping[c] = v as number;
    }
  }
  if (mapping.name === undefined) throw new HttpError(400, "NO_NAME_COLUMN", "Choose which column has the names.");
  const meanings: Record<string, EnrollMeaning> = {};
  for (const ev of analysis.enrollment_values) meanings[ev.value] = ev.meaning;
  if (body.meanings && typeof body.meanings === "object") {
    for (const [k, v] of Object.entries(body.meanings as Record<string, unknown>)) if (MEANINGS.includes(v as EnrollMeaning)) meanings[k] = v as EnrollMeaning;
  }

  const days = await getEventDays(event.id);
  const entryDay = days.find((d) => d.access === "members_or_fee");
  const rows = interpretRows(analysis, mapping, meanings, { membership: Number(event.membership_fee), entry: Number(entryDay?.entry_fee ?? 5) });
  if (!rows.length) throw new HttpError(400, "NOTHING_TO_IMPORT", "No rows with a name were found.");
  if (rows.length > 3000) throw new HttpError(400, "TOO_MANY", "Import at most 3000 people at a time.");

  if (body.dry_run === true) {
    // Recompute the answer list with the chosen enrollment column.
    const values = new Map<string, number>();
    if (mapping.enrollment !== undefined) {
      for (const r of analysis.rows) {
        for (const v of (r[mapping.enrollment] ?? "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) values.set(v, (values.get(v) ?? 0) + 1);
      }
    }
    return json({
      headers: analysis.headers,
      mapping,
      enrollment_values: [...values].map(([value, count]) => ({ value, count, meaning: meanings[value] ?? "none" })),
      count: rows.length,
      skipped: analysis.rows.length - rows.length,
      summary: {
        paid_membership: rows.filter((r) => r.paid === "membership").length,
        paid_entry: rows.filter((r) => r.paid === "entry").length,
        unclear: rows.filter((r) => r.unclear).length,
        not_paid: rows.filter((r) => !r.paid && !r.unclear).length,
      },
      has_entry_day: !!entryDay,
      preview: rows.slice(0, 12),
      unclear_rows: rows.filter((r) => r.unclear).slice(0, 50),
    });
  }

  if (rows.some((r) => r.paid === "entry") && !entryDay) {
    throw new HttpError(400, "NO_ENTRY_DAY", "Some people paid the entry fee, but no day of this event is set to “Members free, others pay”.");
  }
  const result = await importStandRows(admin, event, rows);
  if (result.emails_queued) await drainAfterResponse();
  return json({ ...result, skipped: analysis.rows.length - rows.length });
});
