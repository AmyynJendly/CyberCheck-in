// Seats per day: enforced by the database (migrations/004), so no path can oversell.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { POST as payPOST } from "@/app/api/checkin/pay/route";
import { POST as walkinPOST } from "@/app/api/walkin/route";
import { POST as undoPOST } from "@/app/api/checkin/undo/route";
import { cleanAttendeeFields, ingestFormSubmission } from "@/lib/attendees";
import { closePool, query } from "@/lib/db";
import { body, cookieFor, makeEvent, makeStaff, req, tokenOf, uniq } from "./helpers";
import type { Staff } from "@/lib/auth";

let hr: Staff;
let cookie: string;

async function eventWithCapacity(capacity: number, access: "free" | "members" | "members_or_fee" = "free") {
  const ev = await makeEvent();
  await query("update event_days set capacity = $2, access = $3 where id = $1", [ev.days[0].id, capacity, access]);
  return ev;
}
async function people(eventId: string, n: number) {
  const out: { id: string; token: string }[] = [];
  for (let i = 0; i < n; i++) {
    const r = await ingestFormSubmission(eventId, uniq("cap"), cleanAttendeeFields({ full_name: `Person ${i}`, email: `${uniq("cap")}@example.com` }));
    out.push({ id: r.attendeeId, token: await tokenOf(r.attendeeId) });
  }
  return out;
}
const scan = (eventId: string, token: string, c = cookie) =>
  checkinPOST(req("POST", "/api/checkin", { cookie: c, body: { event_id: eventId, token } }), undefined).then((r) => body<Record<string, unknown>>(r));
const seats = async (dayId: string) => {
  const r = await query<{ taken: number; real: number }>(
    "select seats_taken as taken, (select count(*)::int from checkins where event_day_id = $1 and undone_at is null) as real from event_days where id = $1",
    [dayId],
  );
  return r.rows[0];
};

beforeAll(async () => {
  hr = await makeStaff("hr");
  cookie = await cookieFor(hr);
});
afterAll(() => closePool());

describe("capacity", () => {
  it("20 different people scanned at the same moment for 5 seats → exactly 5 in, 15 FULL", async () => {
    const ev = await eventWithCapacity(5);
    const ps = await people(ev.id, 20);
    const cookies = await Promise.all([1, 2, 3, 4].map(() => makeStaff("hr").then(cookieFor)));
    const results = await Promise.all(ps.map((p, i) => scan(ev.id, p.token, cookies[i % 4])));
    expect(results.filter((r) => r.status === "OK")).toHaveLength(5);
    const full = results.filter((r) => r.status === "FULL");
    expect(full).toHaveLength(15);
    expect(full[0]).toMatchObject({ capacity: 5, day_label: "Day 1" });
    expect(await seats(ev.days[0].id)).toEqual({ taken: 5, real: 5 });
  });

  it("undo frees a seat; the counter always matches the real count", async () => {
    const ev = await eventWithCapacity(2);
    const [a, b, c] = await people(ev.id, 3);
    const ra = await scan(ev.id, a.token);
    await scan(ev.id, b.token);
    expect((await scan(ev.id, c.token)).status).toBe("FULL");
    expect((await undoPOST(req("POST", "/api/checkin/undo", { cookie, body: { checkin_id: ra.checkin_id } }), undefined)).status).toBe(200);
    expect(await seats(ev.days[0].id)).toEqual({ taken: 1, real: 1 });
    expect((await scan(ev.id, c.token)).status).toBe("OK");
    expect((await scan(ev.id, a.token)).status).toBe("FULL");
    expect(await seats(ev.days[0].id)).toEqual({ taken: 2, real: 2 });
  });

  it("a rescan of someone already in says ALREADY, not FULL", async () => {
    const ev = await eventWithCapacity(1);
    const [a] = await people(ev.id, 1);
    expect((await scan(ev.id, a.token)).status).toBe("OK");
    expect((await scan(ev.id, a.token)).status).toBe("ALREADY_CHECKED_IN");
  });

  it("full paid day says FULL before asking for money", async () => {
    const ev = await eventWithCapacity(1, "members");
    const [a, b] = await people(ev.id, 2);
    expect((await scan(ev.id, a.token)).status).toBe("PAYMENT_REQUIRED");
    await payPOST(req("POST", "/api/checkin/pay", { cookie, body: { event_id: ev.id, attendee_id: a.id, kind: "membership" } }), undefined);
    expect((await scan(ev.id, b.token)).status).toBe("FULL");
  });

  it("two people paying for the last seat at once → one OK, one FULL, one payment", async () => {
    const ev = await eventWithCapacity(1, "members_or_fee");
    const [a, b] = await people(ev.id, 2);
    const results = await Promise.all(
      [a, b].map((p) =>
        payPOST(req("POST", "/api/checkin/pay", { cookie, body: { event_id: ev.id, attendee_id: p.id, kind: "entry" } }), undefined).then((r) =>
          body<{ status: string }>(r),
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(["FULL", "OK"]);
    expect((await query("select 1 from payments where event_id = $1", [ev.id])).rowCount).toBe(1);
    expect(await seats(ev.days[0].id)).toEqual({ taken: 1, real: 1 });
  });

  it("walk-in on a full day → FULL and nobody is created", async () => {
    const ev = await eventWithCapacity(1);
    const [a] = await people(ev.id, 1);
    await scan(ev.id, a.token);
    const r = await body(await walkinPOST(req("POST", "/api/walkin", { cookie, body: { event_id: ev.id, full_name: "Late Walker" } }), undefined));
    expect(r).toMatchObject({ status: "FULL", capacity: 1, checked_in: 1 });
    expect((await query("select 1 from attendees where event_id = $1 and full_name = 'Late Walker'", [ev.id])).rowCount).toBe(0);
  });
});
