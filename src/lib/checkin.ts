// ---------------------------------------------------------------------------
// THE scan / check-in logic.
//
// Correctness: every check-in is an INSERT guarded by the partial unique index
// `one_checkin_per_day` (attendee_id, event_day_id) WHERE undone_at IS NULL.
// There is no "select, then insert": a unique violation means "already in".
// Capacity: enforced by a database trigger (migrations/004): a check-in INSERT
// takes a seat from event_days.seats_taken or fails with DAY_FULL.
// Paid days: members (and everyone on free days) go straight in; others get
// PAYMENT_REQUIRED, and payAndCheckIn() writes payment + check-in in ONE
// transaction.
//
// Speed: a scan is 1 lookup query (event, day, attendee, existing check-in,
// membership, paid entry — all at once) + 1 write statement (check-in + seat +
// audit + member link, atomic). Every round trip matters when the DB is remote.
//
// Kept in one module on purpose so an offline queue (v2) can reuse it.
// ---------------------------------------------------------------------------
import type { PoolClient } from "pg";
import { query, withTransaction, isUniqueViolation, type Queryable } from "./db";
import { audit, auditSafe } from "./audit";
import { HttpError } from "./http";
import { normalizeToken } from "./qr-format";
import { dayLabel, type DayRow } from "./events";
import { grantMembershipTx } from "./members";
import { tunisDate } from "./time";
import type { Staff } from "./auth";

export type CheckinMethod = "qr" | "manual" | "walk_in";
export type PaymentKind = "membership" | "entry";
/** What HR can choose on a "payment needed" screen: a payment, or "already a member, not on the list" (no money; admin reviews it). */
export type DoorChoice = PaymentKind | "claim";

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
      /** Admitted as "already a member" without paying; waiting for admin review. */
      claimed?: boolean;
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
  | { status: "FULL"; name: string; day_label: string; capacity: number; checked_in: number }
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

export type ContextDay = DayRow & { capacity: number | null; checked_in: number };

interface ScanContext {
  event: { id: string; name: string; is_active: boolean; membership_fee: number } | null;
  day: ContextDay | null;
  attendee: AttendeeLite | null;
  existing: { id: string; checked_at: string; by_staff_name: string } | null;
  member_id: string | null; // a membership valid on the day (linked, or matched by email/phone)
  paid_entry: boolean;
}

/** Everything a scan needs, in ONE query. */
async function loadContext(eventId: string, who: { token?: string; attendeeId?: string }, dayId: string | null, today: string): Promise<ScanContext> {
  const r = await query<ScanContext>(
    `with ev as (
       select id, name, is_active, membership_fee from events where id = $1
     ), day as (
       select d.id, d.event_id, d.day_date, d.label, d.access, d.entry_fee, d.capacity, d.seats_taken as checked_in
         from event_days d
        where d.event_id = $1 and (case when $2::uuid is not null then d.id = $2 else d.day_date = $3::date end)
     ), att as (
       select a.id, a.event_id, a.full_name, a.team_name, a.class_year, a.email, a.phone, a.member_id, e.name as event_name
         from attendees a join events e on e.id = a.event_id
        where ($4::text is not null and a.qr_token = $4) or ($5::uuid is not null and a.id = $5)
        limit 1
     )
     select
       (select row_to_json(ev) from ev) as event,
       (select row_to_json(day) from day) as day,
       (select row_to_json(att) from att) as attendee,
       (select row_to_json(x) from (
          select c.id, c.checked_at, s.name as by_staff_name
            from checkins c join staff s on s.id = c.staff_id, att, day
           where c.attendee_id = att.id and c.event_day_id = day.id and c.undone_at is null
        ) x) as existing,
       (select m.id from members m, att, day
         where m.valid_until >= day.day_date
           and (m.id = att.member_id
                or (att.email is not null and m.email = att.email)
                or (m.phone_key is not null and m.phone_key = right(regexp_replace(coalesce(att.phone, ''), '\\D', '', 'g'), 8)))
         order by (m.id = att.member_id) desc nulls last
         limit 1) as member_id,
       exists (select 1 from payments p, att, day
                where p.attendee_id = att.id and p.event_day_id = day.id and p.kind = 'entry' and p.voided_at is null) as paid_entry`,
    [eventId, dayId, today, who.token ?? null, who.attendeeId ?? null],
  );
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// Access rules
// ---------------------------------------------------------------------------

/** What a non-member can pay on this day. Empty on free days. */
export function paymentOptions(day: Pick<DayRow, "access" | "entry_fee">, membershipFee: number): PaymentOption[] {
  const join: PaymentOption = { kind: "membership", amount: Number(membershipFee), label: "Join the club" };
  if (day.access === "members") return [join];
  if (day.access === "members_or_fee") return [{ kind: "entry", amount: Number(day.entry_fee), label: "Entry only" }, join];
  return [];
}

// ---------------------------------------------------------------------------
// Writing check-ins
// ---------------------------------------------------------------------------

/** The DB trigger refused the check-in: no seat left that day. */
export function isDayFull(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "P0001" && e.message === "DAY_FULL";
}

/**
 * ONE statement: insert check-in (the trigger takes a seat) + audit entry
 * (+ link the attendee to their membership). Atomic on its own.
 * Throws a unique violation (one_checkin_per_day) when already in, and
 * DAY_FULL (see isDayFull) when no seat is left.
 */
export async function insertCheckin(
  client: Queryable | undefined,
  args: { attendeeId: string; eventId: string; day: DayRow; staff: Staff; method: CheckinMethod; linkMemberId?: string | null },
): Promise<{ id: string; checked_at: string }> {
  const action = args.method === "qr" ? "checkin" : args.method === "manual" ? "manual_checkin" : "walk_in";
  const r = await query<{ id: string | null; checked_at: string | null }>(
    `with ins as (
       insert into checkins (attendee_id, event_day_id, staff_id, method)
       values ($1, $2, $3, $4)
       returning id, checked_at
     ), aud as (
       insert into audit_log (staff_id, action, event_id, attendee_id, details)
       select $3, $5, $6, $1, jsonb_build_object('checkin_id', ins.id, 'event_day_id', $2::uuid, 'day', $7::text, 'method', $4::text)
         from ins
       returning 1
     ), lnk as (
       update attendees set member_id = $8, updated_at = now()
        where id = $1 and $8::uuid is not null and member_id is distinct from $8::uuid and exists (select 1 from ins)
       returning 1
     )
     select (select id from ins) as id, (select checked_at from ins) as checked_at`,
    [args.attendeeId, args.day.id, args.staff.id, args.method, action, args.eventId, args.day.day_date, args.linkMemberId ?? null],
    client,
  );
  const row = r.rows[0];
  return { id: row.id!, checked_at: row.checked_at! };
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

async function findActiveCheckin(attendeeId: string, dayId: string) {
  const r = await query<{ id: string; checked_at: string; by_staff_name: string }>(
    `select c.id, c.checked_at, s.name as by_staff_name
       from checkins c join staff s on s.id = c.staff_id
      where c.attendee_id = $1 and c.event_day_id = $2 and c.undone_at is null`,
    [attendeeId, dayId],
  );
  return r.rows[0] ?? null;
}

function alreadyResult(attendee: AttendeeLite, day: DayRow, existing: { id: string; checked_at: string; by_staff_name: string }): ScanResult {
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

function fullResult(attendee: AttendeeLite, day: ContextDay, checkedIn: number): ScanResult {
  return { status: "FULL", name: attendee.full_name, day_label: dayLabel(day), capacity: day.capacity ?? 0, checked_in: checkedIn };
}

async function reject(staff: Staff, eventId: string, reason: string, extra: Record<string, unknown> = {}, attendeeId?: string) {
  await auditSafe({ staffId: staff.id, action: "checkin_rejected", eventId, attendeeId, details: { reason, ...extra } });
}

/**
 * Write the check-in (and the payment / membership when paid). A concurrent
 * duplicate gets ALREADY_CHECKED_IN and nothing — no payment — is written.
 */
async function commit(
  ctx: { attendee: AttendeeLite; day: ContextDay; staff: Staff; method: CheckinMethod; memberId: string | null },
  paid: PaymentOption | null,
  claim = false,
): Promise<ScanResult> {
  const { attendee, day, staff, method } = ctx;
  const ok = (row: { id: string; checked_at: string }, isMember: boolean): ScanResult => ({
    status: "OK",
    checkin_id: row.id,
    attendee_id: attendee.id,
    name: attendee.full_name,
    team_name: attendee.team_name,
    class_year: attendee.class_year,
    day_label: dayLabel(day),
    checked_at: row.checked_at,
    is_member: isMember,
    payment: paid ? { kind: paid.kind, amount: paid.amount } : null,
    ...(claim ? { claimed: true } : {}),
  });

  try {
    if (!paid && !claim) {
      // Fast path: one atomic statement, no explicit transaction.
      const row = await insertCheckin(undefined, { attendeeId: attendee.id, eventId: attendee.event_id, day, staff, method, linkMemberId: ctx.memberId });
      return ok(row, !!ctx.memberId);
    }
    const result = await withTransaction(async (c) => {
      // Check-in row FIRST: a concurrent duplicate (or a full day) fails here
      // before it can touch members or payments.
      const row = await insertCheckin(c, { attendeeId: attendee.id, eventId: attendee.event_id, day, staff, method, linkMemberId: ctx.memberId });
      let isMember = !!ctx.memberId;
      if (claim) {
        const memberId = await grantMembershipTx(c, { fullName: attendee.full_name, email: attendee.email, phone: attendee.phone, staff, source: "claimed" });
        await c.query("update attendees set member_id = $2, updated_at = now() where id = $1", [attendee.id, memberId]);
        await audit({ staffId: staff.id, action: "claim_member", eventId: attendee.event_id, attendeeId: attendee.id, details: { member_id: memberId, event_day_id: day.id } }, c);
        isMember = true;
      }
      if (paid) {
        let memberId: string | null = null;
        if (paid.kind === "membership") {
          memberId = await grantMembershipTx(c, { fullName: attendee.full_name, email: attendee.email, phone: attendee.phone, staff });
          await c.query("update attendees set member_id = $2, updated_at = now() where id = $1", [attendee.id, memberId]);
          isMember = true;
        }
        await insertPaymentTx(c, { eventId: attendee.event_id, day, attendeeId: attendee.id, staff, option: paid, memberId });
      }
      return ok(row, isMember);
    });
    return result;
  } catch (err) {
    if (isDayFull(err)) {
      await reject(staff, attendee.event_id, "FULL", { event_day_id: day.id, capacity: day.capacity }, attendee.id);
      return fullResult(attendee, day, day.capacity ?? 0);
    }
    if (!isUniqueViolation(err, "one_checkin_per_day")) throw err;
  }
  const existing = await findActiveCheckin(attendee.id, day.id);
  if (!existing) throw new Error("check-in conflicted but no active check-in was found; try again");
  await reject(staff, attendee.event_id, "ALREADY_CHECKED_IN", { method, event_day_id: day.id, existing_checkin_id: existing.id }, attendee.id);
  return alreadyResult(attendee, day, existing);
}

export interface CheckinOptions {
  staff: Staff;
  eventId: string;
  overrideDayId?: string | null; // admin only
  now?: Date; // for tests
}

/** The shared path for scan, manual check-in and pay-then-check-in. */
async function admit(
  opts: CheckinOptions,
  who: { token?: string; attendeeId?: string },
  method: CheckinMethod,
  pay: DoorChoice | null,
): Promise<ScanResult> {
  const override = opts.overrideDayId && opts.staff.role === "admin" ? opts.overrideDayId : null;
  const ctx = await loadContext(opts.eventId, who, override, tunisDate(opts.now));
  if (!ctx.event) throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
  if (!ctx.event.is_active) throw new HttpError(409, "EVENT_INACTIVE", "This event is not active.");

  const attendee = ctx.attendee;
  if (!attendee) {
    if (who.attendeeId) throw new HttpError(404, "ATTENDEE_NOT_FOUND", "Attendee not found.");
    await reject(opts.staff, opts.eventId, "INVALID", { why: "unknown_token" });
    return { status: "INVALID" };
  }
  if (attendee.event_id !== opts.eventId) {
    await reject(opts.staff, opts.eventId, "WRONG_EVENT", { other_event_id: attendee.event_id }, attendee.id);
    return { status: "WRONG_EVENT", name: attendee.full_name, other_event_name: attendee.event_name };
  }
  const day = ctx.day;
  if (!day) {
    if (override) throw new HttpError(400, "BAD_DAY", "That day does not belong to this event.");
    await reject(opts.staff, opts.eventId, "NO_EVENT_DAY", {}, attendee.id);
    return { status: "NO_EVENT_DAY" };
  }
  if (ctx.existing) {
    await reject(opts.staff, opts.eventId, "ALREADY_CHECKED_IN", { method, event_day_id: day.id, existing_checkin_id: ctx.existing.id }, attendee.id);
    return alreadyResult(attendee, day, ctx.existing);
  }
  // Full? Say so before asking anyone for money. (Re-checked under a lock when writing.)
  if (day.capacity && day.checked_in >= day.capacity) {
    await reject(opts.staff, opts.eventId, "FULL", { event_day_id: day.id, capacity: day.capacity }, attendee.id);
    return fullResult(attendee, day, day.checked_in);
  }

  const freeAccess = day.access === "free" || !!ctx.member_id || (day.access === "members_or_fee" && ctx.paid_entry);
  const base = { attendee, day, staff: opts.staff, method, memberId: ctx.member_id };
  if (freeAccess) return commit(base, null);

  const options = paymentOptions(day, ctx.event.membership_fee);
  if (!pay) {
    await reject(opts.staff, opts.eventId, "PAYMENT_REQUIRED", { event_day_id: day.id, access: day.access }, attendee.id);
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
  if (pay === "claim") return commit(base, null, true);
  const option = options.find((o) => o.kind === pay);
  if (!option) throw new HttpError(400, "PAYMENT_NOT_ALLOWED", "That payment isn't offered on this day.");
  return commit(base, option);
}

/** Scanner: QR token → result. */
export async function checkInByToken(opts: CheckinOptions & { token: unknown }): Promise<ScanResult> {
  const token = normalizeToken(opts.token);
  if (!token) {
    await reject(opts.staff, opts.eventId, "INVALID", { why: "malformed" });
    return { status: "INVALID" };
  }
  return admit(opts, { token }, "qr", null);
}

/** Search → "Check in" button. */
export async function checkInAttendee(opts: CheckinOptions & { attendeeId: string }): Promise<ScanResult> {
  return admit(opts, { attendeeId: opts.attendeeId }, "manual", null);
}

/** After PAYMENT_REQUIRED: the staff member took the cash. Records payment + check-in atomically. */
export async function payAndCheckIn(
  opts: CheckinOptions & { attendeeId: string; kind: DoorChoice; method: "qr" | "manual" },
): Promise<ScanResult> {
  return admit(opts, { attendeeId: opts.attendeeId }, opts.method, opts.kind);
}

// ---------------------------------------------------------------------------
// Undo / recent
// ---------------------------------------------------------------------------

export const UNDO_WINDOW_MINUTES = 10;

/** HR: own check-ins within 10 minutes. Admin: any check-in. (Payments are cancelled separately by an admin.) */
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
