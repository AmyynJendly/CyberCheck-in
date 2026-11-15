// POST /api/admin/emails/retry-failed  { event_id? }
// Re-sends `failed` emails (and `pending` ones stuck for 10+ minutes), one at a
// time, within a time budget. Call again while `remaining > 0`.
import { query } from "@/lib/db";
import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { sendAttendeeEmail } from "@/lib/email";
import { optionalUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const BUDGET_MS = 40_000;
const GAP_MS = 300; // gentle pacing for Gmail

const STUCK = `(email_status = 'failed' or (email_status = 'pending' and updated_at < now() - interval '10 minutes'))
               and email is not null and ($1::uuid is null or event_id = $1)`;

export const POST = route(async (req) => {
  const admin = await requireStaff(req, "admin");
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const eventId = optionalUuid(body.event_id, "event_id");
  const started = Date.now();

  const ids = await query<{ id: string }>(`select id from attendees where ${STUCK} order by created_at limit 200`, [eventId]);
  let sent = 0;
  let failed = 0;
  for (const { id } of ids.rows) {
    if (Date.now() - started > BUDGET_MS) break;
    const r = await sendAttendeeEmail(id, { reason: "retry", staffId: admin.id });
    if (r.ok) sent++;
    else failed++;
    await new Promise((res) => setTimeout(res, GAP_MS));
  }
  await audit({ staffId: admin.id, action: "retry_failed_emails", eventId, details: { attempted: sent + failed, sent, failed } });
  return json({ attempted: sent + failed, sent, failed, remaining: ids.rows.length - (sent + failed) });
});
