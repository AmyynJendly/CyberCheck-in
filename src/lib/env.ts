// Central, lazy access to environment variables. Nothing is read at import
// time so `next build` works without secrets.

function raw(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function isPlaceholder(value: string | undefined): boolean {
  return !value || value.startsWith("REPLACE_ME");
}

export function requireEnv(name: string): string {
  const v = raw(name);
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  if (isPlaceholder(v)) {
    throw new Error(`Environment variable ${name} still has its placeholder value. See README "Placeholders".`);
  }
  return v;
}

export function optionalEnv(name: string): string | undefined {
  return raw(name);
}

export function sessionSecret(): Uint8Array {
  const v = raw("SESSION_SECRET");
  if (!v) throw new Error("Missing SESSION_SECRET. See .env.example.");
  if (v.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters (32+ random bytes).");
  if (isPlaceholder(v)) {
    if (process.env.VERCEL_ENV === "production") {
      throw new Error("SESSION_SECRET is still the placeholder. Set a real random value in Vercel.");
    }
    if (!(globalThis as { __ctSecretWarned?: boolean }).__ctSecretWarned) {
      (globalThis as { __ctSecretWarned?: boolean }).__ctSecretWarned = true;
      console.warn("[cybertrace] WARNING: SESSION_SECRET is a placeholder. Fine for local dev only.");
    }
  }
  return new TextEncoder().encode(v);
}

/** Key for staff.pin_lookup. Must be the same everywhere that shares the database. */
export function pinPepper(): string {
  const v = raw("PIN_PEPPER");
  if (!v || isPlaceholder(v)) throw new Error("Missing PIN_PEPPER (32+ random characters). See .env.example.");
  if (v.length < 32) throw new Error("PIN_PEPPER must be at least 32 characters.");
  return v;
}

export type EmailMode = "smtp" | "log";
export function emailMode(): EmailMode {
  return raw("DEV_EMAIL_MODE")?.toLowerCase() === "log" ? "log" : "smtp";
}

export function appBaseUrl(): string | undefined {
  const v = raw("APP_BASE_URL");
  return v && !isPlaceholder(v) ? v.replace(/\/+$/, "") : undefined;
}

/** Cookies get the Secure flag unless the app is explicitly served over plain http (local dev). */
export function cookieSecure(): boolean {
  const base = raw("APP_BASE_URL");
  if (base?.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL;
}
