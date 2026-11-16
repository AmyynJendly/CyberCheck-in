// POST /api/auth/login  { pin } — the PIN alone says who is signing in.
import type { NextRequest } from "next/server";
import { isUniqueViolation, query } from "@/lib/db";
import { HttpError, json, readJson, route, assertSameOrigin } from "@/lib/http";
import { burnPinCheck, isValidPin, pinLookup, verifyPin } from "@/lib/pin";
import { auditSafe } from "@/lib/audit";
import { signSession, type Role } from "@/lib/session";
import { setSessionCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A wrong guess can't be pinned on one account any more, so guesses are limited
// per device (IP) and across the whole app. With ~10 six-digit PINs, the global
// cap keeps a determined guesser well under 1% a day.
const IP_LIMIT = 5;
const IP_WINDOW_MIN = 15;
const GLOBAL_LIMIT = 20;
const GLOBAL_WINDOW_MIN = 60;

type StaffRow = { id: string; name: string; role: Role; pin_hash: string };

function clientIp(req: NextRequest): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Count this attempt in the key's window (atomic, so parallel guesses can't slip past). Returns null if over the limit. */
async function reserve(key: string, limit: number, windowMin: number): Promise<{ attempts: number } | null> {
  const r = await query<{ attempts: number }>(
    `insert into login_throttle as t (key, attempts, window_start) values ($1, 1, now())
     on conflict (key) do update set
       attempts     = case when t.window_start <= now() - make_interval(mins => $2) then 1 else t.attempts + 1 end,
       window_start = case when t.window_start <= now() - make_interval(mins => $2) then now() else t.window_start end
     returning attempts`,
    [key, windowMin],
  );
  return r.rows[0].attempts > limit ? null : r.rows[0];
}

async function findStaff(pin: string): Promise<StaffRow | null> {
  const lookup = pinLookup(pin);
  const r = await query<StaffRow>("select id, name, role, pin_hash from staff where pin_lookup = $1 and is_active", [lookup]);
  if (r.rows[0]) return (await verifyPin(pin, r.rows[0].pin_hash)) ? r.rows[0] : null;

  // Accounts from before PIN-only login have no lookup yet: check them once, then store it.
  const legacy = await query<StaffRow>("select id, name, role, pin_hash from staff where pin_lookup is null and is_active");
  for (const s of legacy.rows) {
    if (!(await verifyPin(pin, s.pin_hash))) continue;
    try {
      await query("update staff set pin_lookup = $2 where id = $1", [s.id, lookup]);
    } catch (err) {
      if (isUniqueViolation(err, "staff_pin_lookup_key")) {
        throw new HttpError(409, "PIN_SHARED", "This PIN is used by another account. Ask an admin to give you a new PIN.");
      }
      throw err;
    }
    return s;
  }
  return null;
}

export const POST = route(async (req) => {
  assertSameOrigin(req);
  const body = await readJson(req);
  const pin = body.pin;
  if (!isValidPin(pin)) throw new HttpError(400, "BAD_PIN_FORMAT", "The PIN is 6 digits.");

  const ip = clientIp(req);
  // Per device first: a blocked device doesn't use up the app-wide allowance.
  if (!(await reserve(`ip:${ip}`, IP_LIMIT, IP_WINDOW_MIN))) {
    await auditSafe({ action: "login_failed", details: { reason: "throttled_ip", ip } });
    throw new HttpError(429, "TOO_MANY_TRIES", `Too many wrong PINs from this phone. Wait ${IP_WINDOW_MIN} minutes or ask an admin.`);
  }
  if (!(await reserve("global", GLOBAL_LIMIT, GLOBAL_WINDOW_MIN))) {
    await auditSafe({ action: "login_failed", details: { reason: "throttled_global", ip } });
    throw new HttpError(429, "TOO_MANY_TRIES", "Too many wrong PINs on the app right now. Try again later or ask an admin.");
  }

  const staff = await findStaff(pin);
  if (!staff) {
    await burnPinCheck(pin);
    await auditSafe({ action: "login_failed", details: { reason: "wrong_pin", ip } });
    throw new HttpError(401, "INVALID_PIN", "Wrong PIN.");
  }

  // A success isn't a guess: give the attempts back.
  await query(
    `update login_throttle set attempts = case when key = 'global' then greatest(attempts - 1, 0) else 0 end
      where key = any($1)`,
    [[`ip:${ip}`, "global"]],
  );
  await auditSafe({ staffId: staff.id, action: "login", details: { ip } });
  const token = await signSession({ sid: staff.id, role: staff.role, name: staff.name });
  const res = json({ ok: true, staff: { id: staff.id, name: staff.name, role: staff.role } });
  setSessionCookie(res, token);
  return res;
});
