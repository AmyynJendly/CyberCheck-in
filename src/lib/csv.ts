import { query } from "./db";
import { dayLabel, getEventDays } from "./events";
import { tunisDateTime } from "./time";

/** RFC 4180 cell + spreadsheet formula-injection guard (keeps phone numbers like +216… intact). */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

export async function buildEventCsv(eventId: string): Promise<{ csv: string; rows: number }> {
  const days = await getEventDays(eventId);
  const attendees = await query<{
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    class_year: string | null;
    team_name: string | null;
    source: string;
    added_by: string | null;
    short_code: string;
    email_status: string;
    created_at: string;
  }>(
    `select a.id, a.full_name, a.email, a.phone, a.class_year, a.team_name, a.source,
            s.name as added_by, a.short_code, a.email_status, a.created_at
       from attendees a left join staff s on s.id = a.added_by_staff_id
      where a.event_id = $1
      order by lower(a.full_name), a.created_at`,
    [eventId],
  );
  const checkins = await query<{ attendee_id: string; event_day_id: string; checked_at: string; checked_by: string; method: string }>(
    `select c.attendee_id, c.event_day_id, c.checked_at, s.name as checked_by, c.method
       from checkins c
       join event_days d on d.id = c.event_day_id
       join staff s on s.id = c.staff_id
      where d.event_id = $1 and c.undone_at is null`,
    [eventId],
  );
  const map = new Map<string, (typeof checkins.rows)[number]>();
  for (const c of checkins.rows) map.set(`${c.attendee_id}|${c.event_day_id}`, c);

  const header = [
    "name",
    "email",
    "phone",
    "class_year",
    "team_name",
    "source",
    "added_by",
    "short_code",
    "email_status",
    "registered_at",
    ...days.flatMap((d) => {
      const l = dayLabel(d);
      return [`${l} (${d.day_date}) checked_at`, `${l} (${d.day_date}) checked_by`, `${l} (${d.day_date}) method`];
    }),
  ];
  const lines = [csvLine(header)];
  for (const a of attendees.rows) {
    lines.push(
      csvLine([
        a.full_name,
        a.email,
        a.phone,
        a.class_year,
        a.team_name,
        a.source,
        a.added_by,
        a.short_code,
        a.email_status,
        tunisDateTime(a.created_at),
        ...days.flatMap((d) => {
          const c = map.get(`${a.id}|${d.id}`);
          return c ? [tunisDateTime(c.checked_at), c.checked_by, c.method] : ["", "", ""];
        }),
      ]),
    );
  }
  // BOM so Excel opens UTF-8 (accents, Arabic names) correctly.
  return { csv: "﻿" + lines.join("\r\n") + "\r\n", rows: attendees.rows.length };
}
