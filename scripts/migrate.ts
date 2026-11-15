// Apply SQL files in ./migrations in order, once each.
//   npm run migrate
// Uses DATABASE_URL (from .env.local or the environment).
import "./load-env";
import { runMigrations } from "../src/lib/migrations";
import { closePool } from "../src/lib/db";

runMigrations({ log: console.log })
  .then(() => console.log("Migrations up to date."))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
