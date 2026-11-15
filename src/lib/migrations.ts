import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withTransaction, query } from "./db";

/** Apply ./migrations/*.sql in name order, each once, each in its own transaction. */
export async function runMigrations(opts: { dir?: string; log?: (msg: string) => void } = {}): Promise<string[]> {
  const dir = opts.dir ?? path.join(process.cwd(), "migrations");
  const log = opts.log ?? (() => {});
  await query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  await query("alter table schema_migrations enable row level security");

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    await withTransaction(async (c) => {
      // Serialize concurrent migrators.
      await c.query("select pg_advisory_xact_lock(4207001)");
      const done = await c.query("select 1 from schema_migrations where name = $1", [file]);
      if (done.rowCount) return;
      log(`Applying ${file}…`);
      await c.query(await readFile(path.join(dir, file), "utf8"));
      await c.query("insert into schema_migrations (name) values ($1)", [file]);
      applied.push(file);
    });
  }
  return applied;
}
