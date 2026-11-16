// Skipped in `npm test`. Run: PERF=1 npx vitest run tests/perf.test.ts
// Measures server-side latency of the scan path and counts DB round trips.
import { afterAll, it } from "vitest";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { ingestFormSubmission } from "@/lib/attendees";
import pg from "pg";
import { closePool } from "@/lib/db";
import { body, cookieFor, makeEvent, makeStaff, req, tokenOf } from "./helpers";

afterAll(() => closePool());

it.skipIf(!process.env.PERF)("scan latency", async () => {
  const ev = await makeEvent();
  const tokens: string[] = [];
  for (let i = 0; i < 500; i++) {
    const r = await ingestFormSubmission(ev.id, `perf-${i}`, { full_name: `P ${i}`, email: null, phone: null, class_year: null, team_name: null });
    tokens.push(await tokenOf(r.attendeeId));
  }
  const cookies = await Promise.all(Array.from({ length: 8 }, () => makeStaff("hr").then(cookieFor)));

  // count round trips for one scan (every query goes through pg.Client#query)
  const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const orig = proto.query;
  let calls = 0;
  proto.query = function (this: unknown, ...a: unknown[]) {
    calls++;
    return orig.apply(this, a);
  };
  await checkinPOST(req("POST", "/api/checkin", { cookie: cookies[0], body: { event_id: ev.id, token: tokens.pop() } }), undefined);
  proto.query = orig;
  console.log(`round trips per successful scan: ${calls}`);

  const times: number[] = [];
  const started = Date.now();
  await Promise.all(
    cookies.map(async (cookie, s) => {
      for (let i = s; i < tokens.length; i += cookies.length) {
        const t0 = performance.now();
        const res = await checkinPOST(req("POST", "/api/checkin", { cookie, body: { event_id: ev.id, token: tokens[i] } }), undefined);
        await body(res);
        times.push(performance.now() - t0);
      }
    }),
  );
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.floor(times.length * q)].toFixed(1);
  console.log(`${times.length} scans, 8 scanners, ${Date.now() - started} ms total · p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${times[times.length - 1].toFixed(1)} ms`);
}, 120_000);
