// Stress test against the DEPLOYED app: how far past event-day load does it hold?
//
//   npm run stresstest -- --url https://your-app.vercel.app [--max 192] [--seconds 15] [--bursts-only]
//
// Needs DATABASE_URL (.env.local) for the same database the app uses: it creates
// a temporary "TEST stress" event (days today + tomorrow), a temporary HR account
// and thousands of TEST attendees, and deletes all of it at the end.
//
//   1. Ramp: 3, 6, 12, … phones scanning QR codes back to back (no human pause),
//      each also polling stats every 10 s like the real app. Stops when errors
//      pass 5 % or p95 passes 3 s.
//   2. Same ticket on 30 phones at once: exactly 1 OK.
//   3. Seat race: 60 people at once for 20 seats: exactly 20 in.
//   4. Integrity: the database agrees with what the phones were told.
//   5. Registration bursts: 50, then 200 Google Form posts at the same instant.
//   6. Scanning right after the bursts: does the app stay up?
import "./load-env";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { query, closePool } from "../src/lib/db";
import { hashPin, pinLookup } from "../src/lib/pin";
import { newFormSecret, newQrToken, newShortCode } from "../src/lib/ids";
import { tunisDate } from "../src/lib/time";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    max: { type: "string", default: "192" },
    seconds: { type: "string", default: "15" },
    "bursts-only": { type: "boolean", default: false },
  },
});
if (!values.url) {
  console.error("Missing --url. See the comment at the top of scripts/stresstest.ts.");
  process.exit(1);
}
const BASE = values.url.replace(/\/+$/, "");
const MAX = Number(values.max);
const SECONDS = Number(values.seconds);

type Sample = { ms: number; status: number; result?: string };
const pct = (xs: number[], q: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : 0);

async function timed(url: string, init?: RequestInit): Promise<Sample & { body: Record<string, unknown> | null }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ms: performance.now() - t0, status: res.status, result: body?.status as string | undefined, body };
  } catch {
    return { ms: performance.now() - t0, status: 0, body: null };
  }
}

function line(name: string, s: Sample[], seconds?: number) {
  const ms = s.map((x) => x.ms).sort((a, b) => a - b);
  const errors = s.filter((x) => x.status === 0 || x.status >= 500 || x.status === 429).length;
  const codes = [...new Set(s.filter((x) => x.status === 0 || x.status >= 400).map((x) => x.status || "network"))];
  console.log(
    `${name.padEnd(26)} ${String(s.length).padStart(6)} req` +
      (seconds ? ` · ${(s.length / seconds).toFixed(0).padStart(4)} req/s` : "") +
      ` · p50 ${pct(ms, 0.5).toFixed(0).padStart(5)} ms · p95 ${pct(ms, 0.95).toFixed(0).padStart(5)} ms · max ${pct(ms, 1).toFixed(0).padStart(5)} ms` +
      ` · errors ${errors}${codes.length ? ` (${codes.join(", ")})` : ""}`,
  );
  return { p95: pct(ms, 0.95), errorRate: s.length ? errors / s.length : 0 };
}

async function makeEvent(slug: string, capacity: number | null) {
  const today = tunisDate();
  const tomorrow = tunisDate(new Date(Date.now() + 86_400_000));
  const secret = newFormSecret();
  const ev = await query<{ id: string }>("insert into events (slug, name, location, form_secret) values ($1, $2, 'TEST', $3) returning id", [slug, `TEST ${slug}`, secret]);
  for (const d of [today, tomorrow]) {
    await query("insert into event_days (event_id, day_date, label, access, capacity) values ($1, $2, $3, 'free', $4)", [ev.rows[0].id, d, `TEST ${d}`, capacity]);
  }
  return { id: ev.rows[0].id, secret };
}

const codes = new Set<string>(); // short codes are unique per event
function uniqueCode(): string {
  for (;;) {
    const c = newShortCode();
    if (!codes.has(c)) return codes.add(c), c;
  }
}

/** Bulk-insert TEST attendees straight into the database; returns their QR tokens. */
async function seedPeople(eventId: string, n: number, tag: string): Promise<string[]> {
  const tokens = Array.from({ length: n }, () => newQrToken());
  for (let i = 0; i < n; i += 1000) {
    const chunk = tokens.slice(i, i + 1000);
    await query(
      `insert into attendees (event_id, full_name, source, qr_token, short_code, email_status)
       select $1, 'TEST ' || $2 || ' ' || g, 'form', t, c, 'none'
         from unnest($3::text[], $4::text[]) with ordinality as x(t, c, g)`,
      [eventId, tag, chunk, chunk.map(uniqueCode)],
    );
  }
  return tokens;
}

async function cleanup(eventIds: string[], staffId: string | null) {
  await query("delete from audit_log where event_id = any($1) or staff_id = $2", [eventIds, staffId]);
  await query("delete from payments where event_id = any($1)", [eventIds]);
  await query("delete from checkins where event_day_id in (select id from event_days where event_id = any($1))", [eventIds]);
  await query("delete from form_submissions where event_id = any($1)", [eventIds]);
  await query("delete from attendees where event_id = any($1)", [eventIds]);
  await query("delete from event_days where event_id = any($1)", [eventIds]);
  await query("delete from events where id = any($1)", [eventIds]);
  if (staffId) await query("delete from staff where id = $1", [staffId]);
}

async function main() {
  const health = await timed(`${BASE}/api/health`);
  console.log(`Stress test → ${BASE}\nhealth: HTTP ${health.status} ${JSON.stringify(health.body)} (${health.ms.toFixed(0)} ms)\n`);
  if (health.status !== 200) throw new Error("The app or its database is not reachable.");

  const run = Date.now().toString(36);
  const ev = await makeEvent(`test-stress-${run}`, null);
  const seats = await makeEvent(`test-seats-${run}`, 20);
  let staffId: string | null = null;
  try {
    // Temporary HR account (unique PIN) to sign in like a phone.
    let pin = "";
    for (let tries = 0; !staffId; tries++) {
      if (tries === 20) throw new Error("Couldn't create the temporary account.");
      pin = String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));
      try {
        staffId = (await query<{ id: string }>("insert into staff (name, pin_hash, pin_lookup, role) values ($1, $2, $3, 'hr') returning id", [`TEST Stress ${run}`, await hashPin(pin), pinLookup(pin)])).rows[0].id;
      } catch {
        /* PIN taken: try another */
      }
    }
    const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ pin }) });
    if (!login.ok) throw new Error(`Login failed: HTTP ${login.status} ${await login.text()}`);
    const auth = { Cookie: (login.headers.get("set-cookie") ?? "").split(";")[0], "Content-Type": "application/json" };

    const tokens = await seedPeople(ev.id, values["bursts-only"] ? 500 : 12_000, run);
    let next = 0;
    if (!values["bursts-only"]) {
      // 1) Ramp.
      console.log(`1. Ramp: phones scanning back to back for ${SECONDS} s per step (+ stats every 10 s per phone)`);
      let okTotal = 0;
      const stages: number[] = [];
      for (let c = 3; c <= MAX; c = c === 3 ? 6 : c * 2) stages.push(c);
      let limit: string | null = null;
      for (const phones of stages) {
        const scans: Sample[] = [];
        const polls: Sample[] = [];
        const until = Date.now() + SECONDS * 1000;
        await Promise.all(
          Array.from({ length: phones }, async () => {
            let nextPoll = Date.now() + Math.random() * 10_000;
            while (Date.now() < until) {
              if (Date.now() >= nextPoll) {
                polls.push(await timed(`${BASE}/api/events/${ev.id}/stats`, { headers: auth }));
                nextPoll += 10_000;
              }
              const token = tokens[next++ % tokens.length];
              const s = await timed(`${BASE}/api/checkin`, { method: "POST", headers: auth, body: JSON.stringify({ event_id: ev.id, token: `CT1:${token}` }) });
              if (s.result === "OK") okTotal++;
              scans.push(s);
            }
          }),
        );
        const r = line(`${String(phones).padStart(3)} phones · scans`, scans, SECONDS);
        if (polls.length) line(`${String(phones).padStart(3)} phones · stats`, polls);
        if (r.errorRate > 0.05 || r.p95 > 3000) {
          limit = `${phones} phones (errors ${(r.errorRate * 100).toFixed(1)} %, p95 ${r.p95.toFixed(0)} ms)`;
          break;
        }
      }
      console.log(limit ? `   → limit reached at ${limit}` : `   → no limit reached up to ${stages[stages.length - 1]} phones`);

      // 2) Same ticket, 30 phones at once.
      const [dup] = await seedPeople(ev.id, 1, `${run}-dup`);
      const same = await Promise.all(
        Array.from({ length: 30 }, () => timed(`${BASE}/api/checkin`, { method: "POST", headers: auth, body: JSON.stringify({ event_id: ev.id, token: `CT1:${dup}` }) })),
      );
      const sameOk = same.filter((s) => s.result === "OK").length;
      const sameAlready = same.filter((s) => s.result === "ALREADY_CHECKED_IN").length;
      console.log(`\n2. Same ticket on 30 phones at once: ${sameOk} OK, ${sameAlready} "already checked in" ${sameOk === 1 && sameAlready === 29 ? "✓" : "✗"}`);
      if (sameOk === 1) okTotal++;

      // 3) Seat race.
      const seatTokens = await seedPeople(seats.id, 60, `${run}-seat`);
      const race = await Promise.all(
        seatTokens.map((t) => timed(`${BASE}/api/checkin`, { method: "POST", headers: auth, body: JSON.stringify({ event_id: seats.id, token: `CT1:${t}` }) })),
      );
      const raceOk = race.filter((s) => s.result === "OK").length;
      const raceFull = race.filter((s) => s.result === "FULL").length;
      console.log(`3. Seat race, 60 people for 20 seats: ${raceOk} in, ${raceFull} "session full" ${raceOk === 20 && raceFull === 40 ? "✓" : "✗"}`);

      // 4) Integrity (before the bursts, which may briefly fill the database pooler).
      const db = await query<{ checkins: number; seats_taken: number }>(
        `select (select count(*)::int from checkins c join event_days d on d.id = c.event_day_id where d.event_id = $1 and c.undone_at is null) as checkins,
                (select sum(seats_taken)::int from event_days where event_id = $1) as seats_taken`,
        [ev.id],
      );
      const dupRows = await query<{ n: number }>(
        `select count(*)::int as n from (select attendee_id, event_day_id from checkins where undone_at is null group by 1, 2 having count(*) > 1) x`,
      );
      const seatsDb = await query<{ n: number }>("select seats_taken as n from event_days where event_id = $1 and day_date = $2", [seats.id, tunisDate()]);
      const okIntegrity = db.rows[0].checkins === okTotal && db.rows[0].seats_taken === okTotal && dupRows.rows[0].n === 0 && seatsDb.rows[0].n === 20;
      console.log(
        `4. Integrity: phones told OK ${okTotal} · check-ins in DB ${db.rows[0].checkins} · seat counter ${db.rows[0].seats_taken} · duplicate check-ins ${dupRows.rows[0].n} · seat-race counter ${seatsDb.rows[0].n} ${okIntegrity ? "✓" : "✗"}`,
      );

    }

    // 5) Registration bursts: a busy form (50 at once), then an extreme one (200 at once).
    // First let the ramp's connections close, so the bursts are measured on their own.
    if (!values["bursts-only"]) await new Promise((r) => setTimeout(r, 60_000));
    console.log("\n5. Registration bursts (Google Form posts at the same instant)");
    let n = 0;
    for (const size of [50, 200]) {
      const reg = await Promise.all(
        Array.from({ length: size }, () =>
          timed(`${BASE}/api/form-submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Form-Secret": ev.secret },
            body: JSON.stringify({ event_slug: `test-stress-${run}`, response_id: `stress-${run}-${n}`, full_name: `TEST Form ${n++}`, email: "", phone: "" }),
          }),
        ),
      );
      line(`${size} at once`, reg);
    }

    // 6) Does scanning still work right after? (Before the fix, a burst locked everyone out for minutes.)
    console.log("\n6. Scanning right after the bursts (6 phones)");
    const t0 = Date.now();
    for (let round = 1; ; round++) {
      const after: Sample[] = [];
      const until = Date.now() + 10_000;
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          while (Date.now() < until) {
            after.push(await timed(`${BASE}/api/checkin`, { method: "POST", headers: auth, body: JSON.stringify({ event_id: ev.id, token: `CT1:${tokens[next++ % tokens.length]}` }) }));
          }
        }),
      );
      const r = line(`  after ${Math.round((Date.now() - t0) / 1000)} s`, after, 10);
      if (r.errorRate === 0) break;
      if (Date.now() - t0 > 300_000) {
        console.log("   → still failing after 5 minutes");
        break;
      }
    }
  } finally {
    // The database may still be busy right after the bursts: keep trying for up to 3 minutes.
    for (let attempt = 0; ; attempt++) {
      try {
        await cleanup([ev.id, seats.id], staffId);
        console.log("\nCleaned up: TEST events, people, check-ins and the temporary account are deleted.");
        break;
      } catch (err) {
        if (attempt >= 18) {
          console.error(`\n✗ Cleanup failed (${err instanceof Error ? err.message : err}). Delete events named "TEST test-…" and staff "TEST Stress …" by hand.`);
          break;
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }
}

main()
  .catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
