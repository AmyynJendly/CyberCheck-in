import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";

// Base32 (RFC 4648): uppercase + digits only, so "CT1:<token>" fits the QR
// alphanumeric mode. That keeps the code small (version 3, 29×29 modules) even
// at error correction H, which survives ~30% damage: cracked or dirty screens.
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 26 random base32 chars (130 bits). Goes in the QR as CT1:<token>. */
export function newQrToken(): string {
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  return Array.from(randomBytes(26), (b) => TOKEN_ALPHABET[b & 31]).join("");
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
