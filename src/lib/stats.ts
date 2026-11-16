import { query } from "./db";
import { dayLabel, getEventDays, type DayRow } from "./events";
import { tunisDate } from "./time";

export interface EventStats {
  registered: number;
  from_form: number;
  walk_ins: number;
  emails: { sent: number; failed: number; pending: number; none: number };
  today: { day_id: string; label: string; day_date: string; checked_in: number; capacity: number | null } | null;
  today_date: string;
  days: { day_id: string; label: string; day_date: string; checked_in: number; walk_ins: number; capacity: number | null }[];
  /** Cash the requesting staff member took today (for handing it over). */
  my_cash_today: number;
}

/** `dayId` overrides "today" (admins picking a day manually). */
export async function getEventStats(eventId: string, opts: { dayId?: string | null; now?: Date; staffId?: string } = {}): Promise<EventStats> {
  const [counts, perDay, days, myCash] = await Promise.all([
    query<{ registered: number; walk_ins: number; sent: number; failed: number; pending: number; none: number }>(
      `select count(*)::int as registered,
              count(*) filter (where source = 'walk_in')::int as walk_ins,
              count(*) filter (where email_status = 'sent')::int as sent,
              count(*) filter (where email_status = 'failed')::int as failed,
              count(*) filter (where email_status = 'pending')::int as pending,
              count(*) filter (where email_status = 'none')::int as none
         from attendees where event_id = $1`,
      [eventId],
    ),
    query<{ event_day_id: string; checked_in: number; walk_ins: number }>(
      `select c.event_day_id, count(*)::int as checked_in,
              count(*) filter (where c.method = 'walk_in')::int as walk_ins
         from checkins c join event_days d on d.id = c.event_day_id
        where d.event_id = $1 and c.undone_at is null
        group by c.event_day_id`,
      [eventId],
    ),
    getEventDays(eventId),
    query<{ total: number }>(
      `select coalesce(sum(p.amount), 0) as total from payments p join event_days d on d.id = p.event_day_id
        where p.event_id = $1 and p.staff_id = $2 and p.voided_at is null
          and (($3::uuid is not null and p.event_day_id = $3) or ($3::uuid is null and d.day_date = $4::date))`,
      [eventId, opts.staffId ?? null, opts.dayId ?? null, tunisDate(opts.now)],
    ),
  ]);
  const byDay = new Map(perDay.rows.map((r) => [r.event_day_id, r]));
  const todayDate = tunisDate(opts.now);
  const todayDay: DayRow | undefined = opts.dayId ? days.find((d) => d.id === opts.dayId) : days.find((d) => d.day_date === todayDate);
  const c = counts.rows[0];
  return {
    registered: c.registered,
    from_form: c.registered - c.walk_ins,
    walk_ins: c.walk_ins,
    emails: { sent: c.sent, failed: c.failed, pending: c.pending, none: c.none },
    today_date: todayDate,
    today: todayDay
      ? { day_id: todayDay.id, label: dayLabel(todayDay), day_date: todayDay.day_date, checked_in: byDay.get(todayDay.id)?.checked_in ?? 0, capacity: todayDay.capacity }
      : null,
    my_cash_today: Number(myCash.rows[0]?.total ?? 0),
    days: days.map((d) => ({
      day_id: d.id,
      label: dayLabel(d),
      day_date: d.day_date,
      checked_in: byDay.get(d.id)?.checked_in ?? 0,
      walk_ins: byDay.get(d.id)?.walk_ins ?? 0,
      capacity: d.capacity,
    })),
  };
}
