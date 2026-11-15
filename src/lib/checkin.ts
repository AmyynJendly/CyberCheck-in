// ---------------------------------------------------------------------------
// THE scan / check-in logic. Every way of checking someone in goes through
// recordCheckin() or payAndCheckIn(), which rely on the partial unique index
// `one_checkin_per_day` (attendee_id, event_day_id) WHERE undone_at IS NULL.
// There is no "select, then insert": we insert, and a unique violation means
// "already checked in".
//
// Paid days (see migrations/002): before checking someone in we check the
// day's access rule. Members (and everyone on free days) go straight in;
// others get PAYMENT_REQUIRED, and payAndCheckIn() records the cash payment
// and the check-in in ONE transaction.
//
// Kept in one module on purpose so an offline queue (v2) can reuse it.
// ---------------------------------------------------------------------------
import type { PoolClient } from "pg";
import { query, withTransaction, isUniqueViolation } from "./db";
import { audit, auditSafe } from "./audit";
import { HttpError } from "./http";
import { normalizeToken } from "./qr-format";
import { dayLabel, requireEvent, resolveEventDay, type DayRow, type EventRow } from "./events";
import { findValidMembership, grantMembershipTx } from "./members";
import type { Staff } from "./auth";

export type CheckinMethod = "qr" | "manual" | "walk_in";
export type PaymentKind = "membership" | "entry";

export interface PaymentOption {
  kind: PaymentKind;
  amount: number;
  label: string;
}

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
      is_member: boolean;
      payment: { kind: PaymentKind; amount: number } | null;
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
  | {
      status: "PAYMENT_REQUIRED";
      attendee_id: string;
      name: string;
      team_name: string | null;
      class_year: string | null;
      day_label: string;
      options: PaymentOption[];
    }
  | { status: "WRONG_EVENT"; name: string; other_event_name: string }
  | { status: "INVALID" }
  | { status: "NO_EVENT_DAY" };

export interface AttendeeLite {
  id: string;
  event_id: string;
  full_name: string;
  team_name: string | null;
  class_year: string | null;
  email: string | null;
  phone: string | null;
  member_id: string | null;
  event_name: string;
}

const ATTENDEE_LITE_SQL = `
  select a.id, a.event_id, a.full_name, a.team_name, a.class_year, a.email, a.phone, a.member_id, e.name as event_name
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

// ---------------------------------------------------------------------------
// Access rules
// ---------------------------------------------------------------------------

/** What a non-member can pay on this day. Empty on free days. */
export function paymentOptions(day: Pick<DayRow, "access" | "entry_fee">, membershipFee: number): PaymentOption[] {
  const join: PaymentOption = { kind: "membership", amount: membershipFee, label: "Join the club" };
  if (day.access === "members") return [join];
  if (day.access === "members_or_fee") return [{ kind: "entry", amount: day.entry_fee, label: "Entry only" }, join];
  return [];
}

/**
 * Can this person come in for free today? Free day, a valid membership
 * (linked, or matched by email/phone; a match gets linked), or an entry fee
 * already paid for this day.
 */
export async function hasFreeAccess(
  who: { attendeeId?: string; memberId?: string | null; email?: string | null; phone?: string | null },
  day: DayRow,
): Promise<{ ok: boolean; memberId: string | null }> {
  const member = await findValidMembership(who, day.day_date);
  if (member) {
    if (who.attendeeId && who.memberId !== member.id) {
      await query("update attendees set member_id = $2, updated_at = now() where id = $1", [who.attendeeId, member.id]);
    }
    return { ok: true, memberId: member.id };
  }
  if (day.access === "free") return { ok: true, memberId: null };
  if (day.access === "members_or_fee" && who.attendeeId) {
    const paid = await query("select 1 from payments where attendee_id = $1 and event_day_id = $2 and kind = 'entry' and voided_at is null", [who.attendeeId, day.id]);
    if (paid.rowCount) return { ok: true, memberId: null };
  }
  return { ok: false, memberId: null };
}

// ---------------------------------------------------------------------------
// Writing check-ins
// ---------------------------------------------------------------------------

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

/** Insert a cash payment (and its audit entry) in the caller's transaction. */
export async function insertPaymentTx(
  c: PoolClient,
  p: { eventId: string; day: DayRow; attendeeId: string; staff: Staff; option: PaymentOption; memberId: string | null },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into payments (event_id, event_day_id, attendee_id, staff_id, kind, amount, member_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [p.eventId, p.day.id, p.attendeeId, p.staff.id, p.option.kind, p.option.amount, p.memberId],
  );
  await audit(
    {
      staffId: p.staff.id,
      action: "payment",
      eventId: p.eventId,
      attendeeId: p.attendeeId,
      details: { payment_id: r.rows[0].id, kind: p.option.kind, amount: p.option.amount, event_day_id: p.day.id },
    },
    c,
  );
  return r.rows[0].id;
}

async function alreadyResult(attendee: AttendeeLite, day: DayRow, staff: Staff, method: CheckinMethod) {
  const existing = await findActiveCheckin(attendee.id, day.id);
  if (!existing) return null;
  await auditSafe({
    staffId: staff.id,
    action: "checkin_rejected",
    eventId: attendee.event_id,
    attendeeId: attendee.id,
    details: { reason: "ALREADY_CHECKED_IN", method, event_day_id: day.id, existing_checkin_id: existing.id },
  });
  return {
    status: "ALREADY_CHECKED_IN" as const,
    checkin_id: existing.id,
    attendee_id: attendee.id,
    name: attendee.full_name,
    checked_at: existing.checked_at,
    by_staff_name: existing.by_staff_name,
    day_label: dayLabel(day),
  };
}

/**
 * Atomically check someone in, optionally recording a payment (and granting
 * membership) in the same transaction. A concurrent duplicate gets
 * ALREADY_CHECKED_IN and nothing — no payment — is written for it.
 */
async function commitCheckin(
  attendee: AttendeeLite,
  day: DayRow,
  staff: Staff,
  method: CheckinMethod,
  paid: PaymentOption | null,
  isMember: boolean,
): Promise<ScanResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await withTransaction(async (c) => {
        // Check-in row FIRST: a concurrent duplicate blocks here and then fails on
        // one_checkin_per_day, before it can touch members or payments.
        const ci = await insertCheckinTx(c, { attendeeId: attendee.id, eventId: attendee.event_id, day, staff, method });
        let memberNow = isMember;
        if (paid) {
          let memberId: string | null = null;
          if (paid.kind === "membership") {
            memberId = await grantMembershipTx(c, { fullName: attendee.full_name, email: attendee.email, phone: attendee.phone, staff });
            await c.query("update attendees set member_id = $2, updated_at = now() where id = $1", [attendee.id, memberId]);
            memberNow = true;
          }
          await insertPaymentTx(c, { eventId: attendee.event_id, day, attendeeId: attendee.id, staff, option: paid, memberId });
        }
        return { ...ci, memberNow };
      });
      return {
        status: "OK",
        checkin_id: row.id,
        attendee_id: attendee.id,
        name: attendee.full_name,
        team_name: attendee.team_name,
        class_year: attendee.class_year,
        day_label: dayLabel(day),
        checked_at: row.checked_at,
        is_member: row.memberNow,
        payment: paid ? { kind: paid.kind, amount: paid.amount } : null,
      };
    } catch (err) {
      if (!isUniqueViolation(err, "one_checkin_per_day")) throw err;
    }
    const already = await alreadyResult(attendee, day, staff, method);
    if (already) return already;
  }
  throw new Error("check-in kept conflicting; giving up");
}

async function reject(staff: Staff, eventId: string, reason: string, extra: Record<string, unknown> = {}, attendeeId?: string) {
  await auditSafe({ staffId: staff.id, action: "checkin_rejected", eventId, attendeeId, details: { reason, ...extra } });
}

/** The shared path once we know who it is and for which event. */
async function admit(
  ev: EventRow,
  attendee: AttendeeLite,
  opts: CheckinOptions,
  method: CheckinMethod,
  pay: PaymentKind | null,
): Promise<ScanResult> {
  if (attendee.event_id !== ev.id) {
    await reject(opts.staff, ev.id, "WRONG_EVENT", { other_event_id: attendee.event_id }, attendee.id);
    return { status: "WRONG_EVENT", name: attendee.full_name, other_event_name: attendee.event_name };
  }
  const day = await resolveEventDay(ev.id, opts);
  if (!day) {
    await reject(opts.staff, ev.id, "NO_EVENT_DAY", {}, attendee.id);
    return { status: "NO_EVENT_DAY" };
  }
  const already = await alreadyResult(attendee, day, opts.staff, method);
  if (already) return already;

  const access = await hasFreeAccess(
    { attendeeId: attendee.id, memberId: attendee.member_id, email: attendee.email, phone: attendee.phone },
    day,
  );
  if (access.ok) return commitCheckin(attendee, day, opts.staff, method, null, !!access.memberId);

  const options = paymentOptions(day, ev.membership_fee);
  if (!pay) {
    await reject(opts.staff, ev.id, "PAYMENT_REQUIRED", { event_day_id: day.id, access: day.access }, attendee.id);
    return {
      status: "PAYMENT_REQUIRED",
      attendee_id: attendee.id,
      name: attendee.full_name,
      team_name: attendee.team_name,
      class_year: attendee.class_year,
      day_label: dayLabel(day),
      options,
    };
  }
  const option = options.find((o) => o.kind === pay);
  if (!option) throw new HttpError(400, "PAYMENT_NOT_ALLOWED", "That payment isn't offered on this day.");
  return commitCheckin(attendee, day, opts.staff, method, option, false);
}

export interface CheckinOptions {
  staff: Staff;
  eventId: string;
  overrideDayId?: string | null; // admin only
  now?: Date; // for tests
}

/** Scanner: QR token → result. */
export async function checkInByToken(opts: CheckinOptions & { token: unknown }): Promise<ScanResult> {
  const ev = await requireEvent(opts.eventId, { active: true });
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
  return admit(ev, attendee, opts, "qr", null);
}

/** Search → "Check in" button. */
export async function checkInAttendee(opts: CheckinOptions & { attendeeId: string }): Promise<ScanResult> {
  const ev = await requireEvent(opts.eventId, { active: true });
  const attendee = await loadAttendee(opts.attendeeId);
  return admit(ev, attendee, opts, "manual", null);
}

/** After PAYMENT_REQUIRED: the staff member took the cash. Records payment + check-in atomically. */
export async function payAndCheckIn(
  opts: CheckinOptions & { attendeeId: string; kind: PaymentKind; method: "qr" | "manual" },
): Promise<ScanResult> {
  const ev = await requireEvent(opts.eventId, { active: true });
  const attendee = await loadAttendee(opts.attendeeId);
  return admit(ev, attendee, opts, opts.method, opts.kind);
}

async function loadAttendee(id: string): Promise<AttendeeLite> {
  const r = await query<AttendeeLite>(`${ATTENDEE_LITE_SQL} where a.id = $1`, [id]);
  if (!r.rows[0]) throw new HttpError(404, "ATTENDEE_NOT_FOUND", "Attendee not found.");
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// Undo / recent
// ---------------------------------------------------------------------------

export const UNDO_WINDOW_MINUTES = 10;

/** HR: own check-ins within 10 minutes. Admin: any check-in. (Payments are voided separately by an admin.) */
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
    paid_kind: PaymentKind | null;
    paid_amount: number | null;
  }>(
    `select c.id, c.checked_at, c.method, c.undone_at, a.id as attendee_id, a.full_name as name, a.team_name,
            coalesce(nullif(d.label, ''), d.day_date::text) as day_label,
            (c.undone_at is null and ($3::boolean or c.checked_at > now() - make_interval(mins => $4))) as can_undo,
            p.kind as paid_kind, p.amount as paid_amount
       from checkins c
       join attendees a on a.id = c.attendee_id
       join event_days d on d.id = c.event_day_id
       left join lateral (
         select kind, amount from payments p
          where p.attendee_id = c.attendee_id and p.event_day_id = c.event_day_id and p.staff_id = c.staff_id and p.voided_at is null
          order by p.created_at desc limit 1
       ) p on true
      where c.staff_id = $1 and ($2::uuid is null or a.event_id = $2)
      order by c.checked_at desc
      limit $5`,
    [staff.id, eventId, staff.role === "admin", UNDO_WINDOW_MINUTES, limit],
  );
  return r.rows;
}
