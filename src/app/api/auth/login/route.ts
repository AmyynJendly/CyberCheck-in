// POST /api/auth/login  { staff_id, pin }
import { query } from "@/lib/db";
import { HttpError, json, readJson, route, assertSameOrigin } from "@/lib/http";
import { isUuid } from "@/lib/ids";
import { burnPinCheck, isValidPin, verifyPin } from "@/lib/pin";
import { auditSafe } from "@/lib/audit";
import { signSession, type Role } from "@/lib/session";
import { setSessionCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 10;

function lockedError(lockedUntil: string | Date | null) {
  return new HttpError(423, "LOCKED", `Too many wrong PINs. Try again in ${LOCK_MINUTES} minutes or ask an admin.`, {
    locked_until: lockedUntil,
  });
}

export const POST = route(async (req) => {
  assertSameOrigin(req);
  const body = await readJson(req);
  const staffId = body.staff_id;
  const pin = body.pin;
  if (!isValidPin(pin)) throw new HttpError(400, "BAD_PIN_FORMAT", "The PIN is 6 digits.");
  if (!isUuid(staffId)) throw new HttpError(400, "BAD_REQUEST", "Pick your name first.");

  // Reserve an attempt atomically *before* checking the PIN, so parallel
  // guesses can never get more than MAX_ATTEMPTS tries per lock window.
  const reserved = await query<{ id: string; name: string; role: Role; pin_hash: string; failed_attempts: number }>(
    `update staff set failed_attempts = failed_attempts + 1
      where id = $1 and is_active and (locked_until is null or locked_until <= now())
      returning id, name, role, pin_hash, failed_attempts`,
    [staffId],
  );
  const staff = reserved.rows[0];

  if (!staff) {
    const cur = await query<{ is_active: boolean; locked_until: string | null }>("select is_active, locked_until from staff where id = $1", [staffId]);
    const row = cur.rows[0];
    if (row?.is_active) {
      await auditSafe({ staffId, action: "login_failed", details: { reason: "locked" } });
      throw lockedError(row.locked_until);
    }
    await burnPinCheck(pin);
    await auditSafe({ action: "login_failed", details: { reason: "unknown_or_inactive_staff", staff_id: staffId } });
    throw new HttpError(401, "INVALID_PIN", "Wrong name or PIN.");
  }

  if (staff.failed_attempts > MAX_ATTEMPTS) {
    // Only reachable with parallel requests racing past the limit.
    const l = await query<{ locked_until: string }>(
      `update staff set locked_until = now() + make_interval(mins => $2), failed_attempts = 0 where id = $1 returning locked_until`,
      [staff.id, LOCK_MINUTES],
    );
    await auditSafe({ staffId: staff.id, action: "login_failed", details: { reason: "locked" } });
    throw lockedError(l.rows[0]?.locked_until ?? null);
  }

  const ok = await verifyPin(pin, staff.pin_hash);
  if (!ok) {
    if (staff.failed_attempts >= MAX_ATTEMPTS) {
      const l = await query<{ locked_until: string }>(
        `update staff set locked_until = now() + make_interval(mins => $2), failed_attempts = 0 where id = $1 returning locked_until`,
        [staff.id, LOCK_MINUTES],
      );
      await auditSafe({ staffId: staff.id, action: "login_failed", details: { reason: "wrong_pin", attempt: staff.failed_attempts, locked: true } });
      throw lockedError(l.rows[0]?.locked_until ?? null);
    }
    await auditSafe({ staffId: staff.id, action: "login_failed", details: { reason: "wrong_pin", attempt: staff.failed_attempts } });
    throw new HttpError(401, "INVALID_PIN", "Wrong PIN.", { attempts_left: MAX_ATTEMPTS - staff.failed_attempts });
  }

  await query("update staff set failed_attempts = 0, locked_until = null where id = $1", [staff.id]);
  await auditSafe({ staffId: staff.id, action: "login" });
  const token = await signSession({ sid: staff.id, role: staff.role, name: staff.name });
  const res = json({ ok: true, staff: { id: staff.id, name: staff.name, role: staff.role } });
  setSessionCookie(res, token);
  return res;
});
