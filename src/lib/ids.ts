import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";

/** 32 random bytes, base64url (43 chars). Goes in the QR as CT1:<token>. */
export function newQrToken(): string {
  return randomBytes(32).toString("base64url");
}

// No 0/O, 1/I/L — easy to read aloud at the desk.
const SHORT_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newShortCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += SHORT_ALPHABET[randomInt(SHORT_ALPHABET.length)];
  return s;
}

export function newFormSecret(): string {
  return randomBytes(24).toString("base64url"); // 32 chars
}

/** Constant-time string compare (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
