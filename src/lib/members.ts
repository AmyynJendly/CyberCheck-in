// Club membership list: import, matching, and granting membership at the desk.
import type { PoolClient } from "pg";
import { query, withTransaction, type Queryable } from "./db";
import { audit } from "./audit";
import { HttpError } from "./http";
import { isIsoDate, tunisDate } from "./time";
import { cleanText, looksLikeEmail, normalizeEmail } from "./validate";
import type { Staff } from "./auth";

/** Last 8 digits of a phone number (Tunisian numbers have 8), or null. */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : null;
}

/**
 * Default end of a membership: 31 August of the current academic year
 * (memberships last the whole year).
 */
export function defaultValidUntil(now: Date = new Date()): string {
  const [y, m] = tunisDate(now).split("-").map(Number);
  return `${m >= 9 ? y + 1 : y}-08-31`;
}

export interface MemberRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  valid_until: string;
  source: "import" | "desk" | "manual" | "claimed" | "stand";
}

/**
 * A membership valid on `onDate` for this person: the one linked to the
 * attendee, else one matching their email, else their phone.
 */
export async function findValidMembership(
  who: { memberId?: string | null; email?: string | null; phone?: string | null },
  onDate: string,
  client?: Queryable,
): Promise<MemberRow | null> {
  const key = phoneKey(who.phone);
  if (!who.memberId && !who.email && !key) return null;
  const r = await query<MemberRow>(
    `select id, full_name, email, phone, valid_until, source from members
      where valid_until >= $4
        and (id = $1 or (email is not null and email = $2) or (phone_key is not null and phone_key = $3))
      order by (id = $1) desc nulls last, (email = $2) desc nulls last
      limit 1`,
    [who.memberId ?? null, who.email ?? null, key, onDate],
    client,
  );
  return r.rows[0] ?? null;
}

/**
 * Make this person a member (desk payment): extend an existing record that
 * matches their email/phone, otherwise create one. Returns the member id.
 */
export async function grantMembershipTx(
  c: PoolClient,
  p: {
    fullName: string;
    email: string | null;
    phone: string | null;
    staff: Staff;
    validUntil?: string;
    /** desk = paid at the door · stand = paid at the registration stand · claimed = "already a member" (no money, needs admin review) */
    source?: "desk" | "stand" | "claimed";
  },
): Promise<string> {
  const validUntil = p.validUntil ?? defaultValidUntil();
  const source = p.source ?? "desk";
  const review = source === "claimed";
  const key = phoneKey(p.phone);
  const existing = await c.query<{ id: string }>(
    `select id from members
      where (email is not null and email = $1) or (email is null and phone_key is not null and phone_key = $2)
      order by (email = $1) desc nulls last limit 1 for update`,
    [p.email, key],
  );
  if (existing.rows[0]) {
    // Keep the previous state so an Undo / void of this door action can restore it (migration 012).
    await c.query(
      `update members
          set prev_valid_until = valid_until, prev_needs_review = needs_review, extended_at = now(),
              valid_until = greatest(valid_until, $2), needs_review = needs_review or $3, updated_at = now()
        where id = $1`,
      [existing.rows[0].id, validUntil, review],
    );
    return existing.rows[0].id;
  }
  const r = await c.query<{ id: string }>(
    `insert into members (full_name, email, phone, phone_key, valid_until, source, added_by_staff_id, needs_review)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [p.fullName, p.email, p.phone, key, validUntil, source, p.staff.id, review],
  );
  return r.rows[0].id;
}

// ---------------------------------------------------------------------------
// Import (paste from Excel / Google Sheets / CSV)
// ---------------------------------------------------------------------------

export interface ParsedMember {
  full_name: string;
  email: string | null;
  phone: string | null;
}

const NAME_HEADERS = ["name", "full name", "fullname", "nom", "nom et prénom", "nom et prenom", "nom complet", "prénom et nom", "prenom et nom", "الاسم"];
const FIRST_HEADERS = ["first name", "firstname", "prénom", "prenom"];
const LAST_HEADERS = ["last name", "lastname", "surname", "nom de famille"];
const EMAIL_HEADERS = ["email", "e-mail", "mail", "adresse email", "adresse mail", "email address"];
const PHONE_HEADERS = ["phone", "phone number", "tel", "tél", "téléphone", "telephone", "numéro", "numero", "mobile", "gsm", "الهاتف"];

function splitLine(line: string, sep: string): string[] {
  if (sep === "\t") return line.split("\t").map((c) => c.trim());
  // CSV with quotes
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) out.push(cur.trim()), (cur = "");
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Split pasted spreadsheet text (tab, comma or semicolon separated) into rows of cells. */
export function parseTable(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes("\t") ? "\t" : lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";
  return lines.map((l) => splitLine(l, sep));
}

/**
 * Parse rows pasted from a spreadsheet (tab-separated) or a CSV (comma or
 * semicolon). A header row is recognised in English, French or Arabic; with no
 * header, columns are guessed from their content.
 */
export function parseMemberList(text: string): { rows: ParsedMember[]; skipped: number } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], skipped: 0 };
  const sep = lines[0].includes("\t") ? "\t" : lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";
  const first = splitLine(lines[0], sep).map((h) => h.toLowerCase().replace(/\s+/g, " ").trim());
  const find = (names: string[]) => first.findIndex((h) => names.includes(h));
  let nameIdx = find(NAME_HEADERS);
  const firstIdx = find(FIRST_HEADERS);
  const lastIdx = find(LAST_HEADERS);
  let emailIdx = find(EMAIL_HEADERS);
  let phoneIdx = find(PHONE_HEADERS);
  const hasHeader = nameIdx >= 0 || emailIdx >= 0 || phoneIdx >= 0 || firstIdx >= 0;
  const body = hasHeader ? lines.slice(1) : lines;

  if (!hasHeader) {
    // Guess from the first data row: the email-looking cell, the phone-looking cell, the rest is the name.
    const cells = splitLine(lines[0], sep);
    emailIdx = cells.findIndex((c) => looksLikeEmail(c.toLowerCase()));
    phoneIdx = cells.findIndex((c, i) => i !== emailIdx && phoneKey(c) !== null && !/[a-z]/i.test(c));
    nameIdx = cells.findIndex((c, i) => i !== emailIdx && i !== phoneIdx && c.length > 0);
  }

  const rows: ParsedMember[] = [];
  let skipped = 0;
  for (const line of body) {
    const cells = splitLine(line, sep);
    let name = nameIdx >= 0 ? cells[nameIdx] : "";
    if (!name && (firstIdx >= 0 || lastIdx >= 0)) name = [cells[firstIdx] ?? "", cells[lastIdx] ?? ""].join(" ");
    const full_name = cleanText(name, 200);
    const email = emailIdx >= 0 ? normalizeEmail(cells[emailIdx]) : null;
    const phone = phoneIdx >= 0 ? cleanText(cells[phoneIdx], 40) : null;
    if (!full_name || (!email && !phoneKey(phone) && !full_name)) {
      skipped++;
      continue;
    }
    rows.push({ full_name, email: email && looksLikeEmail(email) ? email : null, phone });
  }
  return { rows, skipped };
}

export async function importMembers(
  admin: Staff,
  rows: ParsedMember[],
  validUntil: string,
): Promise<{ added: number; updated: number }> {
  if (!isIsoDate(validUntil)) throw new HttpError(400, "BAD_DATE", "Valid until must be a date (YYYY-MM-DD).");
  if (rows.length > 5000) throw new HttpError(400, "TOO_MANY", "Import at most 5000 members at a time.");
  return withTransaction(async (c) => {
    let added = 0;
    let updated = 0;
    for (const r of rows) {
      const key = phoneKey(r.phone);
      const match = await c.query<{ id: string }>(
        `select id from members
          where ($1::text is not null and email = $1)
             or ($1::text is null and $2::text is not null and phone_key = $2)
             or ($1::text is null and $2::text is null and lower(full_name) = lower($3))
          limit 1`,
        [r.email, key, r.full_name],
      );
      if (match.rows[0]) {
        await c.query(
          `update members set full_name = $2, phone = coalesce($3, phone), phone_key = coalesce($4, phone_key),
                  valid_until = greatest(valid_until, $5), updated_at = now() where id = $1`,
          [match.rows[0].id, r.full_name, r.phone, key, validUntil],
        );
        updated++;
      } else {
        await c.query(
          `insert into members (full_name, email, phone, phone_key, valid_until, source, added_by_staff_id)
           values ($1, $2, $3, $4, $5, 'import', $6)`,
          [r.full_name, r.email, r.phone, key, validUntil, admin.id],
        );
        added++;
      }
    }
    await audit({ staffId: admin.id, action: "import_members", details: { added, updated, valid_until: validUntil } }, c);
    return { added, updated };
  });
}

export async function searchMembers(q: string, limit = 30) {
  const term = q.trim().slice(0, 100);
  const like = `%${term.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const key = term.replace(/\D/g, "");
  const r = await query<MemberRow & { created_at: string }>(
    `select id, full_name, email, phone, valid_until, source, created_at from members
      where $1 = '' or full_name ilike $2 or email ilike $2 or (length($3) >= 4 and phone_key like '%' || $3 || '%')
      order by lower(full_name)
      limit $4`,
    [term, like, key.slice(-8), limit],
  );
  return r.rows;
}

export async function memberCounts(onDate: string) {
  const r = await query<{ total: number; valid: number }>(
    "select count(*)::int as total, count(*) filter (where valid_until >= $1)::int as valid from members",
    [onDate],
  );
  return r.rows[0];
}

export async function addMember(admin: Staff, body: Record<string, unknown>) {
  const full_name = cleanText(body.full_name, 200);
  if (!full_name) throw new HttpError(400, "BAD_REQUEST", "Name is required.");
  const email = normalizeEmail(body.email);
  if (email && !looksLikeEmail(email)) throw new HttpError(400, "BAD_EMAIL", "That email address doesn't look right.");
  const phone = cleanText(body.phone, 40);
  const validUntil = body.valid_until ? String(body.valid_until) : defaultValidUntil();
  if (!isIsoDate(validUntil)) throw new HttpError(400, "BAD_DATE", "Valid until must be a date.");
  try {
    return await withTransaction(async (c) => {
      const r = await c.query<{ id: string }>(
        `insert into members (full_name, email, phone, phone_key, valid_until, source, added_by_staff_id)
         values ($1, $2, $3, $4, $5, 'manual', $6) returning id`,
        [full_name, email, phone, phoneKey(phone), validUntil, admin.id],
      );
      await audit({ staffId: admin.id, action: "add_member", details: { member_id: r.rows[0].id, full_name, email } }, c);
      return { id: r.rows[0].id };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new HttpError(409, "MEMBER_EXISTS", "A member with this email already exists.");
    throw err;
  }
}

export async function deleteMember(admin: Staff, id: string) {
  return withTransaction(async (c) => {
    const r = await c.query<{ full_name: string }>("delete from members where id = $1 returning full_name", [id]);
    if (!r.rows[0]) throw new HttpError(404, "MEMBER_NOT_FOUND", "Member not found.");
    await audit({ staffId: admin.id, action: "delete_member", details: { member_id: id, full_name: r.rows[0].full_name } }, c);
    return { ok: true };
  });
}

/** HR: "this person is a member" — link an attendee to a membership record. */
export async function linkAttendeeToMember(staff: Staff, attendeeId: string, memberId: string) {
  return withTransaction(async (c) => {
    const m = await c.query<{ full_name: string; valid_until: string }>("select full_name, valid_until from members where id = $1", [memberId]);
    if (!m.rows[0]) throw new HttpError(404, "MEMBER_NOT_FOUND", "Member not found.");
    const a = await c.query<{ event_id: string }>("update attendees set member_id = $2, updated_at = now() where id = $1 returning event_id", [attendeeId, memberId]);
    if (!a.rows[0]) throw new HttpError(404, "ATTENDEE_NOT_FOUND", "Attendee not found.");
    await audit({ staffId: staff.id, action: "link_member", eventId: a.rows[0].event_id, attendeeId, details: { member_id: memberId, member_name: m.rows[0].full_name } }, c);
    return { ok: true, valid_until: m.rows[0].valid_until };
  });
}

// ---------------------------------------------------------------------------
// Review of "already a member" claims made at the door
// ---------------------------------------------------------------------------

export async function membersToReview() {
  const r = await query<MemberRow & { needs_review: boolean; created_at: string; updated_at: string; claimed_by: string | null; events: string | null }>(
    `select m.id, m.full_name, m.email, m.phone, m.valid_until, m.source, m.needs_review, m.created_at, m.updated_at,
            s.name as claimed_by,
            (select string_agg(distinct e.name, ', ') from attendees a join events e on e.id = a.event_id where a.member_id = m.id) as events
       from members m left join staff s on s.id = m.added_by_staff_id
      where m.needs_review
      order by m.updated_at desc`,
  );
  return r.rows;
}

/** confirm: keep the membership. reject: end it now (they'll be asked to pay next time). */
export async function reviewMember(admin: Staff, id: string, decision: "confirm" | "reject") {
  return withTransaction(async (c) => {
    const cur = await c.query<{ full_name: string; source: string }>("select full_name, source from members where id = $1 and needs_review for update", [id]);
    const m = cur.rows[0];
    if (!m) throw new HttpError(404, "NOT_TO_REVIEW", "This membership isn't waiting for review.");
    if (decision === "confirm") {
      await c.query("update members set needs_review = false, updated_at = now() where id = $1", [id]);
    } else if (m.source === "claimed") {
      await c.query("delete from members where id = $1", [id]); // attendees.member_id → null
    } else {
      // An older record that was extended by the claim: expire it again.
      await c.query("update members set needs_review = false, valid_until = current_date - 1, prev_valid_until = null, prev_needs_review = null, extended_at = null, updated_at = now() where id = $1", [id]);
    }
    await audit({ staffId: admin.id, action: decision === "confirm" ? "confirm_member" : "reject_member", details: { member_id: id, full_name: m.full_name } }, c);
    return { ok: true };
  });
}
