// Admin dashboard data: per-day numbers and the full people list.
import { query } from "./db";
import { dayLabel, getEventDays, type DayRow } from "./events";
import { tunisDate } from "./time";

export interface DayOverview {
  id: string;
  label: string;
  day_date: string;
  access: DayRow["access"];
  entry_fee: number;
  capacity: number | null;
  checked_in: number;
  walk_ins: number;
  members_in: number;
  payments: number;
  cash: number;
}

export async function getOverview(eventId: string) {
  const [days, perDay, totals, cash] = await Promise.all([
    getEventDays(eventId),
    query<{ event_day_id: string; checked_in: number; walk_ins: number; members_in: number }>(
      `select c.event_day_id, count(*)::int as checked_in,
              count(*) filter (where c.method = 'walk_in')::int as walk_ins,
              count(*) filter (where a.member_id is not null)::int as members_in
         from checkins c join event_days d on d.id = c.event_day_id join attendees a on a.id = c.attendee_id
        where d.event_id = $1 and c.undone_at is null
        group by c.event_day_id`,
      [eventId],
    ),
    query<{ registered: number; walk_ins: number; sent: number; pending: number; failed: number; none: number }>(
      `select count(*)::int as registered,
              count(*) filter (where source = 'walk_in')::int as walk_ins,
              count(*) filter (where email_status = 'sent')::int as sent,
              count(*) filter (where email_status = 'pending')::int as pending,
              count(*) filter (where email_status = 'failed')::int as failed,
              count(*) filter (where email_status = 'none')::int as none
         from attendees where event_id = $1`,
      [eventId],
    ),
    query<{ event_day_id: string; payments: number; cash: number }>(
      `select event_day_id, count(*)::int as payments, coalesce(sum(amount), 0) as cash
         from payments where event_id = $1 and voided_at is null group by event_day_id`,
      [eventId],
    ),
  ]);
  const by = new Map(perDay.rows.map((r) => [r.event_day_id, r]));
  const cashBy = new Map(cash.rows.map((r) => [r.event_day_id, r]));
  const today = tunisDate();
  const t = totals.rows[0];
  const dayRows: DayOverview[] = days.map((d) => ({
    id: d.id,
    label: dayLabel(d),
    day_date: d.day_date,
    access: d.access,
    entry_fee: Number(d.entry_fee),
    capacity: d.capacity,
    checked_in: by.get(d.id)?.checked_in ?? 0,
    walk_ins: by.get(d.id)?.walk_ins ?? 0,
    members_in: by.get(d.id)?.members_in ?? 0,
    payments: cashBy.get(d.id)?.payments ?? 0,
    cash: Number(cashBy.get(d.id)?.cash ?? 0),
  }));
  return {
    today_date: today,
    today: dayRows.find((d) => d.day_date === today) ?? null,
    registered: t.registered,
    from_form: t.registered - t.walk_ins,
    walk_ins: t.walk_ins,
    emails: { sent: t.sent, pending: t.pending, failed: t.failed, none: t.none },
    cash_total: dayRows.reduce((s, d) => s + d.cash, 0),
    days: dayRows,
  };
}

export interface PersonRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  class_year: string | null;
  team_name: string | null;
  source: "form" | "walk_in";
  short_code: string;
  email_status: string;
  email_error: string | null;
  member_until: string | null;
  created_at: string;
  added_by: string | null;
  days: Record<string, { checked_at: string; by: string; method: string; paid?: { kind: string; amount: number; by: string } }>;
}

export async function getPeople(eventId: string): Promise<PersonRow[]> {
  const [people, checkins, payments] = await Promise.all([
    query<Omit<PersonRow, "days">>(
      `select a.id, a.full_name, a.email, a.phone, a.class_year, a.team_name, a.source, a.short_code,
              a.email_status, a.email_error, m.valid_until as member_until, a.created_at, s.name as added_by
         from attendees a
         left join members m on m.id = a.member_id and m.valid_until >= current_date
         left join staff s on s.id = a.added_by_staff_id
        where a.event_id = $1
        order by lower(a.full_name)`,
      [eventId],
    ),
    query<{ attendee_id: string; event_day_id: string; checked_at: string; by: string; method: string }>(
      `select c.attendee_id, c.event_day_id, c.checked_at, s.name as by, c.method
         from checkins c join event_days d on d.id = c.event_day_id join staff s on s.id = c.staff_id
        where d.event_id = $1 and c.undone_at is null`,
      [eventId],
    ),
    query<{ attendee_id: string; event_day_id: string; kind: string; amount: number; by: string }>(
      `select p.attendee_id, p.event_day_id, p.kind, p.amount, s.name as by
         from payments p join staff s on s.id = p.staff_id
        where p.event_id = $1 and p.voided_at is null`,
      [eventId],
    ),
  ]);
  const map = new Map<string, PersonRow>(people.rows.map((p) => [p.id, { ...p, days: {} }]));
  for (const c of checkins.rows) {
    const p = map.get(c.attendee_id);
    if (p) p.days[c.event_day_id] = { checked_at: c.checked_at, by: c.by, method: c.method };
  }
  for (const pay of payments.rows) {
    const p = map.get(pay.attendee_id);
    const d = p?.days[pay.event_day_id];
    if (d) d.paid = { kind: pay.kind, amount: Number(pay.amount), by: pay.by };
  }
  return [...map.values()];
}
