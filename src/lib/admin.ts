import { query, withTransaction, isUniqueViolation, type Queryable } from "./db";
import { audit } from "./audit";
import { HttpError } from "./http";
import { newFormSecret } from "./ids";
import { isIsoDate } from "./time";
import { cleanText } from "./validate";
import { hashPin, isValidPin, pinLookup } from "./pin";
import type { Staff } from "./auth";
import { DAY_ACCESS, type DayAccess } from "./events";

function cleanAccess(v: unknown): DayAccess {
  if (v === undefined || v === null || v === "") return "free";
  if (!DAY_ACCESS.includes(v as DayAccess)) throw new HttpError(400, "BAD_ACCESS", "Access must be free, members or members_or_fee.");
  return v as DayAccess;
}

function cleanCapacity(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100000) throw new HttpError(400, "BAD_CAPACITY", "Capacity must be a whole number of seats (or empty for no limit).");
  return n;
}

function cleanFee(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new HttpError(400, "BAD_FEE", `${field} must be an amount in DT.`);
  return Math.round(n * 100) / 100;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function cleanSlug(v: unknown): string {
  const s = cleanText(v, 63)?.toLowerCase();
  if (!s || !SLUG_RE.test(s)) {
    throw new HttpError(400, "BAD_SLUG", "Slug: 2–63 chars, lowercase letters, digits and dashes (e.g. mini-ctf-2026).");
  }
  return s;
}

export function cleanDay(v: unknown): { day_date: string; label: string | null; access: DayAccess; entry_fee: number; capacity: number | null } {
  const d = v as { day_date?: unknown; label?: unknown; access?: unknown; entry_fee?: unknown; capacity?: unknown };
  if (!isIsoDate(d?.day_date)) throw new HttpError(400, "BAD_DATE", "Day dates must be YYYY-MM-DD.");
  return {
    day_date: d.day_date as string,
    label: cleanText(d.label, 60),
    access: cleanAccess(d.access),
    entry_fee: d.entry_fee === undefined || d.entry_fee === "" ? 5 : cleanFee(d.entry_fee, "Entry fee"),
    capacity: cleanCapacity(d.capacity),
  };
}

export async function listAdminEvents() {
  const r = await query(
    `select e.id, e.slug, e.name, e.location, e.form_secret, e.is_active, e.created_at, e.membership_fee,
            e.email_subject, e.email_body, e.email_tagline, e.email_design,
            e.email_auto_send, e.email_auto_every, e.email_auto_last_run,
            coalesce(json_agg(json_build_object('id', d.id, 'day_date', d.day_date, 'label', d.label,
                     'access', d.access, 'entry_fee', d.entry_fee, 'capacity', d.capacity,
                     'checkins', (select count(*) from checkins c where c.event_day_id = d.id and c.undone_at is null))
                     order by d.day_date) filter (where d.id is not null), '[]') as days,
            (select count(*) from attendees a where a.event_id = e.id)::int as attendees
       from events e left join event_days d on d.event_id = e.id
      group by e.id
      order by e.created_at desc`,
  );
  return r.rows;
}

export async function createEvent(staff: Staff, body: Record<string, unknown>) {
  const slug = cleanSlug(body.slug);
  const name = cleanText(body.name, 200);
  if (!name) throw new HttpError(400, "BAD_REQUEST", "Event name is required.");
  const location = cleanText(body.location, 200);
  const days = Array.isArray(body.days) ? body.days.map(cleanDay) : [];
  const membershipFee = body.membership_fee === undefined || body.membership_fee === "" ? 15 : cleanFee(body.membership_fee, "Membership fee");
  try {
    return await withTransaction(async (c) => {
      const r = await c.query<{ id: string }>(
        "insert into events (slug, name, location, form_secret, membership_fee) values ($1, $2, $3, $4, $5) returning id",
        [slug, name, location, newFormSecret(), membershipFee],
      );
      const id = r.rows[0].id;
      for (const [i, d] of days.entries()) {
        await c.query(
          "insert into event_days (event_id, day_date, label, access, entry_fee, capacity) values ($1, $2, $3, $4, $5, $6)",
          [id, d.day_date, d.label ?? `Day ${i + 1}`, d.access, d.entry_fee, d.capacity],
        );
      }
      await audit({ staffId: staff.id, action: "create_event", eventId: id, details: { slug, name, location, days } }, c);
      return { id };
    });
  } catch (err) {
    if (isUniqueViolation(err, "events_slug_key")) throw new HttpError(409, "SLUG_TAKEN", "Another event already uses that slug.");
    if (isUniqueViolation(err, "event_days_event_id_day_date_key")) throw new HttpError(409, "DUPLICATE_DAY", "The same date is listed twice.");
    throw err;
  }
}

export async function updateEvent(staff: Staff, id: string, body: Record<string, unknown>) {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const changes: Record<string, unknown> = {};
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changes[col] = val;
  };
  if (body.name !== undefined) {
    const name = cleanText(body.name, 200);
    if (!name) throw new HttpError(400, "BAD_REQUEST", "Event name can't be empty.");
    add("name", name);
  }
  if (body.slug !== undefined) add("slug", cleanSlug(body.slug));
  if (body.location !== undefined) add("location", cleanText(body.location, 200));
  if (body.is_active !== undefined) add("is_active", !!body.is_active);
  if (body.membership_fee !== undefined) add("membership_fee", cleanFee(body.membership_fee, "Membership fee"));
  if (body.email_subject !== undefined) add("email_subject", typeof body.email_subject === "string" && body.email_subject.trim() ? body.email_subject.trim().slice(0, 300) : null);
  if (body.email_body !== undefined) add("email_body", typeof body.email_body === "string" && body.email_body.trim() ? body.email_body.slice(0, 20000) : null);
  if (body.email_design !== undefined) {
    if (body.email_design !== null && body.email_design !== "borderland" && body.email_design !== "classic") throw new HttpError(400, "BAD_DESIGN", "Design must be borderland or classic.");
    add("email_design", body.email_design);
  }
  if (body.email_auto_send !== undefined) add("email_auto_send", body.email_auto_send === true);
  if (body.email_auto_every !== undefined) {
    const every = Number(body.email_auto_every);
    if (!Number.isInteger(every) || every < 1 || every > 1440) throw new HttpError(400, "BAD_INTERVAL", "Auto-send interval must be 1 to 1440 minutes.");
    add("email_auto_every", every);
  }
  if (body.email_tagline !== undefined) add("email_tagline", typeof body.email_tagline === "string" && body.email_tagline.trim() ? body.email_tagline.trim().slice(0, 120) : null);
  const regenerate = body.regenerate_secret === true;
  if (regenerate) {
    params.push(newFormSecret());
    sets.push(`form_secret = $${params.length}`);
  }
  if (!sets.length) throw new HttpError(400, "BAD_REQUEST", "Nothing to update.");
  try {
    return await withTransaction(async (c) => {
      const r = await c.query(`update events set ${sets.join(", ")} where id = $1 returning id`, params);
      if (!r.rowCount) throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
      if (Object.keys(changes).length) await audit({ staffId: staff.id, action: "update_event", eventId: id, details: changes }, c);
      if (regenerate) await audit({ staffId: staff.id, action: "regenerate_form_secret", eventId: id }, c);
      return { ok: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, "events_slug_key")) throw new HttpError(409, "SLUG_TAKEN", "Another event already uses that slug.");
    throw err;
  }
}

export async function addDay(staff: Staff, eventId: string, body: Record<string, unknown>) {
  const d = cleanDay(body);
  try {
    return await withTransaction(async (c) => {
      const ev = await c.query("select 1 from events where id = $1", [eventId]);
      if (!ev.rowCount) throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
      const n = await c.query<{ n: number }>("select count(*)::int as n from event_days where event_id = $1", [eventId]);
      const r = await c.query<{ id: string }>(
        "insert into event_days (event_id, day_date, label, access, entry_fee, capacity) values ($1, $2, $3, $4, $5, $6) returning id",
        [eventId, d.day_date, d.label ?? `Day ${n.rows[0].n + 1}`, d.access, d.entry_fee, d.capacity],
      );
      await audit({ staffId: staff.id, action: "create_day", eventId, details: { day_id: r.rows[0].id, ...d } }, c);
      return { id: r.rows[0].id };
    });
  } catch (err) {
    if (isUniqueViolation(err, "event_days_event_id_day_date_key")) throw new HttpError(409, "DUPLICATE_DAY", "This event already has that date.");
    throw err;
  }
}

export async function updateDay(staff: Staff, eventId: string, dayId: string, body: Record<string, unknown>) {
  const sets: string[] = [];
  const params: unknown[] = [dayId, eventId];
  const changes: Record<string, unknown> = {};
  if (body.day_date !== undefined) {
    if (!isIsoDate(body.day_date)) throw new HttpError(400, "BAD_DATE", "Day dates must be YYYY-MM-DD.");
    params.push(body.day_date);
    sets.push(`day_date = $${params.length}`);
    changes.day_date = body.day_date;
  }
  if (body.label !== undefined) {
    params.push(cleanText(body.label, 60));
    sets.push(`label = $${params.length}`);
    changes.label = params[params.length - 1];
  }
  if (body.access !== undefined) {
    params.push(cleanAccess(body.access));
    sets.push(`access = $${params.length}`);
    changes.access = params[params.length - 1];
  }
  if (body.entry_fee !== undefined) {
    params.push(cleanFee(body.entry_fee, "Entry fee"));
    sets.push(`entry_fee = $${params.length}`);
    changes.entry_fee = params[params.length - 1];
  }
  if (body.capacity !== undefined) {
    params.push(cleanCapacity(body.capacity));
    sets.push(`capacity = $${params.length}`);
    changes.capacity = params[params.length - 1];
  }
  if (!sets.length) throw new HttpError(400, "BAD_REQUEST", "Nothing to update.");
  try {
    return await withTransaction(async (c) => {
      const r = await c.query(`update event_days set ${sets.join(", ")} where id = $1 and event_id = $2 returning id`, params);
      if (!r.rowCount) throw new HttpError(404, "DAY_NOT_FOUND", "Day not found.");
      await audit({ staffId: staff.id, action: "update_day", eventId, details: { day_id: dayId, ...changes } }, c);
      return { ok: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, "event_days_event_id_day_date_key")) throw new HttpError(409, "DUPLICATE_DAY", "This event already has that date.");
    throw err;
  }
}

export async function deleteDay(staff: Staff, eventId: string, dayId: string) {
  return withTransaction(async (c) => {
    const used = await c.query("select 1 from checkins where event_day_id = $1 limit 1", [dayId]);
    if (used.rowCount) throw new HttpError(409, "DAY_HAS_CHECKINS", "This day already has check-ins; it can't be deleted.");
    const r = await c.query<{ day_date: string }>("delete from event_days where id = $1 and event_id = $2 returning day_date", [dayId, eventId]);
    if (!r.rowCount) throw new HttpError(404, "DAY_NOT_FOUND", "Day not found.");
    await audit({ staffId: staff.id, action: "delete_day", eventId, details: { day_id: dayId, day_date: r.rows[0].day_date } }, c);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export async function listStaff() {
  const r = await query(
    `select id, name, role, is_active, created_at
       from staff order by is_active desc, lower(name)`,
  );
  return r.rows;
}

function cleanRole(v: unknown): "hr" | "admin" {
  if (v !== "hr" && v !== "admin") throw new HttpError(400, "BAD_ROLE", "Role must be hr or admin.");
  return v;
}

export async function createStaff(admin: Staff, body: Record<string, unknown>) {
  const name = cleanText(body.name, 80);
  if (!name) throw new HttpError(400, "BAD_REQUEST", "Name is required.");
  if (!isValidPin(body.pin)) throw new HttpError(400, "BAD_PIN_FORMAT", "PIN must be exactly 6 digits.");
  const role = body.role === undefined ? "hr" : cleanRole(body.role);
  const pinHash = await hashPin(body.pin);
  try {
    return await withTransaction(async (c) => {
      const r = await c.query<{ id: string }>("insert into staff (name, pin_hash, pin_lookup, role) values ($1, $2, $3, $4) returning id", [
        name,
        pinHash,
        pinLookup(body.pin as string),
        role,
      ]);
      await audit({ staffId: admin.id, action: "create_staff", details: { staff_id: r.rows[0].id, name, role } }, c);
      return { id: r.rows[0].id };
    });
  } catch (err) {
    throw pinTaken(err);
  }
}

/** The PIN is the login, so it must be unique. */
function pinTaken(err: unknown): unknown {
  return isUniqueViolation(err, "staff_pin_lookup_key")
    ? new HttpError(409, "PIN_TAKEN", "Someone else already has this PIN. Choose a different one.")
    : err;
}

/** Clear every "too many wrong PINs" block (per phone and app-wide). */
export async function clearLoginBlocks(admin: Staff) {
  const r = await query("delete from login_throttle");
  await audit({ staffId: admin.id, action: "clear_login_blocks", details: { cleared: r.rowCount } });
  return { ok: true };
}

async function activeAdminCount(c: Queryable): Promise<number> {
  const r = await c.query<{ n: number }>("select count(*)::int as n from staff where role = 'admin' and is_active");
  return r.rows[0].n;
}

export async function updateStaff(admin: Staff, id: string, body: Record<string, unknown>) {
  const pinHash = body.pin !== undefined ? (isValidPin(body.pin) ? await hashPin(body.pin) : null) : undefined;
  if (pinHash === null) throw new HttpError(400, "BAD_PIN_FORMAT", "PIN must be exactly 6 digits.");

  return withTransaction(async (c) => {
    // Serialize staff edits so the "keep one admin" rule can't be raced.
    await c.query("select pg_advisory_xact_lock(4207002)");
    const cur = await c.query<{ id: string; name: string; role: string; is_active: boolean }>(
      "select id, name, role, is_active from staff where id = $1 for update",
      [id],
    );
    const s = cur.rows[0];
    if (!s) throw new HttpError(404, "STAFF_NOT_FOUND", "Staff member not found.");

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };

    if (body.name !== undefined) {
      const name = cleanText(body.name, 80);
      if (!name) throw new HttpError(400, "BAD_REQUEST", "Name can't be empty.");
      set("name", name);
    }
    if (body.role !== undefined) {
      const role = cleanRole(body.role);
      if (id === admin.id && role !== "admin") throw new HttpError(400, "SELF_DEMOTE", "You can't remove your own admin role.");
      set("role", role);
    }
    if (body.is_active !== undefined) {
      if (id === admin.id && !body.is_active) throw new HttpError(400, "SELF_DEACTIVATE", "You can't deactivate yourself.");
      set("is_active", !!body.is_active);
    }
    if (pinHash) {
      set("pin_hash", pinHash);
      set("pin_lookup", pinLookup(body.pin as string));
    }
    if (!sets.length) throw new HttpError(400, "BAD_REQUEST", "Nothing to update.");

    try {
      await c.query(`update staff set ${sets.join(", ")} where id = $1`, params);
    } catch (err) {
      throw pinTaken(err);
    }
    if ((await activeAdminCount(c)) < 1) throw new HttpError(400, "LAST_ADMIN", "There must be at least one active admin.");

    const details: Record<string, unknown> = { staff_id: id, name: s.name };
    if (body.name !== undefined) details.new_name = body.name;
    if (body.role !== undefined) details.role = body.role;
    if (body.name !== undefined || body.role !== undefined) {
      await audit({ staffId: admin.id, action: "update_staff", details }, c);
    }
    if (pinHash) await audit({ staffId: admin.id, action: "reset_pin", details: { staff_id: id, name: s.name } }, c);
    if (body.is_active !== undefined && !!body.is_active !== s.is_active) {
      await audit({ staffId: admin.id, action: body.is_active ? "activate_staff" : "deactivate_staff", details: { staff_id: id, name: s.name } }, c);
    }
    return { ok: true };
  });
}
