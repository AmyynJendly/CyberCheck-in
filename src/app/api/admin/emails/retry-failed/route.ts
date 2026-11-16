// POST /api/admin/emails/retry-failed  { event_id? }
// Puts failed emails back in the queue and sends the queue now (one at a time).
// Call again while `remaining > 0`.
import { query } from "@/lib/db";
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { drainEmailQueue } from "@/lib/email";
import { optionalUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = route(async (req) => {
  const admin = await requireStaff(req, "admin");
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const eventId = optionalUuid(body.event_id, "event_id");
  const requeued = await query(
    `update attendees set email_status = 'pending', email_attempts = 0, updated_at = now()
      where email_status = 'failed' and email is not null and ($1::uuid is null or event_id = $1)`,
    [eventId],
  );
  const r = await drainEmailQueue({ budgetMs: 40_000 });
  await audit({ staffId: admin.id, action: "retry_failed_emails", eventId, details: { requeued: requeued.rowCount, ...r } });
  return json({ requeued: requeued.rowCount, attempted: r.sent + r.failed + r.deferred, ...r });
});
