// POST /api/admin/events/:id/import  { text, dry_run? }
// Paste registrations (name, email, phone) from a spreadsheet — e.g. the Google
// Form's response sheet. Each person gets their QR email through the queue.
// Re-importing the same list doesn't duplicate anyone or resend emails.
import { HttpError, json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { requireEvent } from "@/lib/events";
import { cleanAttendeeFields, ingestFormSubmission } from "@/lib/attendees";
import { parseMemberList, phoneKey } from "@/lib/members";
import { audit } from "@/lib/audit";
import { drainAfterResponse } from "@/lib/email";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const event = await requireEvent(requireUuid((await ctx.params).id, "event id"));
  const body = await readJson(req);
  if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "BAD_REQUEST", "Paste the registrations first.");
  if (body.text.length > 2_000_000) throw new HttpError(400, "TOO_LARGE", "That list is too large.");
  const { rows, skipped } = parseMemberList(body.text);
  if (body.dry_run === true) return json({ preview: rows.slice(0, 8), count: rows.length, skipped });
  if (!rows.length) throw new HttpError(400, "NOTHING_TO_IMPORT", "No rows with a name were found.");
  if (rows.length > 3000) throw new HttpError(400, "TOO_MANY", "Import at most 3000 people at a time.");

  const counts = { created: 0, updated: 0, unchanged: 0, emails_queued: 0 };
  for (const r of rows) {
    const key = r.email ?? (phoneKey(r.phone) ? `tel:${phoneKey(r.phone)}` : `name:${r.full_name.toLowerCase()}`);
    const res = await ingestFormSubmission(event.id, `import:${key}`, cleanAttendeeFields({ full_name: r.full_name, email: r.email, phone: r.phone }));
    if (res.outcome === "created") counts.created++;
    else if (res.outcome === "updated") counts.updated++;
    else counts.unchanged++;
    if (res.sendEmail) counts.emails_queued++;
  }
  await audit({ staffId: admin.id, action: "import_attendees", eventId: event.id, details: { ...counts, skipped } });
  if (counts.emails_queued) await drainAfterResponse();
  return json({ ...counts, skipped });
});
