import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { pinPepper } from "./env";

export const PIN_LENGTH = 6;
const BCRYPT_COST = 10;

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{6}$/.test(pin);
}

export function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_COST);
}

export function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

/** staff.pin_lookup: finds the account from the PIN alone (keyed, so not reversible from the DB). */
export function pinLookup(pin: string): string {
  return createHmac("sha256", pinPepper()).update(pin).digest("hex");
}

// Used when no account matches, so response time does not reveal it.
let dummyHash: Promise<string> | undefined;
export async function burnPinCheck(pin: string): Promise<void> {
  dummyHash ??= bcrypt.hash("not-a-real-pin", BCRYPT_COST);
  await bcrypt.compare(pin, await dummyHash);
}
