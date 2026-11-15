import bcrypt from "bcryptjs";

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

// Used when the staff id is unknown, so response time does not reveal it.
let dummyHash: Promise<string> | undefined;
export async function burnPinCheck(pin: string): Promise<void> {
  dummyHash ??= bcrypt.hash("not-a-real-pin", BCRYPT_COST);
  await bcrypt.compare(pin, await dummyHash);
}
