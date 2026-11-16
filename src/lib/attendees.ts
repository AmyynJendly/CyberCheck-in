import type { PoolClient } from "pg";
import { query, withTransaction, isUniqueViolation } from "./db";
import { audit } from "./audit";
import { HttpError } from "./http";
import { newQrToken, newShortCode } from "./ids";
import { insertCheckin, insertPaymentTx, isDayFull, paymentOptions, type PaymentKind, type PaymentOption } from "./checkin";
import { findValidMembership, grantMembershipTx } from "./members";
import { dayLabel, requireEvent, resolveEventDay } from "./events";
import { cleanText, looksLikeEmail, normalizeEmail } from "./validate";
import type { Staff } from "./auth";

export interface AttendeeFields {
  full_name: string;
  email: string | null;
  phone: string | null;
  class_year: string | null;
  team_name: string | null;
}

export function cleanAttendeeFields(body: Record<string, unknown>): AttendeeFields {
  const full_name = cleanText(body.full_name, 200);
  if (!full_name) throw new HttpError(400, "BAD_REQUEST", "Full name is required.");
  return {
    full_name,
    email: normalizeEmail(body.email),
    phone: cleanText(body.phone, 40),
    class_year: cleanText(body.class_year, 80),
    team_name: cleanText(body.team_name, 120),
  };
}

/**
 * Run an INSERT that needs a fresh qr_token + short_code, retrying on the
 * (astronomically rare) collision. Uses a savepoint so the surrounding
 * transaction survives the retry.
 */
async function insertWithCodes<T>(
  client: PoolClient,
  run: (qrToken: string, shortCode: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await client.query("savepoint codes");
    try {
      const result = await run(newQrToken(), newShortCode());
      await client.query("release savepoint codes");
      return result;
    } catch (err) {
      await client.query("rollback to savepoint codes");
      const codeClash =
        isUniqueViolation(err, "attendees_event_id_short_code_key") || isUniqueViolation(err, "attendees_qr_token_key");
      if (!codeClash || attempt >= 5) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Google Form ingestion
// ---------------------------------------------------------------------------

export type IngestOutcome = "created" | "updated" | "duplicate_response";

export interface IngestResult {
  outcome: IngestOutcome;
  attendeeId: string;
  /** true when the QR email should (re)go out. */
  sendEmail: boolean;
}

/**
 * Idempotent on response_id (form_submissions PK), deduplicated on email
 * (attendees_event_email_uniq). Safe under concurrent duplicate posts.
 */
export async function ingestFormSubmission(eventId: string, responseId: string, fields: AttendeeFields): Promise<IngestResult> {
  return withTransaction(async (c) => {
    // Claim the response id. A concurrent duplicate blocks here until we commit, then gets nothing.
    const claim = await c.query(
      `insert into form_submissions (event_id, response_id) values ($1, $2)
       on conflict do nothing returning response_id`,
      [eventId, responseId],
    );
    if (!claim.rowCount) {
      const prev = await c.query<{ attendee_id: string | null }>(
        "select attendee_id from form_submissions where event_id = $1 and response_id = $2",
        [eventId, responseId],
      );
      const attendeeId = prev.rows[0]?.attendee_id;
      if (!attendeeId) throw new Error(`form_submissions row without attendee for ${responseId}`);
      await audit({ action: "form_submit", eventId, attendeeId, details: { response_id: responseId, outcome: "duplicate_response" } }, c);
      return { outcome: "duplicate_response" as const, attendeeId, sendEmail: false };
    }

    const emailStatus = fields.email ? "pending" : "none";
    const row = await insertWithCodes(c, async (qrToken, shortCode) => {
      const r = await c.query<{ id: string; inserted: boolean }>(
        `insert into attendees
           (event_id, full_name, email, phone, class_year, team_name, source,
            form_response_id, qr_token, short_code, email_status)
         values ($1, $2, $3, $4, $5, $6, 'form', $7, $8, $9, $10)
         on conflict (event_id, email) where email is not null do update set
           full_name        = excluded.full_name,
           phone            = coalesce(excluded.phone, attendees.phone),
           class_year       = coalesce(excluded.class_year, attendees.class_year),
           team_name        = coalesce(excluded.team_name, attendees.team_name),
           form_response_id = coalesce(attendees.form_response_id, excluded.form_response_id),
           email_status     = 'pending',
           email_error      = null,
           updated_at       = now()
         returning id, (xmax = 0) as inserted`,
        [eventId, fields.full_name, fields.email, fields.phone, fields.class_year, fields.team_name, responseId, qrToken, shortCode, emailStatus],
      );
      return r.rows[0];
    });

    await c.query("update form_submissions set attendee_id = $3 where event_id = $1 and response_id = $2", [eventId, responseId, row.id]);
    const outcome: IngestOutcome = row.inserted ? "created" : "updated";
    await audit({ action: "form_submit", eventId, attendeeId: row.id, details: { response_id: responseId, outcome } }, c);
    return { outcome, attendeeId: row.id, sendEmail: !!fields.email };
  });
}

// ---------------------------------------------------------------------------
// Walk-ins: create + check in for today, in one transaction.
// ---------------------------------------------------------------------------

class EmailTaken extends Error {}

export type WalkInResult =
  | {
      status: "OK";
      attendee_id: string;
      checkin_id: string;
      name: string;
      short_code: string;
      day_label: string;
      email_queued: boolean;
      is_member: boolean;
      payment: { kind: PaymentKind; amount: number } | null;
    }
  | { status: "NO_EVENT_DAY" }
  | { status: "PAYMENT_REQUIRED"; name: string; day_label: string; options: PaymentOption[] }
  | { status: "FULL"; name: string; day_label: string; capacity: number; checked_in: number }
  | { status: "EMAIL_EXISTS"; attendee_id: string; name: string };

/**
 * Create a walk-in and check them in for today, in one transaction. On a paid
 * day a non-member first gets PAYMENT_REQUIRED (nothing is created); calling
 * again with `payment` records the cash, the membership if any, and the check-in.
 */
export async function createWalkIn(opts: {
  eventId: string;
  staff: Staff;
  fields: AttendeeFields;
  payment?: PaymentKind | null;
  overrideDayId?: string | null;
  now?: Date;
}): Promise<WalkInResult> {
  const { eventId, staff, fields } = opts;
  const event = await requireEvent(eventId, { active: true });
  if (fields.email && !looksLikeEmail(fields.email)) {
    throw new HttpError(400, "BAD_EMAIL", "That email address doesn't look right.");
  }
  const day = await resolveEventDay(eventId, opts);
  if (!day) return { status: "NO_EVENT_DAY" };

  const capacity = day.capacity ?? null;
  const full = async () => {
    const n = await query<{ n: number }>("select seats_taken as n from event_days where id = $1", [day.id]);
    return { status: "FULL" as const, name: fields.full_name, day_label: dayLabel(day), capacity: capacity ?? 0, checked_in: n.rows[0].n };
  };
  if (capacity) {
    const f = await full();
    if (f.checked_in >= capacity) return f; // say so before asking for money
  }
  const member = await findValidMembership({ email: fields.email, phone: fields.phone }, day.day_date);
  const access = { ok: day.access === "free" || !!member, memberId: member?.id ?? null };
  let option: PaymentOption | null = null;
  if (!access.ok) {
    const options = paymentOptions(day, event.membership_fee);
    if (!opts.payment) return { status: "PAYMENT_REQUIRED", name: fields.full_name, day_label: dayLabel(day), options };
    option = options.find((o) => o.kind === opts.payment) ?? null;
    if (!option) throw new HttpError(400, "PAYMENT_NOT_ALLOWED", "That payment isn't offered on this day.");
  }

  try {
    return await withTransaction(async (c) => {
      const a = await insertWithCodes(c, async (qrToken, shortCode) => {
        try {
          const r = await c.query<{ id: string; short_code: string }>(
            `insert into attendees
               (event_id, full_name, email, phone, class_year, team_name, source,
                added_by_staff_id, qr_token, short_code, email_status, member_id)
             values ($1, $2, $3, $4, $5, $6, 'walk_in', $7, $8, $9, $10, $11)
             returning id, short_code`,
            [eventId, fields.full_name, fields.email, fields.phone, fields.class_year, fields.team_name, staff.id, qrToken, shortCode, fields.email ? "pending" : "none", access.memberId],
          );
          return r.rows[0];
        } catch (err) {
          if (isUniqueViolation(err, "attendees_event_email_uniq")) throw new EmailTaken();
          throw err;
        }
      });
      // Takes a seat (DB trigger); a full day throws DAY_FULL and rolls back the new attendee too.
      const ci = await insertCheckin(c, { attendeeId: a.id, eventId, day, staff, method: "walk_in" });
      let isMember = !!access.memberId;
      if (option) {
        let memberId: string | null = null;
        if (option.kind === "membership") {
          memberId = await grantMembershipTx(c, { fullName: fields.full_name, email: fields.email, phone: fields.phone, staff });
          await c.query("update attendees set member_id = $2 where id = $1", [a.id, memberId]);
          isMember = true;
        }
        await insertPaymentTx(c, { eventId, day, attendeeId: a.id, staff, option, memberId });
      }
      return {
        status: "OK" as const,
        attendee_id: a.id,
        checkin_id: ci.id,
        name: fields.full_name,
        short_code: a.short_code,
        day_label: dayLabel(day),
        email_queued: !!fields.email,
        is_member: isMember,
        payment: option ? { kind: option.kind, amount: option.amount } : null,
      };
    });
  } catch (err) {
    if (isDayFull(err)) return full();
    if (!(err instanceof EmailTaken)) throw err;
    const r = await query<{ id: string; full_name: string }>(
      "select id, full_name from attendees where event_id = $1 and email = $2",
      [eventId, fields.email],
    );
    return { status: "EMAIL_EXISTS", attendee_id: r.rows[0]?.id ?? "", name: r.rows[0]?.full_name ?? "" };
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  class_year: string | null;
  team_name: string | null;
  short_code: string;
  source: "form" | "walk_in";
  email_status: "none" | "pending" | "sent" | "failed";
  email_error: string | null;
  checkin_id: string | null;
  checked_at: string | null;
  checked_by: string | null;
  member_id: string | null;
  member_valid_until: string | null;
}

export async function searchAttendees(eventId: string, q: string, dayId: string | null): Promise<SearchRow[]> {
  const term = q.trim().slice(0, 100);
  if (!term) return [];
  const like = `%${term.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const digits = term.replace(/\D/g, "");
  const r = await query<SearchRow>(
    `select a.id, a.full_name, a.email, a.phone, a.class_year, a.team_name, a.short_code, a.source,
            a.email_status, a.email_error,
            c.id as checkin_id, c.checked_at, s.name as checked_by,
            m.id as member_id, m.valid_until as member_valid_until
       from attendees a
       left join checkins c on c.attendee_id = a.id and c.event_day_id = $3 and c.undone_at is null
       left join staff s on s.id = c.staff_id
       left join lateral (
         select id, valid_until from members m
          where m.valid_until >= current_date
            and (m.id = a.member_id or (a.email is not null and m.email = a.email)
                 or (m.phone_key is not null and m.phone_key = right(regexp_replace(coalesce(a.phone, ''), '\\D', '', 'g'), 8)))
          order by (m.id = a.member_id) desc nulls last limit 1
       ) m on true
      where a.event_id = $1
        and (a.full_name ilike $2 or a.email ilike $2 or a.phone ilike $2 or a.team_name ilike $2
             or a.short_code = upper($4)
             or (length($5) >= 3 and regexp_replace(coalesce(a.phone, ''), '\\D', '', 'g') like '%' || $5 || '%'))
      order by (a.short_code = upper($4)) desc, lower(a.full_name)
      limit 30`,
    [eventId, like, dayId, term, digits],
  );
  return r.rows;
}

/** Fix a typo'd email. Returns the updated email. */
export async function updateAttendeeEmail(attendeeId: string, rawEmail: unknown, staff: Staff): Promise<string> {
  const email = normalizeEmail(rawEmail);
  if (!email || !looksLikeEmail(email)) throw new HttpError(400, "BAD_EMAIL", "That email address doesn't look right.");
  return withTransaction(async (c) => {
    const cur = await c.query<{ email: string | null; event_id: string }>(
      "select email, event_id from attendees where id = $1 for update",
      [attendeeId],
    );
    const a = cur.rows[0];
    if (!a) throw new HttpError(404, "ATTENDEE_NOT_FOUND", "Attendee not found.");
    if (a.email === email) return email;
    try {
      await c.query("savepoint e");
      await c.query("update attendees set email = $2, email_status = 'pending', email_error = null, updated_at = now() where id = $1", [attendeeId, email]);
    } catch (err) {
      await c.query("rollback to savepoint e");
      if (isUniqueViolation(err, "attendees_event_email_uniq")) {
        throw new HttpError(409, "EMAIL_EXISTS", "Another attendee of this event already uses that email.");
      }
      throw err;
    }
    await audit({ staffId: staff.id, action: "edit_email", eventId: a.event_id, attendeeId, details: { from: a.email, to: email } }, c);
    return email;
  });
}
