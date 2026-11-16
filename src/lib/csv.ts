import { query } from "./db";
import { dayLabel, getEventDays } from "./events";
import { enrollParts } from "./stand";
import { tunisDateTime } from "./time";

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Did the form's checkbox answer tick this day? A day is ticked when one of the
 * answers starts with the day's label: label "Offensive Web 101" matches the
 * option "Offensive Web 101(from interception to exploitation)".
 */
export function tickedDay(enrollment: string | null, label: string): boolean {
  const l = norm(label);
  return !!l && enrollParts(enrollment ?? "").some((p) => norm(p).startsWith(l));
}

/** Days that at least one registration ticked: only these get a "ticked" column. */
function tickableDays<D extends { id: string; label: string | null; day_date: string }>(days: D[], enrollments: (string | null)[]): Set<string> {
  const filled = enrollments.filter((e): e is string => !!e);
  return new Set(days.filter((d) => filled.some((e) => tickedDay(e, dayLabel(d)))).map((d) => d.id));
}

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
    member_until: string | null;
    enrollment: string | null;
  }>(
    `select a.id, a.full_name, a.email, a.phone, a.class_year, a.team_name, a.source,
            s.name as added_by, a.short_code, a.email_status, a.created_at, m.valid_until as member_until, a.enrollment
       from attendees a
       left join staff s on s.id = a.added_by_staff_id
       left join members m on m.id = a.member_id
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
  const payments = await query<{ attendee_id: string; event_day_id: string | null; kind: string; amount: number; paid_to: string; channel: string }>(
    `select p.attendee_id, p.event_day_id, p.kind, p.amount, s.name as paid_to, p.channel
       from payments p join staff s on s.id = p.staff_id
      where p.event_id = $1 and p.voided_at is null`,
    [eventId],
  );
  const paid = new Map<string, (typeof payments.rows)[number]>();
  const paidOther = new Map<string, string[]>(); // payments not tied to a day (stand membership, admin panel)
  for (const p of payments.rows) {
    if (p.event_day_id) paid.set(`${p.attendee_id}|${p.event_day_id}`, p);
    else paidOther.set(p.attendee_id, [...(paidOther.get(p.attendee_id) ?? []), `${p.kind} ${p.amount} DT${p.channel === "stand" ? " at the stand" : ` (${p.paid_to})`}`]);
  }
  const hasPaidDays = days.some((d) => d.access !== "free") || payments.rows.length > 0;
  const tickable = tickableDays(days, attendees.rows.map((a) => a.enrollment));

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
    ...(hasPaidDays ? ["member_until", "enrollment", "paid_before"] : []),
    ...(tickable.size ? ["attended_not_ticked"] : []),
    ...days.flatMap((d) => {
      const l = `${dayLabel(d)} (${d.day_date})`;
      return [
        `${l} checked_at`,
        `${l} checked_by`,
        `${l} method`,
        ...(tickable.has(d.id) ? [`${l} ticked`] : []),
        ...(hasPaidDays ? [`${l} paid`, `${l} paid_to`] : []),
      ];
    }),
  ];
  const lines = [csvLine(header)];
  for (const a of attendees.rows) {
    const notTicked = days.filter((d) => tickable.has(d.id) && map.has(`${a.id}|${d.id}`) && !tickedDay(a.enrollment, dayLabel(d)));
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
        ...(hasPaidDays ? [a.member_until ?? "", a.enrollment ?? "", (paidOther.get(a.id) ?? []).join("; ")] : []),
        ...(tickable.size ? [notTicked.map((d) => dayLabel(d)).join("; ")] : []),
        ...days.flatMap((d) => {
          const c = map.get(`${a.id}|${d.id}`);
          const p = paid.get(`${a.id}|${d.id}`);
          return [
            ...(c ? [tunisDateTime(c.checked_at), c.checked_by, c.method] : ["", "", ""]),
            ...(tickable.has(d.id) ? [tickedDay(a.enrollment, dayLabel(d)) ? "yes" : c ? "NOT TICKED" : ""] : []),
            ...(hasPaidDays ? (p ? [`${p.kind} ${p.amount} DT${p.channel === "stand" ? " (stand)" : ""}`, p.paid_to] : ["", ""]) : []),
          ];
        }),
      ]),
    );
  }
  // BOM so Excel opens UTF-8 (accents, Arabic names) correctly.
  return { csv: "\uFEFF" + lines.join("\r\n") + "\r\n", rows: attendees.rows.length };
}

/** CSV for ONE day: everyone checked in that day, with time, staff, method and payment. */
export async function buildDayCsv(eventId: string, dayId: string): Promise<{ csv: string; rows: number; day: { day_date: string; label: string } | null }> {
  const days = await getEventDays(eventId);
  const day = days.find((d) => d.id === dayId);
  if (!day) return { csv: "", rows: 0, day: null };
  const r = await query<{
    full_name: string;
    email: string | null;
    phone: string | null;
    class_year: string | null;
    team_name: string | null;
    source: string;
    member_until: string | null;
    checked_at: string;
    checked_by: string;
    method: string;
    paid_kind: string | null;
    paid_amount: number | null;
    paid_to: string | null;
    paid_channel: string | null;
    enrollment: string | null;
  }>(
    `select a.full_name, a.email, a.phone, a.class_year, a.team_name, a.source, m.valid_until as member_until, a.enrollment,
            c.checked_at, s.name as checked_by, c.method,
            p.kind as paid_kind, p.amount as paid_amount, ps.name as paid_to, p.channel as paid_channel
       from checkins c
       join attendees a on a.id = c.attendee_id
       join staff s on s.id = c.staff_id
       left join members m on m.id = a.member_id
       left join payments p on p.attendee_id = a.id and p.event_day_id = c.event_day_id and p.voided_at is null
       left join staff ps on ps.id = p.staff_id
      where c.event_day_id = $1 and c.undone_at is null
      order by c.checked_at`,
    [dayId],
  );
  const enrollments = await query<{ enrollment: string }>(
    "select distinct enrollment from attendees where event_id = $1 and enrollment is not null",
    [eventId],
  );
  const tickable = tickableDays([day], enrollments.rows.map((e) => e.enrollment)).has(day.id);
  const lines = [
    csvLine(["name", "email", "phone", "class_year", "team_name", "source", "member_until", "checked_at", "checked_by", "method", ...(tickable ? ["ticked"] : []), "paid", "paid_to"]),
    ...r.rows.map((x) =>
      csvLine([
        x.full_name,
        x.email,
        x.phone,
        x.class_year,
        x.team_name,
        x.source,
        x.member_until ?? "",
        tunisDateTime(x.checked_at),
        x.checked_by,
        x.method,
        ...(tickable ? [tickedDay(x.enrollment, dayLabel(day)) ? "yes" : "NOT TICKED"] : []),
        x.paid_kind ? `${x.paid_kind} ${x.paid_amount} DT${x.paid_channel === "stand" ? " (stand)" : ""}` : "",
        x.paid_to ?? "",
      ]),
    ),
  ];
  return { csv: "\uFEFF" + lines.join("\r\n") + "\r\n", rows: r.rows.length, day: { day_date: day.day_date, label: dayLabel(day) } };
}
