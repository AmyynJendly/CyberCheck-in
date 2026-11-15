import { afterAll, describe, expect, it } from "vitest";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { ingestFormSubmission } from "@/lib/attendees";
import { closePool, query } from "@/lib/db";
import { body, cookieFor, makeEvent, makeStaff, req, tokenOf } from "./helpers";

afterAll(() => closePool());

describe("load", () => {
  it("150 attendees, 4 scanners check everyone in well within 5 minutes, no errors", async () => {
    const ev = await makeEvent();
    const tokens: string[] = [];
    for (let i = 0; i < 150; i++) {
      const r = await ingestFormSubmission(ev.id, `load-${i}`, {
        full_name: `Attendee ${String(i).padStart(3, "0")}`,
        email: `load${i}@example.com`,
        phone: null,
        class_year: null,
        team_name: `Team ${i % 20}`,
      });
      tokens.push(await tokenOf(r.attendeeId));
    }
    const scanners = await Promise.all([1, 2, 3, 4].map(() => makeStaff("hr")));
    const cookies = await Promise.all(scanners.map(cookieFor));

    // Each scanner works through its own queue; on top of that each one
    // re-scans 5 codes from another queue (people in the wrong line).
    const queues = cookies.map((_, s) => tokens.filter((_, i) => i % 4 === s));
    queues.forEach((q, s) => q.push(...tokens.filter((_, i) => i % 4 === (s + 1) % 4).slice(0, 5)));

    const started = Date.now();
    const counts = { OK: 0, ALREADY_CHECKED_IN: 0, other: 0, http_errors: 0 };
    await Promise.all(
      queues.map(async (queue, s) => {
        for (const t of queue) {
          const res = await checkinPOST(req("POST", "/api/checkin", { cookie: cookies[s], body: { event_id: ev.id, token: `CT1:${t}` } }), undefined);
          if (res.status !== 200) {
            counts.http_errors++;
            continue;
          }
          const { status } = await body<{ status: string }>(res);
          if (status === "OK" || status === "ALREADY_CHECKED_IN") counts[status]++;
          else counts.other++;
        }
      }),
    );
    const elapsed = Date.now() - started;
    console.log(`load: 170 scans by 4 scanners in ${elapsed} ms`, counts);

    expect(counts).toEqual({ OK: 150, ALREADY_CHECKED_IN: 20, other: 0, http_errors: 0 });
    expect(elapsed).toBeLessThan(5 * 60 * 1000);
    const n = await query<{ n: number }>(
      "select count(*)::int as n from checkins c join attendees a on a.id = c.attendee_id where a.event_id = $1 and c.undone_at is null",
      [ev.id],
    );
    expect(n.rows[0].n).toBe(150);
  });
});
