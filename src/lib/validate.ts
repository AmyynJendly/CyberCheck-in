import { HttpError } from "./http";
import { isUuid } from "./ids";

/** Trim, collapse whitespace, cap length; empty → null. */
export function cleanText(v: unknown, max = 200): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.slice(0, max);
}

export function normalizeEmail(v: unknown): string | null {
  const s = cleanText(v, 254);
  return s ? s.toLowerCase().replace(/\s/g, "") : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function looksLikeEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function requireUuid(v: unknown, field: string): string {
  if (!isUuid(v)) throw new HttpError(400, "BAD_REQUEST", `${field} must be a valid id.`);
  return v.toLowerCase();
}

export function optionalUuid(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  return requireUuid(v, field);
}

export function requireText(v: unknown, field: string, max = 200): string {
  const s = cleanText(v, max);
  if (!s) throw new HttpError(400, "BAD_REQUEST", `${field} is required.`);
  return s;
}
