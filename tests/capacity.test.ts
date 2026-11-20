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

describe("full day: people who paid at the stand still get in", () => {
  const standMember = async (email: string) =>
    query("insert into members (full_name, email, valid_until, source) values ('Stand Payer', $1, '2099-08-31', 'stand')", [email]);

  it("over the limit for stand payers only; the admin sees who is waiting and opens more seats", async () => {
    const ev = await eventWithCapacity(2, "members");
    const [a, b, c] = await people(ev.id, 3);
    const s = await people(ev.id, 2); // two stand payers
    const emails = await query<{ id: string; email: string }>("select id, email from attendees where id = any($1)", [[a.id, b.id, c.id, ...s.map((x) => x.id)]]);
    for (const p of [a, b, c, ...s]) await standMember(emails.rows.find((r) => r.id === p.id)!.email); // members-only day: everyone is a member
    // a and b are ordinary members (not from the stand)
    await query("update members set source = 'import' where email = any($1)", [emails.rows.filter((r) => [a.id, b.id, c.id].includes(r.id)).map((r) => r.email)]);

    expect(await scan(ev.id, `CT1:${a.token}`)).toMatchObject({ status: "OK" });
    expect(await scan(ev.id, `CT1:${b.token}`)).toMatchObject({ status: "OK" });
    expect(await scan(ev.id, `CT1:${c.token}`)).toMatchObject({ status: "FULL" }); // full: ordinary member turned away
    const over = await scan(ev.id, `CT1:${s[0].token}`);
    expect(over).toMatchObject({ status: "OK", over_limit: true }); // paid at the stand: in anyway
    expect(await seats(ev.days[0].id)).toEqual({ taken: 3, real: 3 });
    const walk = await body(await walkinPOST(req("POST", "/api/walkin", { cookie, body: { event_id: ev.id, full_name: "Door Walker" } }), undefined));
    expect(walk).toMatchObject({ status: "FULL" });

    const { getOverview } = await import("@/lib/overview");
    const day = (await getOverview(ev.id)).days[0];
    expect(day).toMatchObject({ checked_in: 3, capacity: 2, over_limit: 1, turned_away: 2, prepaid_waiting: 1 });

    // The admin opens 2 more seats: the ordinary member who was turned away gets in.
    await query("update event_days set capacity = 5 where id = $1", [ev.days[0].id]);
    expect(await scan(ev.id, `CT1:${c.token}`)).toMatchObject({ status: "OK" });
    const after = (await getOverview(ev.id)).days[0];
    expect(after.turned_away).toBe(1); // only the walk-in is still outside
    const chk = await query<{ over_limit: boolean }>("select over_limit from checkins c join attendees a on a.id = c.attendee_id where a.id = $1", [c.id]);
    expect(chk.rows[0].over_limit).toBe(false);
  });

  it("stand payers racing for the last seat: everyone gets in, the counter stays exact", async () => {
    const ev = await eventWithCapacity(1);
    const ps = await people(ev.id, 6);
    const emails = await query<{ email: string }>("select email from attendees where event_id = $1", [ev.id]);
    for (const r of emails.rows) await standMember(r.email);
    const rs = await Promise.all(ps.map((p) => scan(ev.id, `CT1:${p.token}`)));
    expect(rs.every((r) => r.status === "OK")).toBe(true);
    expect(rs.filter((r) => r.over_limit).length).toBe(5);
    expect(await seats(ev.days[0].id)).toEqual({ taken: 6, real: 6 });
  });
});
