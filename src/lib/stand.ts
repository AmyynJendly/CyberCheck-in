// Import of the registration-stand sheet: who registered, what they enrolled
// in, and whether they already paid at the stand.
//
// Paid at the stand means:
//   enrolled in the sessions  → the membership (15 DT): free for every session AND the main event
//   enrolled in the main event only → the main-event entry fee (5 DT)
// A number in the "paid" column decides directly: ≥ membership fee → membership,
// otherwise → entry fee. Stand money is recorded with channel = 'stand', so it
// never counts as cash taken by HR at the door.
import { query, withTransaction } from "./db";
import { audit } from "./audit";
import { HttpError } from "./http";
import { cleanAttendeeFields, ingestFormSubmission } from "./attendees";
import { findValidMembership, grantMembershipTx, parseTable, phoneKey } from "./members";
import { getEventDays, type EventRow } from "./events";
import { tunisDate } from "./time";
import type { Staff } from "./auth";

export type Col = "name" | "email" | "phone" | "enrollment" | "paid";
export type Mapping = Partial<Record<Col, number>>; // column index, or undefined
export type EnrollMeaning = "sessions" | "main" | "both" | "none";

const GUESS: Record<Col, RegExp> = {
  name: /^(full ?name|name|nom|nom et pr[ée]nom|pr[ée]nom et nom|nom complet|الاسم)/i,
  email: /mail/i,
  phone: /phone|t[ée]l|num[ée]ro|mobile|gsm|whats|الهاتف/i,
  enrollment: /enrol|inscri|particip|attend|choi|programme|program|which|what will|sessions?|events?\b/i,
  paid: /paid|pay[ée]?|paiement|payment|montant|amount|cash|dt\b|fee|frais/i,
};
const SESSIONS_RE = /session|s[ée]ance|formation|atelier|workshop|training|cours|class/i;
const MAIN_RE = /main|comp[ée]t|ctf|final|principal|hackathon|challenge|concours/i;

export function guessMeaning(value: string): EnrollMeaning {
  const s = SESSIONS_RE.test(value);
  const m = MAIN_RE.test(value);
  return s && m ? "both" : s ? "sessions" : m ? "main" : "none";
}

/** Split a checkbox cell ("Sessions, Main event") into its answers. */
export function enrollParts(cell: string | undefined): string[] {
  return (cell ?? "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
}

export interface SheetAnalysis {
  headers: string[];
  rows: string[][];
  mapping: Mapping;
  enrollment_values: { value: string; count: number; meaning: EnrollMeaning }[];
}

export function analyzeSheet(text: string): SheetAnalysis {
  const table = parseTable(text);
  if (table.length < 2) throw new HttpError(400, "NOTHING_TO_IMPORT", "Paste the sheet with its header row and at least one person.");
  const headers = table[0].map((h) => h.trim());
  const rows = table.slice(1);
  const mapping: Mapping = {};
  const used = new Set<number>();
  for (const col of ["email", "phone", "paid", "enrollment", "name"] as Col[]) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && GUESS[col].test(h));
    if (i >= 0) {
      mapping[col] = i;
      used.add(i);
    }
  }
  const counts = new Map<string, number>();
  if (mapping.enrollment !== undefined) {
    for (const r of rows) for (const v of enrollParts(r[mapping.enrollment])) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return {
    headers,
    rows,
    mapping,
    enrollment_values: [...counts].map(([value, count]) => ({ value, count, meaning: guessMeaning(value) })),
  };
}

/** "yes" | amount | null (not paid). */
export function readPaid(cell: string | undefined): "yes" | number | null {
  const v = (cell ?? "").trim().toLowerCase();
  if (!v || /^(no|non|n|false|faux|0|-|unpaid|not paid|pas pay[ée]|non pay[ée]|x?no)$/.test(v)) return null;
  const num = v.match(/(\d+(?:[.,]\d+)?)/);
  if (num) {
    const n = Number(num[1].replace(",", "."));
    return n > 0 ? n : null;
  }
  if (/^(yes|oui|y|o|x|✓|✔|true|vrai|paid|pay[ée]|ok|done|fait)\b/.test(v)) return "yes";
  return null;
}

export interface InterpretedRow {
  line: number;
  full_name: string;
  email: string | null;
  phone: string | null;
  enrollment: string | null;
  enroll_sessions: boolean | null;
  enroll_main: boolean | null;
  paid_raw: string;
  /** what will be recorded as paid at the stand */
  paid: "membership" | "entry" | null;
  /** paid, but we can't tell for what (fix the sheet) */
  unclear: boolean;
}

export function interpretRows(
  a: Pick<SheetAnalysis, "rows">,
  mapping: Mapping,
  meanings: Record<string, EnrollMeaning>,
  fees: { membership: number; entry: number },
): InterpretedRow[] {
  const cell = (r: string[], c: Col) => (mapping[c] !== undefined ? (r[mapping[c]!] ?? "").trim() : "");
  const out: InterpretedRow[] = [];
  a.rows.forEach((r, idx) => {
    const name = cell(r, "name");
    if (!name) return;
    const parts = enrollParts(mapping.enrollment !== undefined ? r[mapping.enrollment] : "");
    const ms = parts.map((p) => meanings[p] ?? guessMeaning(p));
    const known = parts.length > 0 && ms.some((m) => m !== "none");
    const sessions = known ? ms.some((m) => m === "sessions" || m === "both") : null;
    const main = known ? ms.some((m) => m === "main" || m === "both") : null;
    const paidCell = cell(r, "paid");
    const p = readPaid(paidCell);
    let paid: InterpretedRow["paid"] = null;
    let unclear = false;
    if (typeof p === "number") paid = p >= fees.membership ? "membership" : "entry";
    else if (p === "yes") {
      if (sessions) paid = "membership";
      else if (main) paid = "entry";
      else unclear = true;
    }
    out.push({
      line: idx + 2,
      full_name: name,
      email: cell(r, "email") || null,
      phone: cell(r, "phone") || null,
      enrollment: parts.length ? parts.join(", ") : null,
      enroll_sessions: sessions,
      enroll_main: main,
      paid_raw: paidCell,
      paid,
      unclear,
    });
  });
  return out;
}

export interface StandImportResult {
  created: number;
  updated: number;
  unchanged: number;
  emails_queued: number;
  memberships: number;
  entries: number;
  already_member: number;
  unclear: string[];
}

export async function importStandRows(admin: Staff, event: EventRow, rows: InterpretedRow[]): Promise<StandImportResult> {
  const days = await getEventDays(event.id);
  const entryDays = days.filter((d) => d.access === "members_or_fee");
  const res: StandImportResult = { created: 0, updated: 0, unchanged: 0, emails_queued: 0, memberships: 0, entries: 0, already_member: 0, unclear: [] };

  for (const r of rows) {
    const fields = cleanAttendeeFields({ full_name: r.full_name, email: r.email, phone: r.phone, enrollment: r.enrollment });
    fields.enroll_sessions = r.enroll_sessions;
    fields.enroll_main = r.enroll_main;
    const key = fields.email ?? (phoneKey(fields.phone) ? `tel:${phoneKey(fields.phone)}` : `name:${fields.full_name.toLowerCase()}`);
    const ing = await ingestFormSubmission(event.id, `stand:${key}`, fields, { resendExisting: false });
    if (ing.outcome === "created") res.created++;
    else if (ing.outcome === "updated") res.updated++;
    else res.unchanged++;
    if (ing.sendEmail) res.emails_queued++;
    if (r.unclear) res.unclear.push(`${r.full_name} (line ${r.line})`);
    if (!r.paid) continue;

    const a = await query<{ member_id: string | null; email: string | null; phone: string | null }>("select member_id, email, phone from attendees where id = $1", [ing.attendeeId]);
    const att = a.rows[0];

    if (r.paid === "membership") {
      const valid = await findValidMembership({ memberId: att.member_id, email: att.email, phone: att.phone }, tunisDate());
      const paidBefore = await query("select 1 from payments where attendee_id = $1 and kind = 'membership' and voided_at is null", [ing.attendeeId]);
      if (valid || paidBefore.rowCount) {
        res.already_member++;
        continue;
      }
      await withTransaction(async (c) => {
        const memberId = await grantMembershipTx(c, { fullName: fields.full_name, email: att.email, phone: att.phone, staff: admin, source: "stand" });
        await c.query("update attendees set member_id = $2, updated_at = now() where id = $1", [ing.attendeeId, memberId]);
        await c.query(
          `insert into payments (event_id, event_day_id, attendee_id, staff_id, kind, amount, member_id, channel)
           values ($1, null, $2, $3, 'membership', $4, $5, 'stand')`,
          [event.id, ing.attendeeId, admin.id, event.membership_fee, memberId],
        );
      });
      res.memberships++;
    } else {
      for (const d of entryDays) {
        const ins = await query(
          `insert into payments (event_id, event_day_id, attendee_id, staff_id, kind, amount, channel)
           values ($1, $2, $3, $4, 'entry', $5, 'stand')
           on conflict (attendee_id, event_day_id) where kind = 'entry' and voided_at is null do nothing
           returning id`,
          [event.id, d.id, ing.attendeeId, admin.id, d.entry_fee],
        );
        if (ins.rowCount) res.entries++;
      }
    }
  }
  await audit({ staffId: admin.id, action: "import_stand_sheet", eventId: event.id, details: { ...res, unclear: res.unclear.length } });
  return res;
}
