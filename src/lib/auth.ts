import type { NextRequest, NextResponse } from "next/server";
import { query } from "./db";
import { HttpError, assertSameOrigin } from "./http";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, verifySession, type Role } from "./session";
import { cookieSecure } from "./env";

export interface Staff {
  id: string;
  name: string;
  role: Role;
}

/** Resolve the logged-in staff member (checked against the DB, so deactivation is immediate). */
export async function getStaff(req: NextRequest): Promise<Staff | null> {
  const claims = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!claims) return null;
  const r = await query<Staff>(
    "select id, name, role from staff where id = $1 and is_active",
    [claims.sid],
  );
  return r.rows[0] ?? null;
}

export async function requireStaff(req: NextRequest, role?: Role): Promise<Staff> {
  assertSameOrigin(req);
  const staff = await getStaff(req);
  if (!staff) throw new HttpError(401, "UNAUTHENTICATED", "Please log in again.");
  if (role === "admin" && staff.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "Admins only.");
  }
  return staff;
}

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
