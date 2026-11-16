// Create the first admin (or reset an existing staff member's PIN and make them admin).
//   npm run seed:admin -- --name "Amyyn" --pin 123456
import "./load-env";
import { parseArgs } from "node:util";
import { closePool, isUniqueViolation, query } from "../src/lib/db";
import { hashPin, isValidPin, pinLookup } from "../src/lib/pin";

async function main() {
  const { values } = parseArgs({
    options: { name: { type: "string" }, pin: { type: "string" } },
  });
  const name = values.name?.trim();
  const pin = values.pin?.trim();
  if (!name || !pin) {
    throw new Error('Usage: npm run seed:admin -- --name "Amyyn" --pin 123456');
  }
  if (!isValidPin(pin)) throw new Error("PIN must be exactly 6 digits.");

  const pinHash = await hashPin(pin);
  const lookup = pinLookup(pin); // the PIN is the login, so it must be unique
  const existing = await query<{ id: string }>(
    "select id from staff where lower(name) = lower($1) limit 1",
    [name],
  );
  let id: string;
  try {
    if (existing.rows[0]) {
      id = existing.rows[0].id;
      await query("update staff set pin_hash = $2, pin_lookup = $3, role = 'admin', is_active = true where id = $1", [id, pinHash, lookup]);
      console.log(`Updated existing staff "${name}" → admin, PIN reset.`);
    } else {
      const r = await query<{ id: string }>(
        "insert into staff (name, pin_hash, pin_lookup, role) values ($1, $2, $3, 'admin') returning id",
        [name, pinHash, lookup],
      );
      id = r.rows[0].id;
      console.log(`Created admin "${name}".`);
    }
  } catch (err) {
    if (isUniqueViolation(err, "staff_pin_lookup_key")) throw new Error("Someone else already has this PIN. Choose a different one.");
    throw err;
  }
  await query(
    "insert into audit_log (staff_id, action, details) values (null, 'create_staff', $1)",
    [JSON.stringify({ staff_id: id, name, role: "admin", via: "seed:admin" })],
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
