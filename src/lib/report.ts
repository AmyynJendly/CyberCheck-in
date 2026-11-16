// Final report (Excel): one sheet per event day with everyone who attended,
// then a Statistics sheet. Admin-only (GET /api/events/:id/report.xlsx).
import ExcelJS from "exceljs";
import { query } from "./db";
import { dayLabel, getEventDays, requireEvent, type DayRow } from "./events";
import { phoneKey } from "./members";
import { EVENT_TZ } from "./time";
import { tickableDays, tickedDay } from "./ticks";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type Tone = "green" | "orange" | "red" | "accent" | null;

export interface ReportRow {
  name: string;
  email: string;
  phone: string;
  study: string;
  registered: "Form" | "Walk-in";
  membership: string;
  membershipTone: Tone;
  paid: string;
  collectedBy: string;
  time: string; // HH:MM, Tunis
  by: string;
  how: "QR" | "Search" | "Walk-in";
  ticked: "Yes" | "Not ticked" | null; // null: the day isn't a form option
}

export interface ReportDay {
  id: string;
  label: string;
  date: string;
  access: DayRow["access"];
  entryFee: number;
  capacity: number | null;
  tickable: boolean;
  rows: ReportRow[];
  walkIns: number;
  members: number; // in the room as members (incl. joined / claimed that day)
  payments: number;
  cash: number;
  tickedCount: number; // registrations that ticked this day
  tickedCame: number;
  cameWithoutTicking: number;
}

export interface ReportData {
  event: { name: string; location: string | null; membershipFee: number };
  generatedAt: string;
  days: ReportDay[];
  sessionLabels: string[];
  mainLabels: string[];
  totals: {
    registered: number;
    walkIns: number;
    cameAny: number; // everyone (form + walk-in) with at least one check-in
    registeredCame: number;
    noShows: number;
    checkins: number;
    registeredForSessions: number;
    mainOnly: number;
    cameToSessions: number;
    cameToMain: number;
    sessionsAndMain: number;
    everyDay: number;
    tickedButNone: number;
    avgDays: number;
    daysAttended: number[]; // index k = people who came on exactly k+1 days
    cash: number;
    standCash: number;
    joinedAtDoor: number;
    joinedCash: number;
    entryFees: number;
    entryCash: number;
    claims: number;
    claimsConfirmed: number;
    claimsRejected: number;
    claimsToCheck: number;
    voided: number;
    emails: { sent: number; failed: number; waiting: number; none: number };
  };
  cashByStaff: { name: string; payments: number; cash: number }[];
  byYear: { year: string; registered: number; came: number }[];
  byField: { field: string; registered: number; came: number }[];
}

const hhmm = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: EVENT_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const longDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00Z`));
const HOW = { qr: "QR", manual: "Search", walk_in: "Walk-in" } as const;
const KIND = { membership: "Membership", entry: "Entry" } as const;

export async function getReportData(eventId: string): Promise<ReportData> {
  const event = await requireEvent(eventId);
  const days = await getEventDays(eventId);
  const [people, checkins, payments, members, claims, reviews] = await Promise.all([
    query<{ id: string; full_name: string; email: string | null; phone: string | null; class_year: string | null; source: "form" | "walk_in"; enrollment: string | null; member_id: string | null; email_status: string }>(
      `select id, full_name, email, phone, class_year, source, enrollment, member_id, email_status
         from attendees where event_id = $1 order by lower(full_name)`,
      [eventId],
    ),
    query<{ attendee_id: string; event_day_id: string; checked_at: string; method: "qr" | "manual" | "walk_in"; by: string }>(
      `select c.attendee_id, c.event_day_id, c.checked_at, c.method, s.name as by
         from checkins c join event_days d on d.id = c.event_day_id join staff s on s.id = c.staff_id
        where d.event_id = $1 and c.undone_at is null
        order by c.checked_at`,
      [eventId],
    ),
    query<{ attendee_id: string; event_day_id: string | null; kind: "membership" | "entry"; amount: number; channel: string; by: string; voided: boolean }>(
      `select p.attendee_id, p.event_day_id, p.kind, p.amount, p.channel, s.name as by, p.voided_at is not null as voided
         from payments p join staff s on s.id = p.staff_id where p.event_id = $1`,
      [eventId],
    ),
    query<{ id: string; email: string | null; phone_key: string | null; created_at: string; valid_until: string }>(
      "select id, email, phone_key, created_at, valid_until from members",
    ),
    query<{ attendee_id: string; day_id: string; member_id: string }>(
      `select attendee_id, details->>'event_day_id' as day_id, details->>'member_id' as member_id
         from audit_log where event_id = $1 and action = 'claim_member'`,
      [eventId],
    ),
    query<{ member_id: string; action: string }>(
      "select details->>'member_id' as member_id, action from audit_log where action in ('confirm_member', 'reject_member')",
    ),
  ]);

  const review = new Map(reviews.rows.map((r) => [r.member_id, r.action]));
  const claimOf = new Map(claims.rows.map((c) => [`${c.attendee_id}|${c.day_id}`, c]));
  const claimStatus = (memberId: string) =>
    review.get(memberId) === "reject_member" ? "rejected" : review.get(memberId) === "confirm_member" ? "confirmed" : "to check";
  const byEmail = new Map(members.rows.filter((m) => m.email).map((m) => [m.email!, m]));
  const byPhone = new Map(members.rows.filter((m) => m.phone_key).map((m) => [m.phone_key!, m]));
  const byId = new Map(members.rows.map((m) => [m.id, m]));
  const memberRecords = (a: (typeof people.rows)[number]) =>
    [a.member_id && byId.get(a.member_id), a.email && byEmail.get(a.email), byPhone.get(phoneKey(a.phone) ?? "")].filter(Boolean) as (typeof members.rows)[number][];

  const livePay = payments.rows.filter((p) => !p.voided);
  const payOn = new Map(livePay.filter((p) => p.event_day_id && p.channel === "desk").map((p) => [`${p.attendee_id}|${p.event_day_id}`, p]));
  const personBy = new Map(people.rows.map((p) => [p.id, p]));
  const tickable = tickableDays(days, people.rows.map((p) => p.enrollment));
  const sessionIds = new Set(tickable.size ? tickable : days.slice(0, -1).map((d) => d.id));
  const daysOf = new Map<string, Set<string>>();
  for (const c of checkins.rows) (daysOf.get(c.attendee_id) ?? daysOf.set(c.attendee_id, new Set()).get(c.attendee_id)!).add(c.event_day_id);

  const reportDays: ReportDay[] = days.map((d) => {
    const label = dayLabel(d);
    const isTickable = tickable.has(d.id);
    const rows: ReportRow[] = [];
    let members = 0;
    for (const c of checkins.rows.filter((x) => x.event_day_id === d.id)) {
      const a = personBy.get(c.attendee_id)!;
      const pay = payOn.get(`${a.id}|${d.id}`);
      const claim = claimOf.get(`${a.id}|${d.id}`);
      let membership = "—";
      let tone: Tone = null;
      if (pay?.kind === "membership") [membership, tone] = ["Joined today", "green"];
      else if (claim) {
        const s = claimStatus(claim.member_id);
        [membership, tone] = [`Claimed · ${s}`, s === "confirmed" ? "accent" : s === "rejected" ? "red" : "orange"];
      } else if (memberRecords(a).some((m) => new Date(m.created_at) <= new Date(c.checked_at) && m.valid_until >= d.day_date)) {
        [membership, tone] = ["Member", "accent"];
      }
      if (membership !== "—") members++;
      rows.push({
        name: a.full_name,
        email: a.email ?? "",
        phone: a.phone ?? "",
        study: a.class_year ?? "",
        registered: a.source === "walk_in" ? "Walk-in" : "Form",
        membership,
        membershipTone: tone,
        paid: pay ? `${KIND[pay.kind]} · ${Number(pay.amount)} DT` : "",
        collectedBy: pay?.by ?? "",
        time: hhmm(c.checked_at),
        by: c.by,
        how: HOW[c.method],
        ticked: isTickable ? (tickedDay(a.enrollment, label) ? "Yes" : "Not ticked") : null,
      });
    }
    const dayPays = livePay.filter((p) => p.event_day_id === d.id && p.channel === "desk");
    const formPeople = people.rows.filter((p) => p.source === "form");
    const tickedIds = isTickable ? formPeople.filter((p) => tickedDay(p.enrollment, label)).map((p) => p.id) : [];
    return {
      id: d.id,
      label,
      date: d.day_date,
      access: d.access,
      entryFee: Number(d.entry_fee),
      capacity: d.capacity,
      tickable: isTickable,
      rows,
      walkIns: rows.filter((r) => r.how === "Walk-in").length,
      members,
      payments: dayPays.length,
      cash: dayPays.reduce((s, p) => s + Number(p.amount), 0),
      tickedCount: tickedIds.length,
      tickedCame: tickedIds.filter((id) => daysOf.get(id)?.has(d.id)).length,
      cameWithoutTicking: rows.filter((r) => r.ticked === "Not ticked").length,
    };
  });

  const form = people.rows.filter((p) => p.source === "form");
  const came = people.rows.filter((p) => daysOf.has(p.id));
  const inSession = (id: string) => [...(daysOf.get(id) ?? [])].some((x) => sessionIds.has(x));
  const inMain = (id: string) => [...(daysOf.get(id) ?? [])].some((x) => !sessionIds.has(x));
  const ticksOf = (p: (typeof people.rows)[number]) => days.filter((d) => tickable.has(d.id) && tickedDay(p.enrollment, dayLabel(d))).map((d) => d.id);
  const dist = Array.from({ length: days.length }, (_, k) => came.filter((p) => daysOf.get(p.id)!.size === k + 1).length);
  const desk = livePay.filter((p) => p.channel === "desk");
  const claimed = claims.rows.map((c) => claimStatus(c.member_id));
  const staffCash = new Map<string, { payments: number; cash: number }>();
  for (const p of desk) {
    const s = staffCash.get(p.by) ?? { payments: 0, cash: 0 };
    s.payments++;
    s.cash += Number(p.amount);
    staffCash.set(p.by, s);
  }
  const group = <K extends string>(keyOf: (p: (typeof people.rows)[number]) => K) => {
    const m = new Map<K, { registered: number; came: number }>();
    for (const p of form) {
      const k = keyOf(p);
      const g = m.get(k) ?? { registered: 0, came: 0 };
      g.registered++;
      if (daysOf.has(p.id)) g.came++;
      m.set(k, g);
    }
    return [...m].sort((a, b) => b[1].registered - a[1].registered);
  };
  const yearOf = (p: (typeof people.rows)[number]) => (p.class_year?.match(/year\s*(\d)/i)?.[1] ? `Year ${p.class_year.match(/year\s*(\d)/i)![1]}` : "Not given");
  const fieldOf = (p: (typeof people.rows)[number]) => p.class_year?.split("·")[0].trim() || "Not given";

  return {
    event: { name: event.name, location: event.location, membershipFee: Number(event.membership_fee) },
    generatedAt: new Intl.DateTimeFormat("en-GB", { timeZone: EVENT_TZ, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()),
    days: reportDays,
    sessionLabels: reportDays.filter((d) => sessionIds.has(d.id)).map((d) => d.label),
    mainLabels: reportDays.filter((d) => !sessionIds.has(d.id)).map((d) => d.label),
    totals: {
      registered: form.length,
      walkIns: people.rows.length - form.length,
      cameAny: came.length,
      registeredCame: form.filter((p) => daysOf.has(p.id)).length,
      noShows: form.filter((p) => !daysOf.has(p.id)).length,
      checkins: checkins.rows.length,
      registeredForSessions: form.filter((p) => ticksOf(p).length > 0).length,
      mainOnly: form.filter((p) => ticksOf(p).length === 0).length,
      cameToSessions: came.filter((p) => inSession(p.id)).length,
      cameToMain: came.filter((p) => inMain(p.id)).length,
      sessionsAndMain: came.filter((p) => inSession(p.id) && inMain(p.id)).length,
      everyDay: came.filter((p) => daysOf.get(p.id)!.size === days.length).length,
      tickedButNone: form.filter((p) => {
        const t = ticksOf(p);
        return t.length > 0 && !t.some((id) => daysOf.get(p.id)?.has(id));
      }).length,
      avgDays: came.length ? checkins.rows.length / came.length : 0,
      daysAttended: dist,
      cash: desk.reduce((s, p) => s + Number(p.amount), 0),
      standCash: livePay.filter((p) => p.channel === "stand").reduce((s, p) => s + Number(p.amount), 0),
      joinedAtDoor: desk.filter((p) => p.kind === "membership").length,
      joinedCash: desk.filter((p) => p.kind === "membership").reduce((s, p) => s + Number(p.amount), 0),
      entryFees: desk.filter((p) => p.kind === "entry").length,
      entryCash: desk.filter((p) => p.kind === "entry").reduce((s, p) => s + Number(p.amount), 0),
      claims: claimed.length,
      claimsConfirmed: claimed.filter((s) => s === "confirmed").length,
      claimsRejected: claimed.filter((s) => s === "rejected").length,
      claimsToCheck: claimed.filter((s) => s === "to check").length,
      voided: payments.rows.filter((p) => p.voided).length,
      emails: {
        sent: people.rows.filter((p) => p.email_status === "sent").length,
        failed: people.rows.filter((p) => p.email_status === "failed").length,
        waiting: people.rows.filter((p) => p.email_status === "pending").length,
        none: people.rows.filter((p) => p.email_status === "none").length,
      },
    },
    cashByStaff: [...staffCash].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.cash - a.cash),
    byYear: group(yearOf).map(([year, g]) => ({ year, ...g })).sort((a, b) => a.year.localeCompare(b.year)),
    byField: group(fieldOf).map(([field, g]) => ({ field, ...g })),
  };
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

// Apple-like light palette: near-black text, soft grays, one accent (the club teal).
const C = {
  text: "FF1D1D1F",
  secondary: "FF6E6E73",
  tertiary: "FF8E8E93",
  separator: "FFE5E5EA",
  header: "FFF5F5F7",
  zebra: "FFFAFAFC",
  white: "FFFFFFFF",
  accent: "FF0A7F94",
  accentSoft: "FFE6F3F5",
  bar: "FF8CCBD5", // lighter accent for in-cell bars
  green: "FF1F7A35",
  greenSoft: "FFE7F5EB",
  orange: "FFA94A00",
  orangeSoft: "FFFFF2E2",
  red: "FFC4001A",
  redSoft: "FFFDECEE",
};
const FONT = "Aptos";
const TONE: Record<Exclude<Tone, null>, [string, string]> = {
  green: [C.green, C.greenSoft],
  orange: [C.orange, C.orangeSoft],
  red: [C.red, C.redSoft],
  accent: [C.accent, C.accentSoft],
};
const ACCESS: Record<DayRow["access"], string> = {
  free: "Free for everyone",
  members: "Club members only",
  members_or_fee: "Members free, others pay",
};

type Cell = ExcelJS.Cell;
const font = (c: Cell, o: Partial<ExcelJS.Font> = {}) => (c.font = { name: FONT, size: 11, color: { argb: C.text }, ...o });
const fill = (c: Cell, argb: string) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb } });
const line = (c: Cell) => (c.border = { bottom: { style: "thin", color: { argb: C.separator } } });

function newSheet(wb: ExcelJS.Workbook, name: string, widths: number[], tab: string) {
  const ws = wb.addWorksheet(name, {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: tab }, defaultRowHeight: 20 },
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  ws.columns = widths.map((width) => ({ width }));
  return ws;
}

function title(ws: ExcelJS.Worksheet, text: string, sub: string, lastCol: number) {
  ws.getRow(1).height = 12;
  ws.mergeCells(2, 2, 2, lastCol);
  const t = ws.getCell(2, 2);
  t.value = text;
  font(t, { size: 22, bold: true });
  ws.getRow(2).height = 34;
  ws.mergeCells(3, 2, 3, lastCol);
  const s = ws.getCell(3, 2);
  s.value = sub;
  font(s, { size: 12, color: { argb: C.secondary } });
  ws.getRow(3).height = 20;
  ws.getRow(4).height = 14;
}

/** A row of KPI tiles: small gray label above a large number. */
function tiles(ws: ExcelJS.Worksheet, row: number, items: { label: string; value: string | number; note?: string; numFmt?: string }[], spans: [number, number][]) {
  ws.getRow(row).height = 18;
  ws.getRow(row + 1).height = 34;
  ws.getRow(row + 2).height = 18;
  items.forEach((it, i) => {
    const [c1, c2] = spans[i];
    for (const r of [row, row + 1, row + 2]) {
      ws.mergeCells(r, c1, r, c2);
      fill(ws.getCell(r, c1), C.header);
    }
    // A white edge between tiles, so they read as separate cards.
    if (i > 0) for (const r of [row, row + 1, row + 2]) ws.getCell(r, c1).border = { left: { style: "thick", color: { argb: C.white } } };
    const l = ws.getCell(row, c1);
    l.value = it.label.toUpperCase();
    font(l, { size: 9, bold: true, color: { argb: C.tertiary } });
    l.alignment = { vertical: "bottom", indent: 1 };
    const v = ws.getCell(row + 1, c1);
    v.value = it.value;
    if (it.numFmt) v.numFmt = it.numFmt;
    font(v, { size: 22, bold: true });
    v.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    const n = ws.getCell(row + 2, c1);
    n.value = it.note ?? "";
    font(n, { size: 10, color: { argb: C.secondary } });
    n.alignment = { vertical: "top", indent: 1 };
  });
}

function sectionTitle(ws: ExcelJS.Worksheet, row: number, text: string, lastCol: number) {
  ws.getRow(row).height = 30;
  ws.mergeCells(row, 2, row, lastCol);
  const c = ws.getCell(row, 2);
  c.value = text;
  font(c, { size: 15, bold: true });
  c.alignment = { vertical: "bottom" };
}

interface Col {
  header: string;
  align?: "left" | "right" | "center";
  numFmt?: string;
}

/** Header + rows, zebra striped, thin separators. Returns the next free row. */
function table(ws: ExcelJS.Worksheet, row: number, firstCol: number, cols: Col[], rows: (string | number | null)[][], opts: { tones?: (Tone | null)[][]; filter?: boolean; total?: (string | number | null)[] } = {}) {
  const h = ws.getRow(row);
  h.height = 24;
  cols.forEach((col, i) => {
    const c = h.getCell(firstCol + i);
    c.value = col.header;
    font(c, { size: 10, bold: true, color: { argb: C.secondary } });
    fill(c, C.header);
    c.alignment = { vertical: "middle", horizontal: col.align ?? "left", indent: col.align === "right" ? 0 : 1 };
    c.border = { bottom: { style: "thin", color: { argb: C.separator } } };
  });
  rows.forEach((values, ri) => {
    const r = ws.getRow(row + 1 + ri);
    r.height = 22;
    values.forEach((v, i) => {
      const c = r.getCell(firstCol + i);
      c.value = v ?? "";
      font(c);
      if (cols[i].numFmt) c.numFmt = cols[i].numFmt!;
      c.alignment = { vertical: "middle", horizontal: cols[i].align ?? "left", indent: cols[i].align === "right" ? 0 : 1 };
      if (ri % 2 === 1) fill(c, C.zebra);
      line(c);
      // Calm by default: coloured text only. Things to look at (orange/red) also get a soft background.
      const tone = opts.tones?.[ri]?.[i];
      if (tone) {
        font(c, { color: { argb: TONE[tone][0] } });
        if (tone === "orange" || tone === "red") fill(c, TONE[tone][1]);
      }
    });
  });
  let end = row + rows.length + 1;
  if (opts.total) {
    const r = ws.getRow(end);
    r.height = 24;
    opts.total.forEach((v, i) => {
      const c = r.getCell(firstCol + i);
      c.value = v ?? "";
      font(c, { bold: true });
      if (cols[i].numFmt) c.numFmt = cols[i].numFmt!;
      c.alignment = { vertical: "middle", horizontal: cols[i].align ?? "left", indent: cols[i].align === "right" ? 0 : 1 };
      c.border = { top: { style: "thin", color: { argb: C.text } } };
    });
    end++;
  }
  if (opts.filter && rows.length) ws.autoFilter = { from: { row, column: firstCol }, to: { row: row + rows.length, column: firstCol + cols.length - 1 } };
  return end;
}

/** A thin bar for percentages, drawn with block characters (works in every spreadsheet app). */
const bar = (p: number) => (p > 0 ? "█".repeat(Math.max(1, Math.round(p * 12))) : "");

function sheetName(i: number, label: string, used: Set<string>) {
  let n = `${i + 1} · ${label}`.replace(/[\\/?*[\]:]/g, " ");
  if (n.length > 31) n = `${n.slice(0, 30).trimEnd()}…`;
  while (used.has(n)) n = `${n.slice(0, 29)}${used.size}`;
  used.add(n);
  return n;
}

const pct = (a: number, b: number) => (b ? a / b : 0);

export async function buildReportWorkbook(data: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Cybertrace Check-in";
  wb.created = new Date();
  const used = new Set<string>();

  // One sheet per day.
  for (const [i, d] of data.days.entries()) {
    const cols: (Col & { width: number })[] = [
      { header: "#", width: 6, align: "right" },
      { header: "Name", width: 26 },
      { header: "Email", width: 32 },
      { header: "Phone", width: 18 },
      { header: "Study", width: 28 },
      { header: "Registered", width: 13 },
      { header: "Membership", width: 22 },
      { header: "Paid", width: 20 },
      { header: "Collected by", width: 22 },
      { header: "Checked in", width: 13, align: "center" },
      { header: "Scanned by", width: 22 },
      { header: "How", width: 11 },
      ...(d.tickable ? [{ header: "Ticked this session", width: 20 }] : []),
    ];
    const ws = newSheet(wb, sheetName(i, d.label, used), [2, ...cols.map((c) => c.width), 2], C.accent);
    const last = cols.length + 1;
    title(ws, d.label, `${longDate(d.date)}  ·  ${ACCESS[d.access]}${d.access === "members_or_fee" ? ` (${d.entryFee} DT)` : ""}${data.event.location ? `  ·  ${data.event.location}` : ""}`, last);

    const n = d.rows.length;
    const spans: [number, number][] = [[2, 4], [5, 7], [8, 10], [11, last]];
    tiles(
      ws,
      5,
      [
        { label: "Checked in", value: n, note: d.capacity ? `of ${d.capacity} seats` : "no seat limit" },
        { label: "Seats filled", value: d.capacity ? pct(n, d.capacity) : "—", numFmt: "0%", note: d.capacity ? `${Math.max(0, d.capacity - n)} left` : "" },
        { label: "Walk-ins", value: d.walkIns, note: `${d.members} in as members` },
        { label: "Collected at the door", value: d.cash, numFmt: '#,##0 "DT"', note: `${d.payments} payment${d.payments === 1 ? "" : "s"}` },
      ],
      spans,
    );

    const start = 9;
    const tones: (Tone | null)[][] = d.rows.map((r) => [
      ...Array(6).fill(null),
      r.membershipTone,
      ...Array(5).fill(null),
      ...(d.tickable ? [r.ticked === "Not ticked" ? "orange" : null] : []),
    ]);
    table(
      ws,
      start,
      2,
      cols,
      d.rows.map((r, k) => [k + 1, r.name, r.email, r.phone, r.study, r.registered, r.membership, r.paid, r.collectedBy, r.time, r.by, r.how, ...(d.tickable ? [r.ticked] : [])]),
      { tones, filter: true },
    );
    if (!n) {
      const c = ws.getCell(start + 1, 3);
      c.value = "Nobody checked in on this day.";
      font(c, { color: { argb: C.secondary }, italic: true });
    }
    ws.views = [{ showGridLines: false, state: "frozen", ySplit: start, xSplit: 0, topLeftCell: `A${start + 1}` }];
    ws.pageSetup.printTitlesRow = `${start}:${start}`;
    ws.headerFooter = { oddFooter: `&L&8${data.event.name} · ${d.label}&R&8Page &P of &N` };
  }

  // Statistics.
  const t = data.totals;
  const W = [2, 46, 14, 12, 12, 12, 18, 12, 12, 11, 11, 14, 2];
  const ws = newSheet(wb, "Statistics", W, C.text);
  const last = W.length - 1;
  const first = data.days[0]?.date;
  const lastDay = data.days[data.days.length - 1]?.date;
  title(
    ws,
    `${data.event.name} · Final report`,
    `${first ? (first === lastDay ? longDate(first) : `${longDate(first)} – ${longDate(lastDay!)}`) : ""}${data.event.location ? `  ·  ${data.event.location}` : ""}  ·  Generated ${data.generatedAt}`,
    last,
  );

  const spans: [number, number][] = [[2, 2], [3, 5], [6, 8], [9, last]];
  tiles(ws, 5, [
    { label: "Registered", value: t.registered, note: `${t.walkIns} more as walk-ins` },
    { label: "Came at least once", value: pct(t.registeredCame, t.registered), numFmt: "0%", note: `${t.registeredCame} of ${t.registered} registered` },
    { label: "Never came", value: t.noShows, note: `${Math.round(pct(t.noShows, t.registered) * 100)}% of registrations` },
    { label: "Collected at the door", value: t.cash, numFmt: '#,##0 "DT"', note: `${t.joinedAtDoor + t.entryFees} payments` },
  ], spans);
  tiles(ws, 9, [
    { label: "Check-ins", value: t.checkins, note: `${t.cameAny} different people` },
    { label: "Sessions + challenge", value: pct(t.sessionsAndMain, t.cameToSessions), numFmt: "0%", note: `${t.sessionsAndMain} of ${t.cameToSessions} session-goers` },
    { label: "New members", value: t.joinedAtDoor, note: `joined at the door (${t.joinedCash} DT)` },
    { label: "QR emails delivered", value: pct(t.emails.sent, t.emails.sent + t.emails.failed + t.emails.waiting), numFmt: "0%", note: `${t.emails.sent} sent · ${t.emails.failed} failed` },
  ], spans);
  for (const r of [8, 12]) ws.getRow(r).height = 10;

  // Sessions.
  let row = 13;
  sectionTitle(ws, row, "Day by day", last);
  const dayCols: Col[] = [
    { header: "Day" },
    { header: "Date" },
    { header: "Seats", align: "right" },
    { header: "Checked in", align: "right" },
    { header: "Filled", align: "right", numFmt: "0%" },
    { header: "", align: "left" },
    { header: "Ticked", align: "right" },
    { header: "…and came", align: "right", numFmt: "0%" },
    { header: "Came, no tick", align: "right" },
    { header: "Walk-ins", align: "right" },
    { header: "Cash", align: "right", numFmt: '#,##0 "DT"' },
  ];
  row = table(
    ws,
    row + 1,
    2,
    dayCols,
    data.days.map((d) => {
      const fillPct = d.capacity ? pct(d.rows.length, d.capacity) : null;
      return [
        d.label,
        new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${d.date}T12:00:00Z`)),
        d.capacity ?? "—",
        d.rows.length,
        fillPct ?? "—",
        fillPct !== null ? bar(fillPct) : "",
        d.tickable ? d.tickedCount : "—",
        d.tickable ? pct(d.tickedCame, d.tickedCount) : "—",
        d.tickable ? d.cameWithoutTicking : "—",
        d.walkIns,
        d.cash,
      ];
    }),
    {
      total: ["Total", "", "", t.checkins, "", "", "", "", "", data.days.reduce((s, d) => s + d.walkIns, 0), t.cash],
    },
  );
  for (let r = 15; r < row - 1; r++) font(ws.getCell(r, 7), { color: { argb: C.bar }, size: 9 });

  // Engagement.
  row += 1;
  sectionTitle(ws, row, "Who came", last);
  const sessions = data.sessionLabels.length ? `sessions (${data.sessionLabels.length})` : "sessions";
  const main = data.mainLabels.join(" / ") || "main event";
  const facts: [string, number, number | null, string][] = [
    ["Registered on the forms", t.registered, null, ""],
    ["…ticked at least one session", t.registeredForSessions, pct(t.registeredForSessions, t.registered), "of registrations"],
    [`…registered for the ${main} only`, t.mainOnly, pct(t.mainOnly, t.registered), "of registrations"],
    ["Came at least once (registered)", t.registeredCame, pct(t.registeredCame, t.registered), "of registrations"],
    ["Registered and never came", t.noShows, pct(t.noShows, t.registered), "of registrations"],
    ["Ticked sessions but came to none of them", t.tickedButNone, pct(t.tickedButNone, t.registeredForSessions), "of those who ticked"],
    [`Came to the ${sessions}`, t.cameToSessions, pct(t.cameToSessions, t.cameAny), "of everyone who came"],
    [`Came to the ${main}`, t.cameToMain, pct(t.cameToMain, t.cameAny), "of everyone who came"],
    [`Came to sessions and took part in the ${main}`, t.sessionsAndMain, pct(t.sessionsAndMain, t.cameToSessions), "of session-goers"],
    ["Came every day", t.everyDay, pct(t.everyDay, t.cameAny), "of everyone who came"],
    ["Walk-ins (not registered)", t.walkIns, null, ""],
  ];
  row = table(
    ws,
    row + 1,
    2,
    [{ header: "" }, { header: "People", align: "right" }, { header: "Share", align: "right", numFmt: "0%" }, { header: "" }, { header: "" }],
    facts.map(([label, n, p, of]) => [label, n, p ?? "", p !== null ? bar(p) : "", of]),
  );
  for (let r = row - facts.length; r < row; r++) {
    font(ws.getCell(r, 5), { color: { argb: C.bar }, size: 9 });
    font(ws.getCell(r, 6), { color: { argb: C.secondary }, size: 10 });
  }

  row += 1;
  sectionTitle(ws, row, "Days attended", last);
  row = table(
    ws,
    row + 1,
    2,
    [{ header: "Days" }, { header: "People", align: "right" }, { header: "Share", align: "right", numFmt: "0%" }, { header: "" }],
    t.daysAttended.map((n, k) => [`${k + 1} day${k ? "s" : ""}`, n, pct(n, t.cameAny), bar(pct(n, t.cameAny))]),
    { total: [`Average: ${t.avgDays.toFixed(1)} days per person`, t.cameAny, "", ""] },
  );
  for (let r = row - 1 - t.daysAttended.length; r < row - 1; r++) font(ws.getCell(r, 5), { color: { argb: C.bar }, size: 9 });

  // Membership and money.
  row += 1;
  sectionTitle(ws, row, "Membership and money", last);
  row = table(
    ws,
    row + 1,
    2,
    [{ header: "" }, { header: "Count", align: "right" }, { header: "Amount", align: "right", numFmt: '#,##0 "DT"' }],
    [
      [`Joined the club at the door (${data.event.membershipFee} DT)`, t.joinedAtDoor, t.joinedCash],
      ["Entry fees paid at the door", t.entryFees, t.entryCash],
      ["“Already a member” claims", t.claims, ""],
      ["…confirmed by an admin", t.claimsConfirmed, ""],
      ["…rejected", t.claimsRejected, ""],
      ["…still to check", t.claimsToCheck, ""],
      ["Payments cancelled by an admin (not counted)", t.voided, ""],
      ...(t.standCash ? [["Paid at the registration stand (separate)", "", t.standCash] as (string | number)[]] : []),
    ],
    { total: ["Total collected at the door", t.joinedAtDoor + t.entryFees, t.cash] },
  );

  if (data.cashByStaff.length) {
    row += 1;
    sectionTitle(ws, row, "Cash by HR member", last);
    row = table(
      ws,
      row + 1,
      2,
      [{ header: "HR member" }, { header: "Payments", align: "right" }, { header: "Collected", align: "right", numFmt: '#,##0 "DT"' }],
      data.cashByStaff.map((s) => [s.name, s.payments, s.cash]),
      { total: ["Total", data.cashByStaff.reduce((s, x) => s + x.payments, 0), t.cash] },
    );
  }

  // Who registered.
  for (const [heading, groups] of [
    ["By study year", data.byYear.map((g) => [g.year, g.registered, g.came] as const)],
    ["By field of study", data.byField.slice(0, 12).map((g) => [g.field, g.registered, g.came] as const)],
  ] as const) {
    if (!groups.length) continue;
    row += 1;
    sectionTitle(ws, row, heading, last);
    row = table(
      ws,
      row + 1,
      2,
      [{ header: "" }, { header: "Registered", align: "right" }, { header: "Came", align: "right" }, { header: "Came", align: "right", numFmt: "0%" }],
      groups.map(([k, r, c]) => [k, r, c, pct(c, r)]),
    );
  }

  // How the numbers are counted.
  row += 1;
  const notes = [
    "Registered: people from the Google Forms, counted once even if they filled in both forms. Walk-ins were added at the door.",
    `Sessions: the days people can tick on the form (${data.sessionLabels.join(", ") || "none"}). “Ticked … and came” is the share of those who ticked a day and came that day.`,
    "Membership on a day: on the member list before they were checked in, joined at the door that day, or let in as “already a member” (claimed).",
    "Money: only what HR collected at the door. Payments an admin cancelled are not counted.",
  ];
  for (const n of notes) {
    ws.mergeCells(row, 2, row, last);
    const c = ws.getCell(row, 2);
    c.value = n;
    font(c, { size: 9, color: { argb: C.tertiary } });
    c.alignment = { vertical: "top", wrapText: true };
    ws.getRow(row).height = 16;
    row++;
  }

  ws.headerFooter = { oddFooter: `&L&8${data.event.name} · Final report&R&8Page &P of &N` };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
