// Signed session cookie (JWT, HS256). Edge-safe: used by middleware too.
import { SignJWT, jwtVerify } from "jose";
import { sessionSecret } from "./env";

export const SESSION_COOKIE = "ct_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export type Role = "hr" | "admin";
export interface SessionClaims {
  sid: string; // staff id
  role: Role;
  name: string;
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ role: claims.role, name: claims.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sid)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setIssuer("cybertrace-checkin")
    .sign(sessionSecret());
}

export async function verifySession(token: string | undefined | null): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), {
      algorithms: ["HS256"],
      issuer: "cybertrace-checkin",
    });
    const role = payload.role;
    if (typeof payload.sub !== "string" || (role !== "hr" && role !== "admin")) return null;
    return { sid: payload.sub, role, name: String(payload.name ?? "") };
  } catch {
    return null;
  }
}
