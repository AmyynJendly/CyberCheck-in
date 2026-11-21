// Cash taken at the desk: per-staff totals, list, and voiding mistakes.
import { query, withTransaction } from "./db";
import { audit } from "./audit";
import { HttpError } from "./http";
import { cleanText } from "./validate";
import type { Staff } from "./auth";

export interface PaymentListRow {
  id: string;
  created_at: string;
  kind: "membership" | "entry";
  amount: number;
  channel: "desk" | "stand";
  attendee_name: string;
  staff_id: string;
  staff_name: string;
  day_label: string | null;
  day_date: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

export async function getPayments(eventId: string, dayId: string | null) {
  const [list, totals] = await Promise.all([
    query<PaymentListRow>(
      `select p.id, p.created_at, p.kind, p.amount, p.channel, a.full_name as attendee_name, p.staff_id, s.name as staff_name,
              coalesce(nullif(d.label, ''), d.day_date::text) as day_label, d.day_date,
              p.voided_at, vs.name as voided_by, p.void_reason
         from payments p
         join attendees a on a.id = p.attendee_id
         join staff s on s.id = p.staff_id
         left join event_days d on d.id = p.event_day_id
         left join staff vs on vs.id = p.voided_by_staff_id
        where p.event_id = $1 and ($2::uuid is null or p.event_day_id = $2)
        order by p.created_at desc
        limit 500`,
      [eventId, dayId],
    ),
    query<{ staff_id: string; staff_name: string; memberships: number; entries: number; total: number }>(
      `select p.staff_id, s.name as staff_name,
              count(*) filter (where p.kind = 'membership')::int as memberships,
              count(*) filter (where p.kind = 'entry')::int as entries,
              coalesce(sum(p.amount), 0) as total
         from payments p join staff s on s.id = p.staff_id
        where p.event_id = $1 and ($2::uuid is null or p.event_day_id = $2) and p.voided_at is null and p.channel = 'desk'
        group by p.staff_id, s.name
        order by total desc, s.name`,
      [eventId, dayId],
    ),
  ]);
  const stand = await query<{ memberships: number; entries: number; total: number }>(
    `select count(*) filter (where kind = 'membership')::int as memberships,
            count(*) filter (where kind = 'entry')::int as entries,
            coalesce(sum(amount), 0) as total
       from payments where event_id = $1 and channel = 'stand' and voided_at is null`,
    [eventId],
  );
  // Door cash only: money HR members hold. Stand payments were collected before the event.
  const total = totals.rows.reduce((sum, r) => sum + Number(r.total), 0);
  return { payments: list.rows, by_staff: totals.rows, total, stand: stand.rows[0] };
}

/**
 * Admin: cancel a payment entered by mistake. A membership created at the desk
 * by that payment is removed too (an imported membership is never touched).
 * The check-in itself is left alone — undo it separately if needed.
 */
export async function voidPayment(admin: Staff, paymentId: string, reasonRaw: unknown) {
  const reason = cleanText(reasonRaw, 200);
  return withTransaction(async (c) => {
    const r = await c.query<{ id: string; event_id: string; attendee_id: string; kind: string; amount: number; member_id: string | null }>(
      `update payments set voided_at = now(), voided_by_staff_id = $2, void_reason = $3
        where id = $1 and voided_at is null
        returning id, event_id, attendee_id, kind, amount, member_id`,
      [paymentId, admin.id, reason],
    );
    const p = r.rows[0];
    if (!p) {
      const exists = await c.query("select 1 from payments where id = $1", [paymentId]);
      throw exists.rowCount
        ? new HttpError(409, "ALREADY_VOIDED", "This payment was already cancelled.")
        : new HttpError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
    }
    let membershipRemoved = false;
    if (p.kind === "membership" && p.member_id) {
      const other = await c.query(
        "select 1 from payments where member_id = $1 and kind = 'membership' and voided_at is null",
        [p.member_id],
      );
      if (!other.rowCount) {
        const d = await c.query("delete from members where id = $1 and source = 'desk'", [p.member_id]);
        // Or: an existing (expired) membership renewed with this payment → back to how it was.
        const back = d.rowCount
          ? d
          : await c.query(
              `update members m
                  set valid_until = m.prev_valid_until, needs_review = m.prev_needs_review,
                      prev_valid_until = null, prev_needs_review = null, extended_at = null, updated_at = now()
                 from payments pay
                where m.id = $1 and pay.id = $2 and m.extended_at = pay.created_at and m.prev_valid_until is not null`,
              [p.member_id, p.id],
            );
        membershipRemoved = !!back.rowCount;
      }
    }
    await audit(
      {
        staffId: admin.id,
        action: "void_payment",
        eventId: p.event_id,
        attendeeId: p.attendee_id,
        details: { payment_id: p.id, kind: p.kind, amount: p.amount, reason, membership_removed: membershipRemoved },
      },
      c,
    );
    return { ok: true, membership_removed: membershipRemoved };
  });
}

/**
 * Admin panel: record a payment for someone without checking them in — e.g.
 * selling the membership during the free first session, or the night before.
 *   membership → paid the membership fee now (becomes a member)
 *   entry      → paid the entry fee for a "members free, others pay" day
 *   member     → is a member (no money): added to the member list as verified
 */
export async function recordAdminPayment(admin: Staff, attendeeId: string, kind: "membership" | "entry" | "member", dayId: string | null) {
  const { getEventDays } = await import("./events");
  const { findValidMembership, grantMembershipTx } = await import("./members");
  const { tunisDate } = await import("./time");
  const a = await query<{ id: string; event_id: string; full_name: string; email: string | null; phone: string | null; member_id: string | null; membership_fee: number }>(
    `select a.id, a.event_id, a.full_name, a.email, a.phone, a.member_id, e.membership_fee
       from attendees a join events e on e.id = a.event_id where a.id = $1`,
    [attendeeId],
  );
  const att = a.rows[0];
  if (!att) throw new HttpError(404, "ATTENDEE_NOT_FOUND", "Attendee not found.");
  const days = await getEventDays(att.event_id);
  const today = tunisDate();

  if (kind === "membership" || kind === "member") {
    const valid = await findValidMembership({ memberId: att.member_id, email: att.email, phone: att.phone }, today);
    if (valid) throw new HttpError(409, "ALREADY_MEMBER", `${att.full_name} is already a member (until ${valid.valid_until}).`);
    return withTransaction(async (c) => {
      const memberId = await grantMembershipTx(c, { fullName: att.full_name, email: att.email, phone: att.phone, staff: admin, source: kind === "membership" ? "desk" : "stand" });
      if (kind === "member") await c.query("update members set source = 'manual' where id = $1 and source = 'stand'", [memberId]);
      await c.query("update attendees set member_id = $2, updated_at = now() where id = $1", [att.id, memberId]);
      if (kind === "membership") {
        const day = days.find((d) => d.day_date === today) ?? null;
        await c.query(
          `insert into payments (event_id, event_day_id, attendee_id, staff_id, kind, amount, member_id, channel)
           values ($1, $2, $3, $4, 'membership', $5, $6, 'desk')`,
          [att.event_id, day?.id ?? null, att.id, admin.id, att.membership_fee, memberId],
        );
      }
      await audit(
        { staffId: admin.id, action: kind === "membership" ? "payment" : "add_member", eventId: att.event_id, attendeeId: att.id, details: { kind, amount: kind === "membership" ? att.membership_fee : 0, member_id: memberId, via: "admin" } },
        c,
      );
      return { ok: true };
    });
  }

  const day = dayId ? days.find((d) => d.id === dayId) : days.find((d) => d.access === "members_or_fee");
  if (!day || day.access !== "members_or_fee") throw new HttpError(400, "NO_ENTRY_DAY", "Pick a day set to “Members free, others pay”.");
  try {
    return await withTransaction(async (c) => {
      await c.query(
        `insert into payments (event_id, event_day_id, attendee_id, staff_id, kind, amount, channel)
         values ($1, $2, $3, $4, 'entry', $5, 'desk')`,
        [att.event_id, day.id, att.id, admin.id, day.entry_fee],
      );
      await audit({ staffId: admin.id, action: "payment", eventId: att.event_id, attendeeId: att.id, details: { kind: "entry", amount: day.entry_fee, event_day_id: day.id, via: "admin" } }, c);
      return { ok: true };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new HttpError(409, "ALREADY_PAID", `${att.full_name} already paid the entry for that day.`);
    throw err;
  }
}
