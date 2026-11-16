// Recreate the test database schema from the migrations before the run.
import pg from "pg";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/cybertrace_test";
  const dbName = new URL(url).pathname.slice(1);

  // The tests DROP and recreate the whole schema. Never let that hit a real database.
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "db"].includes(host) && process.env.ALLOW_REMOTE_TEST_DB !== "1") {
    throw new Error(
      `Refusing to run tests against ${host}: the test setup deletes every table. ` +
        "Use the local Docker database (docker compose up -d db), or a separate throwaway database with ALLOW_REMOTE_TEST_DB=1.",
    );
  }

  // Create the test DB if the docker init script didn't (e.g. an existing volume).
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/]*$/, "/postgres") });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
  if (!exists.rowCount) await admin.query(`create database "${dbName}"`);
  await admin.end();

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("drop schema public cascade; create schema public;");
  await c.end();

  process.env.DATABASE_URL = url;
  process.env.DATABASE_SSL = "disable";
  const { runMigrations } = await import("../src/lib/migrations");
  const { closePool } = await import("../src/lib/db");
  await runMigrations();
  await closePool();
}
