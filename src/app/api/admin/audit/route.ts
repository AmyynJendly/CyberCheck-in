// GET /api/admin/audit?event_id&action&limit&before_id
import { query } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { cleanText, optionalUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  await requireStaff(req, "admin");
  const sp = req.nextUrl.searchParams;
  const eventId = optionalUuid(sp.get("event_id"), "event_id");
  const action = cleanText(sp.get("action"), 40);
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 100, 1), 500);
  const beforeId = Number(sp.get("before_id")) || null;
  const r = await query(
    `select l.id, l.at, l.action, l.event_id, l.attendee_id, l.details,
            s.name as staff_name, a.full_name as attendee_name, e.name as event_name
       from audit_log l
       left join staff s on s.id = l.staff_id
       left join attendees a on a.id = l.attendee_id
       left join events e on e.id = l.event_id
      where ($1::uuid is null or l.event_id = $1)
        and ($2::text is null or l.action = $2)
        and ($3::bigint is null or l.id < $3)
      order by l.id desc
      limit $4`,
    [eventId, action, beforeId, limit],
  );
  return json({ entries: r.rows, next_before_id: r.rows.length === limit ? r.rows[r.rows.length - 1].id : null });
});
