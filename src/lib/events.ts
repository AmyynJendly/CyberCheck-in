import { query, type Queryable } from "./db";
import { HttpError } from "./http";
import { tunisDate } from "./time";
import type { Staff } from "./auth";

export interface EventRow {
  id: string;
  slug: string;
  name: string;
  location: string | null;
  is_active: boolean;
  created_at: string;
  membership_fee: number;
}

/** Who gets in for free on a day. See migrations/002_membership_payments.sql. */
export type DayAccess = "free" | "members" | "members_or_fee";
export const DAY_ACCESS: DayAccess[] = ["free", "members", "members_or_fee"];

export interface DayRow {
  id: string;
  event_id: string;
  day_date: string;
  label: string | null;
  access: DayAccess;
  entry_fee: number;
}

const DAY_COLS = "id, event_id, day_date, label, access, entry_fee";

export function dayLabel(day: Pick<DayRow, "label" | "day_date">): string {
  return day.label?.trim() || day.day_date;
}

export async function getEvent(id: string, client?: Queryable): Promise<EventRow | null> {
  const r = await query<EventRow>(
    "select id, slug, name, location, is_active, created_at, membership_fee from events where id = $1",
    [id],
    client,
  );
  return r.rows[0] ?? null;
}

export async function requireEvent(id: string, opts: { active?: boolean } = {}): Promise<EventRow> {
  const ev = await getEvent(id);
  if (!ev) throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
  if (opts.active && !ev.is_active) throw new HttpError(409, "EVENT_INACTIVE", "This event is not active.");
  return ev;
}

export async function getEventDays(eventId: string, client?: Queryable): Promise<DayRow[]> {
  const r = await query<DayRow>(
    `select ${DAY_COLS} from event_days where event_id = $1 order by day_date`,
    [eventId],
    client,
  );
  return r.rows;
}

/**
 * The event day a check-in counts for: today's date in Africa/Tunis.
 * Admins may pick a specific day (e.g. when today is not an event day);
 * the override is ignored for HR.
 */
export async function resolveEventDay(
  eventId: string,
  opts: { staff: Staff; overrideDayId?: string | null; now?: Date },
): Promise<DayRow | null> {
  if (opts.overrideDayId && opts.staff.role === "admin") {
    const r = await query<DayRow>(
      `select ${DAY_COLS} from event_days where id = $1 and event_id = $2`,
      [opts.overrideDayId, eventId],
    );
    if (!r.rows[0]) throw new HttpError(400, "BAD_DAY", "That day does not belong to this event.");
    return r.rows[0];
  }
  const r = await query<DayRow>(
    `select ${DAY_COLS} from event_days where event_id = $1 and day_date = $2`,
    [eventId, tunisDate(opts.now)],
  );
  return r.rows[0] ?? null;
}
