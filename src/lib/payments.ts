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
  attendee_name: string;
  staff_id: string;
  staff_name: string;
  day_label: string;
  day_date: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

export async function getPayments(eventId: string, dayId: string | null) {
  const [list, totals] = await Promise.all([
    query<PaymentListRow>(
      `select p.id, p.created_at, p.kind, p.amount, a.full_name as attendee_name, p.staff_id, s.name as staff_name,
              coalesce(nullif(d.label, ''), d.day_date::text) as day_label, d.day_date,
              p.voided_at, vs.name as voided_by, p.void_reason
         from payments p
         join attendees a on a.id = p.attendee_id
         join staff s on s.id = p.staff_id
         join event_days d on d.id = p.event_day_id
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
        where p.event_id = $1 and ($2::uuid is null or p.event_day_id = $2) and p.voided_at is null
        group by p.staff_id, s.name
        order by total desc, s.name`,
      [eventId, dayId],
    ),
  ]);
  const total = totals.rows.reduce((sum, r) => sum + Number(r.total), 0);
  return { payments: list.rows, by_staff: totals.rows, total };
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
        membershipRemoved = !!d.rowCount;
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
