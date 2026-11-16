// Load test against a DEPLOYED app (run it before every event).
//
//   npm run loadtest -- --url https://your-app.vercel.app --slug load-test \
//     --secret <FORM_SECRET of the load-test event> --pin <a staff PIN> \
//     [--people 150] [--scanners 8]
//
// Use a separate event (e.g. "Load test", slug load-test) whose only day is TODAY
// and has no seat limit. People are registered WITHOUT email (no Gmail quota used).
// Afterwards, deactivate that event in Admin → Events.
//
// What it does: registers N people through /api/form-submit (like a burst of
// Google Form responses), then S "phones" check everyone in at the same time
// (each phone also polls stats every 10 s, like the real app), then re-scans
// a few (expecting "already checked in"). Prints latency and errors.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    slug: { type: "string" },
    secret: { type: "string" },
    pin: { type: "string" },
    people: { type: "string", default: "150" },
    scanners: { type: "string", default: "8" },
  },
});

function need(v: string | undefined, name: string): string {
  if (!v) {
    console.error(`Missing --${name}. See the comment at the top of scripts/loadtest.ts.`);
    process.exit(1);
  }
  return v;
}

const BASE = need(values.url, "url").replace(/\/+$/, "");
const SLUG = need(values.slug, "slug");
const SECRET = need(values.secret, "secret");
const PIN = need(values.pin, "pin");
const PEOPLE = Number(values.people);
const SCANNERS = Number(values.scanners);

type Sample = { ms: number; ok: boolean; status: number; result?: string };

async function timed(fn: () => Promise<Response>): Promise<Sample & { body: unknown }> {
  const t0 = performance.now();
  try {
    const res = await fn();
    const body = await res.json().catch(() => null);
    return { ms: performance.now() - t0, ok: res.ok, status: res.status, body, result: (body as { status?: string })?.status };
  } catch (err) {
    return { ms: performance.now() - t0, ok: false, status: 0, body: String(err) };
  }
}

function summary(name: string, s: Sample[]) {
  const ms = s.map((x) => x.ms).sort((a, b) => a - b);
  const p = (q: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * q))].toFixed(0) : "-");
  const errors = s.filter((x) => !x.ok);
  console.log(
    `${name.padEnd(22)} ${String(s.length).padStart(5)} requests · p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${p(1)} ms · errors ${errors.length}` +
      (errors.length ? ` (HTTP ${[...new Set(errors.map((e) => e.status))].join(", ")})` : ""),
  );
  return { p95: Number(p(0.95)), errors: errors.length };
}

async function pool<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

async function main() {
  console.log(`Load test → ${BASE} · ${PEOPLE} people · ${SCANNERS} phones\n`);

  // Health + warm-up (first requests on a cold server are slower).
  const health = await timed(() => fetch(`${BASE}/api/health`));
  console.log(`health: HTTP ${health.status} ${JSON.stringify(health.body)} (${health.ms.toFixed(0)} ms)`);
  if (!health.ok) throw new Error("The app or its database is not reachable. Fix that first.");

  // Log in.
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ pin: PIN }),
  });
  if (!login.ok) throw new Error(`Login failed: HTTP ${login.status} ${await login.text()}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const auth = { Cookie: cookie, "Content-Type": "application/json" };

  const events = (await (await fetch(`${BASE}/api/events`, { headers: auth })).json()) as {
    events: { id: string; slug: string; today_day_id: string | null }[];
  };
  const ev = events.events.find((e) => e.slug === SLUG);
  if (!ev) throw new Error(`No active event with slug "${SLUG}".`);
  if (!ev.today_day_id) throw new Error(`Event "${SLUG}" has no day for today (Africa/Tunis). Add today as a day.`);

  // 1) Registration burst.
  const run = Date.now().toString(36);
  const ids: string[] = [];
  const reg: Sample[] = [];
  const t0 = Date.now();
  await pool(
    Array.from({ length: PEOPLE }, (_, i) => i),
    20,
    async (i) => {
      const r = await timed(() =>
        fetch(`${BASE}/api/form-submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Form-Secret": SECRET },
          body: JSON.stringify({ event_slug: SLUG, response_id: `loadtest-${run}-${i}`, full_name: `Load Test ${run} ${i}`, email: "", phone: "" }),
        }),
      );
      reg.push(r);
      const id = (r.body as { attendee_id?: string })?.attendee_id;
      if (id) ids.push(id);
    },
  );
  console.log(`\nRegistered ${ids.length}/${PEOPLE} in ${((Date.now() - t0) / 1000).toFixed(1)} s (20 at a time)`);
  const regStats = summary("form-submit", reg);

  // 2) Check everyone in, SCANNERS phones at once, each also polling stats.
  const scans: Sample[] = [];
  const polls: Sample[] = [];
  let done = false;
  const pollers = Array.from({ length: SCANNERS }, async () => {
    while (!done) {
      polls.push(await timed(() => fetch(`${BASE}/api/events/${ev.id}/stats`, { headers: auth })));
      await new Promise((r) => setTimeout(r, 10_000));
    }
  });
  const t1 = Date.now();
  await pool(ids, SCANNERS, async (id) => {
    scans.push(
      await timed(() =>
        fetch(`${BASE}/api/checkin/manual`, { method: "POST", headers: auth, body: JSON.stringify({ event_id: ev.id, attendee_id: id }) }),
      ),
    );
  });
  // 3) Re-scan 20% (people coming back / double scans).
  const again: Sample[] = [];
  await pool(ids.slice(0, Math.ceil(ids.length / 5)), SCANNERS, async (id) => {
    again.push(
      await timed(() =>
        fetch(`${BASE}/api/checkin/manual`, { method: "POST", headers: auth, body: JSON.stringify({ event_id: ev.id, attendee_id: id }) }),
      ),
    );
  });
  done = true;
  await Promise.race([Promise.all(pollers), new Promise((r) => setTimeout(r, 100))]);
  console.log(`\nChecked in ${scans.filter((s) => s.result === "OK").length}/${ids.length} in ${((Date.now() - t1) / 1000).toFixed(1)} s with ${SCANNERS} phones`);
  const scanStats = summary("check-in", scans);
  const againStats = summary("re-scan (ALREADY)", again);
  summary("stats polling", polls);
  const wrong = again.filter((s) => s.result !== "ALREADY_CHECKED_IN").length;

  console.log("");
  const problems: string[] = [];
  if (regStats.errors + scanStats.errors + againStats.errors) problems.push("some requests failed (see errors above)");
  if (wrong) problems.push(`${wrong} re-scans did not say ALREADY_CHECKED_IN`);
  if (scanStats.p95 > 1500) problems.push("check-ins are slow (p95 > 1.5 s): check that Vercel's function region matches Supabase's region");
  console.log(problems.length ? `⚠ ${problems.join("; ")}` : "✓ No errors. The app handled the load.");
  console.log(`\nClean up: deactivate the "${SLUG}" event in Admin → Events.`);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
