import { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { hashPin, pinLookup } from "@/lib/pin";
import { newFormSecret } from "@/lib/ids";
import { signSession, SESSION_COOKIE } from "@/lib/session";
import { tunisDate } from "@/lib/time";
import type { Staff } from "@/lib/auth";

let n = 0;
export const uniq = (p = "x") => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Tunis calendar date `offset` days from now. */
export const dateIn = (offset: number) => tunisDate(new Date(Date.now() + offset * DAY_MS));

export async function makeEvent(opts: { days?: number[]; active?: boolean; name?: string } = {}) {
  const slug = uniq("ev");
  const secret = newFormSecret();
  const r = await query<{ id: string }>(
    "insert into events (slug, name, location, form_secret, is_active) values ($1, $2, 'ISSAT Sousse', $3, $4) returning id",
    [slug, opts.name ?? `Event ${slug}`, secret, opts.active ?? true],
  );
  const id = r.rows[0].id;
  const days: { id: string; day_date: string; label: string }[] = [];
  for (const [i, off] of (opts.days ?? [0]).entries()) {
    const d = await query<{ id: string }>(
      "insert into event_days (event_id, day_date, label) values ($1, $2, $3) returning id",
      [id, dateIn(off), `Day ${i + 1}`],
    );
    days.push({ id: d.rows[0].id, day_date: dateIn(off), label: `Day ${i + 1}` });
  }
  return { id, slug, secret, days, name: opts.name ?? `Event ${slug}` };
}

let pinHashCache: Promise<string> | undefined;
export const TEST_PIN = "246810";

/**
 * Staff for tests that sign in with cookieFor(). Their PIN can't be used to log
 * in (the lookup is a unique dummy, so they never collide); use makeStaffWithPin for that.
 */
export async function makeStaff(role: "hr" | "admin" = "hr", name = uniq("staff")): Promise<Staff> {
  pinHashCache ??= hashPin(TEST_PIN);
  const r = await query<Staff>(
    "insert into staff (name, pin_hash, pin_lookup, role) values ($1, $2, $3, $4) returning id, name, role",
    [name, await pinHashCache, `dummy-${uniq()}`, role],
  );
  return r.rows[0];
}

/** Staff who can log in with `pin` (which must be unused). */
export async function makeStaffWithPin(pin: string, role: "hr" | "admin" = "hr", name = uniq("staff")): Promise<Staff> {
  const r = await query<Staff>(
    "insert into staff (name, pin_hash, pin_lookup, role) values ($1, $2, $3, $4) returning id, name, role",
    [name, await hashPin(pin), pinLookup(pin), role],
  );
  return r.rows[0];
}

/** A fresh 6-digit PIN no other test staff has. */
let pinSeq = 0;
export const freshPin = () => String(300000 + ((pinSeq++ * 7919) % 600000));

export async function cookieFor(staff: Staff): Promise<string> {
  return `${SESSION_COOKIE}=${await signSession({ sid: staff.id, role: staff.role, name: staff.name })}`;
}

export function req(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export const params = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Insert a form attendee directly and return its token. */
export async function tokenOf(attendeeId: string): Promise<string> {
  const r = await query<{ qr_token: string }>("select qr_token from attendees where id = $1", [attendeeId]);
  return r.rows[0].qr_token;
}
