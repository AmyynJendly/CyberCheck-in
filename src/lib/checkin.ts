// ---------------------------------------------------------------------------
// THE scan / check-in logic. Every way of checking someone in goes through
// recordCheckin(), which relies on the partial unique index
// `one_checkin_per_day` (attendee_id, event_day_id) WHERE undone_at IS NULL.
// There is no "select, then insert": we insert, and a unique violation means
// "already checked in".
//
// Kept in one module on purpose so an offline queue (v2) can reuse it.
// ---------------------------------------------------------------------------
import type { PoolClient } from "pg";
import { query, withTransaction, isUniqueViolation } from "./db";
import { audit, auditSafe } from "./audit";
import { HttpError } from "./http";
import { normalizeToken } from "./qr-format";
import { dayLabel, requireEvent, resolveEventDay, type DayRow } from "./events";
import type { Staff } from "./auth";

export type CheckinMethod = "qr" | "manual" | "walk_in";

export type ScanResult =
  | {
      status: "OK";
      checkin_id: string;
      attendee_id: string;
      name: string;
      team_name: string | null;
      class_year: string | null;
      day_label: string;
      checked_at: string;
    }
  | {
      status: "ALREADY_CHECKED_IN";
      checkin_id: string;
      attendee_id: string;
      name: string;
      checked_at: string;
      by_staff_name: string;
      day_label: string;
    }
  | { status: "WRONG_EVENT"; name: string; other_event_name: string }
  | { status: "INVALID" }
  | { status: "NO_EVENT_DAY" };

interface AttendeeLite {
  id: string;
  event_id: string;
  full_name: string;
  team_name: string | null;
  class_year: string | null;
  event_name: string;
}

const ATTENDEE_LITE_SQL = `
  select a.id, a.event_id, a.full_name, a.team_name, a.class_year, e.name as event_name
  from attendees a join events e on e.id = a.event_id`;

async function findActiveCheckin(attendeeId: string, dayId: string) {
  const r = await query<{ id: string; checked_at: string; by_staff_name: string }>(
    `select c.id, c.checked_at, s.name as by_staff_name
       from checkins c join staff s on s.id = c.staff_id
      where c.attendee_id = $1 and c.event_day_id = $2 and c.undone_at is null`,
    [attendeeId, dayId],
  );
  return r.rows[0] ?? null;
}

/** Insert the check-in row (and its audit entry) in the caller's transaction. Throws on unique violation. */
export async function insertCheckinTx(
  client: PoolClient,
  args: { attendeeId: string; eventId: string; day: DayRow; staff: Staff; method: CheckinMethod },
): Promise<{ id: string; checked_at: string }> {
  const r = await client.query<{ id: string; checked_at: string }>(
    `insert into checkins (attendee_id, event_day_id, staff_id, method)
     values ($1, $2, $3, $4) returning id, checked_at`,
    [args.attendeeId, args.day.id, args.staff.id, args.method],
  );
  const row = r.rows[0];
  await audit(
    {
      staffId: args.staff.id,
      action: args.method === "qr" ? "checkin" : args.method === "manual" ? "manual_checkin" : "walk_in",
      eventId: args.eventId,
      attendeeId: args.attendeeId,
      details: { checkin_id: row.id, event_day_id: args.day.id, day: args.day.day_date, method: args.method },
    },
    client,
  );
  return row;
}

async function recordCheckin(attendee: AttendeeLite, day: DayRow, staff: Staff, method: CheckinMethod): Promise<ScanResult> {
  // A tiny retry loop covers the (rare) case where the existing check-in is
  // undone between our failed insert and the lookup.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await withTransaction((c) =>
        insertCheckinTx(c, { attendeeId: attendee.id, eventId: attendee.event_id, day, staff, method }),
      );
      return {
        status: "OK",
        checkin_id: row.id,
        attendee_id: attendee.id,
        name: attendee.full_name,
        team_name: attendee.team_name,
        class_year: attendee.class_year,
        day_label: dayLabel(day),
        checked_at: row.checked_at,
      };
    } catch (err) {
      if (!isUniqueViolation(err, "one_checkin_per_day")) throw err;
    }
    const existing = await findActiveCheckin(attendee.id, day.id);
    if (!existing) continue;
    await auditSafe({
      staffId: staff.id,
      action: "checkin_rejected",
      eventId: attendee.event_id,
      attendeeId: attendee.id,
      details: { reason: "ALREADY_CHECKED_IN", method, event_day_id: day.id, existing_checkin_id: existing.id },
    });
    return {
      status: "ALREADY_CHECKED_IN",
      checkin_id: existing.id,
      attendee_id: attendee.id,
      name: attendee.full_name,
      checked_at: existing.checked_at,
      by_staff_name: existing.by_staff_name,
      day_label: dayLabel(day),
    };
  }
  throw new Error("check-in kept conflicting; giving up");
}

async function reject(staff: Staff, eventId: string, reason: string, extra: Record<string, unknown> = {}, attendeeId?: string) {
  await auditSafe({ staffId: staff.id, action: "checkin_rejected", eventId, attendeeId, details: { reason, ...extra } });
}

export interface CheckinOptions {
  staff: Staff;
  eventId: string;
  overrideDayId?: string | null; // admin only
  now?: Date; // for tests
}

/** Scanner: QR token → result. */
export async function checkInByToken(opts: CheckinOptions & { token: unknown }): Promise<ScanResult> {
  await requireEvent(opts.eventId, { active: true });
  const token = normalizeToken(opts.token);
  if (!token) {
    await reject(opts.staff, opts.eventId, "INVALID", { why: "malformed" });
    return { status: "INVALID" };
  }
  const r = await query<AttendeeLite>(`${ATTENDEE_LITE_SQL} where a.qr_token = $1`, [token]);
  const attendee = r.rows[0];
  if (!attendee) {
    await reject(opts.staff, opts.eventId, "INVALID", { why: "unknown_token" });
    return { status: "INVALID" };
  }
  if (attendee.event_id !== opts.eventId) {
    await reject(opts.staff, opts.eventId, "WRONG_EVENT", { other_event_id: attendee.event_id }, attendee.id);
    return { status: "WRONG_EVENT", name: attendee.full_name, other_event_name: attendee.event_name };
  }
  const day = await resolveEventDay(opts.eventId, opts);
  if (!day) {
    await reject(opts.staff, opts.eventId, "NO_EVENT_DAY", {}, attendee.id);
    return { status: "NO_EVENT_DAY" };
  }
  return recordCheckin(attendee, day, opts.staff, "qr");
}

/** Search → "Check in" button. */
export async function checkInAttendee(opts: CheckinOptions & { attendeeId: string }): Promise<ScanResult> {
  await requireEvent(opts.eventId, { active: true });
  const r = await query<AttendeeLite>(`${ATTENDEE_LITE_SQL} where a.id = $1`, [opts.attendeeId]);
  const attendee = r.rows[0];
  if (!attendee) throw new HttpError(404, "ATTENDEE_NOT_FOUND", "Attendee not found.");
  if (attendee.event_id !== opts.eventId) {
    return { status: "WRONG_EVENT", name: attendee.full_name, other_event_name: attendee.event_name };
  }
  const day = await resolveEventDay(opts.eventId, opts);
  if (!day) return { status: "NO_EVENT_DAY" };
  return recordCheckin(attendee, day, opts.staff, "manual");
}

export const UNDO_WINDOW_MINUTES = 10;

/** HR: own check-ins within 10 minutes. Admin: any check-in. */
export async function undoCheckin(opts: { checkinId: string; staff: Staff }) {
  const isAdmin = opts.staff.role === "admin";
  return withTransaction(async (c) => {
    const r = await c.query<{ id: string; attendee_id: string; event_id: string; full_name: string; event_day_id: string; staff_id: string }>(
      `update checkins c
          set undone_at = now(), undone_by_staff_id = $2
         from attendees a
        where c.id = $1
          and a.id = c.attendee_id
          and c.undone_at is null
          and ($3::boolean or (c.staff_id = $2 and c.checked_at > now() - make_interval(mins => $4)))
       returning c.id, c.attendee_id, a.event_id, a.full_name, c.event_day_id, c.staff_id`,
      [opts.checkinId, opts.staff.id, isAdmin, UNDO_WINDOW_MINUTES],
    );
    const row = r.rows[0];
    if (!row) {
      const cur = await c.query<{ staff_id: string; undone_at: string | null }>(
        "select staff_id, undone_at from checkins where id = $1",
        [opts.checkinId],
      );
      const ci = cur.rows[0];
      if (!ci) throw new HttpError(404, "CHECKIN_NOT_FOUND", "Check-in not found.");
      if (ci.undone_at) throw new HttpError(409, "ALREADY_UNDONE", "This check-in was already undone.");
      if (ci.staff_id !== opts.staff.id) {
        throw new HttpError(403, "NOT_YOURS", "You can only undo your own check-ins. Ask an admin.");
      }
      throw new HttpError(403, "TOO_LATE", `Undo is only possible within ${UNDO_WINDOW_MINUTES} minutes. Ask an admin.`);
    }
    await audit(
      {
        staffId: opts.staff.id,
        action: "undo",
        eventId: row.event_id,
        attendeeId: row.attendee_id,
        details: { checkin_id: row.id, event_day_id: row.event_day_id, original_staff_id: row.staff_id },
      },
      c,
    );
    return { ok: true as const, checkin_id: row.id, attendee_id: row.attendee_id, name: row.full_name };
  });
}

export async function recentCheckinsByStaff(staff: Staff, eventId: string | null, limit = 20) {
  const r = await query<{
    id: string;
    checked_at: string;
    method: CheckinMethod;
    undone_at: string | null;
    attendee_id: string;
    name: string;
    team_name: string | null;
    day_label: string;
    can_undo: boolean;
  }>(
    `select c.id, c.checked_at, c.method, c.undone_at, a.id as attendee_id, a.full_name as name, a.team_name,
            coalesce(nullif(d.label, ''), d.day_date::text) as day_label,
            (c.undone_at is null and ($3::boolean or c.checked_at > now() - make_interval(mins => $4))) as can_undo
       from checkins c
       join attendees a on a.id = c.attendee_id
       join event_days d on d.id = c.event_day_id
      where c.staff_id = $1 and ($2::uuid is null or a.event_id = $2)
      order by c.checked_at desc
      limit $5`,
    [staff.id, eventId, staff.role === "admin", UNDO_WINDOW_MINUTES, limit],
  );
  return r.rows;
}
