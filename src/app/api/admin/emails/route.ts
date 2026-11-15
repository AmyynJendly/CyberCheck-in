// GET /api/admin/emails?event_id&status=failed|pending|all-problems
import { query } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { optionalUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  await requireStaff(req, "admin");
  const eventId = optionalUuid(req.nextUrl.searchParams.get("event_id"), "event_id");
  const r = await query(
    `select a.id, a.full_name, a.email, a.email_status, a.email_error, a.updated_at, a.created_at, e.name as event_name, a.event_id
       from attendees a join events e on e.id = a.event_id
      where a.email_status in ('failed', 'pending') and ($1::uuid is null or a.event_id = $1)
      order by a.email_status, a.created_at
      limit 500`,
    [eventId],
  );
  return json({ emails: r.rows });
});
