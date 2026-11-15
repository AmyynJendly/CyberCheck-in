import pg from "pg";
import { requireEnv, optionalEnv } from "./env";

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Dates.
pg.types.setTypeParser(1082, (v: string) => v);
// bigint (audit_log.id, count(*)) as number — values stay far below 2^53.
pg.types.setTypeParser(20, (v: string) => Number(v));
// numeric (DT amounts) as number — always small, 2 decimals.
pg.types.setTypeParser(1700, (v: string) => Number(v));

type PoolGlobal = { __ctPool?: pg.Pool };
const g = globalThis as PoolGlobal;

function buildConfig(): pg.PoolConfig {
  const url = new URL(requireEnv("DATABASE_URL"));
  // We control TLS through `ssl` below; sslmode in the URL would override it.
  for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(p);

  const isLocal = ["localhost", "127.0.0.1", "::1", "db"].includes(url.hostname);
  const sslSetting = (optionalEnv("DATABASE_SSL") ?? (isLocal ? "disable" : "no-verify")).toLowerCase();
  let ssl: pg.PoolConfig["ssl"] = false;
  if (sslSetting === "verify") {
    ssl = { rejectUnauthorized: true, ca: optionalEnv("DATABASE_CA_CERT")?.replace(/\\n/g, "\n") };
  } else if (sslSetting !== "disable") {
    ssl = { rejectUnauthorized: false };
  }

  return {
    connectionString: url.toString(),
    ssl,
    max: Number(optionalEnv("PG_POOL_MAX") ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Safety net: no statement should ever take this long here.
    statement_timeout: 15_000,
    application_name: "cybertrace-checkin",
  };
}

export function getPool(): pg.Pool {
  if (!g.__ctPool) {
    const pool = new pg.Pool(buildConfig());
    pool.on("error", (err) => console.error("[db] idle client error", err));
    g.__ctPool = pool;
  }
  return g.__ctPool;
}

export async function closePool(): Promise<void> {
  const pool = g.__ctPool;
  g.__ctPool = undefined;
  if (pool) await pool.end();
}

export type Queryable = Pick<pg.PoolClient, "query">;

export function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: Queryable,
): Promise<pg.QueryResult<R>> {
  return (client ?? getPool()).query<R>(text, params);
}

/** Run `fn` inside BEGIN/COMMIT on one connection; ROLLBACK on any error. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}
