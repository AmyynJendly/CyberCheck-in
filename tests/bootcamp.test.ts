// Paid days + membership (the bootcamp format):
// day 1 free · days 2–4 members only (join for 15 DT) · day 5 members free, others 5 DT.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { POST as payPOST } from "@/app/api/checkin/pay/route";
import { POST as walkinPOST } from "@/app/api/walkin/route";
import { POST as importPOST } from "@/app/api/admin/members/import/route";
import { POST as voidPOST } from "@/app/api/admin/payments/[id]/void/route";
import { GET as paymentsGET } from "@/app/api/events/[id]/payments/route";
import { POST as linkPOST } from "@/app/api/attendees/[id]/member/route";
import { GET as csvGET } from "@/app/api/events/[id]/export.csv/route";
import { checkInByToken, payAndCheckIn, undoCheckin } from "@/lib/checkin";
import { cleanAttendeeFields, createWalkIn, ingestFormSubmission } from "@/lib/attendees";
import { defaultValidUntil, parseMemberList } from "@/lib/members";
import { buildQrEmail, accessLines } from "@/lib/email";
import { closePool, query } from "@/lib/db";
import { newFormSecret } from "@/lib/ids";
import { DAY_MS, body, cookieFor, dateIn, makeStaff, params, req, tokenOf, uniq } from "./helpers";
import type { Staff } from "@/lib/auth";

type Access = "free" | "members" | "members_or_fee";

/** An event whose day i is `offsets[i]` days from today, with the given access rules. */
async function makePaidEvent(rules: Access[], offsets = rules.map((_, i) => i)) {
  const slug = uniq("boot");
  const r = await query<{ id: string }>(
    "insert into events (slug, name, location, form_secret, membership_fee) values ($1, 'Bootcamp', 'ISSAT Sousse', $2, 15) returning id",
    [slug, newFormSecret()],
  );
  const id = r.rows[0].id;
  const days: { id: string; date: string }[] = [];
  for (const [i, access] of rules.entries()) {
    const d = await query<{ id: string }>(
      "insert into event_days (event_id, day_date, label, access, entry_fee) values ($1, $2, $3, $4, 5) returning id",
      [id, dateIn(offsets[i]), i === rules.length - 1 && access === "members_or_fee" ? "Competition" : `Session ${i + 1}`, access],
    );
    days.push({ id: d.rows[0].id, date: dateIn(offsets[i]) });
  }
  return { id, slug, days };
}

const BOOTCAMP: Access[] = ["free", "members", "members", "members", "members_or_fee"];
const dayN = (n: number) => new Date(Date.now() + n * DAY_MS); // "now" on event day n (0-based)

let hr: Staff;
let hr2: Staff;
let admin: Staff;

async function person(eventId: string, name: string, email: string | null, phone: string | null = null) {
  // Same cleaning as /api/form-submit (lowercases the email, etc.).
  const r = await ingestFormSubmission(eventId, uniq("resp"), cleanAttendeeFields({ full_name: name, email, phone }));
  return { id: r.attendeeId, token: await tokenOf(r.attendeeId) };
}

async function addMember(name: string, email: string | null, phone: string | null, validUntil = defaultValidUntil()) {
  const key = phone ? phone.replace(/\D/g, "").slice(-8) : null;
  const r = await query<{ id: string }>(
    "insert into members (full_name, email, phone, phone_key, valid_until) values ($1, $2, $3, $4, $5) returning id",
    [name, email, phone, key, validUntil],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  hr = await makeStaff("hr", "Sara");
  hr2 = await makeStaff("hr", "Youssef");
  admin = await makeStaff("admin", "Amyyn");
});
afterAll(() => closePool());

describe("bootcamp access rules", () => {
  it("non-member: day 1 free → day 2 must join (15 DT) → member for days 3–5", async () => {
    const ev = await makePaidEvent(BOOTCAMP);
    const ali = await person(ev.id, "Ali", `${uniq("ali")}@example.com`);
    const scan = (n: number) => checkInByToken({ staff: hr, eventId: ev.id, token: ali.token, now: dayN(n) });

    expect(await scan(0)).toMatchObject({ status: "OK", is_member: false, payment: null });

    const d2 = await scan(1);
    expect(d2).toMatchObject({ status: "PAYMENT_REQUIRED", name: "Ali", options: [{ kind: "membership", amount: 15 }] });
    expect((await query("select 1 from checkins c join event_days d on d.id = c.event_day_id where d.id = $1", [ev.days[1].id])).rowCount).toBe(0);

    // "Entry only" isn't offered on session days.
    await expect(payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: ali.id, kind: "entry", method: "qr", now: dayN(1) })).rejects.toMatchObject({ code: "PAYMENT_NOT_ALLOWED" });

    const paid = await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: ali.id, kind: "membership", method: "qr", now: dayN(1) });
    expect(paid).toMatchObject({ status: "OK", is_member: true, payment: { kind: "membership", amount: 15 } });

    expect(await scan(2)).toMatchObject({ status: "OK", is_member: true, payment: null });
    expect(await scan(3)).toMatchObject({ status: "OK", payment: null });
    expect(await scan(4)).toMatchObject({ status: "OK", payment: null }); // competition free for members

    const pays = await query<{ kind: string; amount: number; staff_id: string }>("select kind, amount, staff_id from payments where attendee_id = $1", [ali.id]);
    expect(pays.rows).toEqual([{ kind: "membership", amount: 15, staff_id: hr.id }]);
    const m = await query<{ source: string; valid_until: string }>(
      "select m.source, m.valid_until from members m join attendees a on a.member_id = m.id where a.id = $1",
      [ali.id],
    );
    expect(m.rows[0]).toEqual({ source: "desk", valid_until: defaultValidUntil() });
  });

  it("members from the list get in free every day (matched by email, or by phone)", async () => {
    const ev = await makePaidEvent(BOOTCAMP);
    const email = `${uniq("mem")}@example.com`;
    await addMember("Mariem", email, null);
    await addMember("Karim", null, "22 333 444");
    const byEmail = await person(ev.id, "Mariem", email.toUpperCase());
    const byPhone = await person(ev.id, "Karim", `${uniq("k")}@other.com`, "+216 22 333 444");
    for (const p of [byEmail, byPhone]) {
      for (const n of [1, 4]) {
        expect(await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: dayN(n) })).toMatchObject({ status: "OK", is_member: true, payment: null });
      }
    }
    expect((await query("select 1 from payments where event_id = $1", [ev.id])).rowCount).toBe(0);
  });

  it("competition day: non-member pays 5 DT entry, then a rescan is ALREADY (not charged twice)", async () => {
    const ev = await makePaidEvent(BOOTCAMP);
    const omar = await person(ev.id, "Omar", `${uniq("o")}@example.com`);
    const r = await checkInByToken({ staff: hr, eventId: ev.id, token: omar.token, now: dayN(4) });
    expect(r).toMatchObject({
      status: "PAYMENT_REQUIRED",
      options: [
        { kind: "entry", amount: 5 },
        { kind: "membership", amount: 15 },
      ],
    });
    expect(await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: omar.id, kind: "entry", method: "qr", now: dayN(4) })).toMatchObject({
      status: "OK",
      is_member: false,
      payment: { kind: "entry", amount: 5 },
    });
    expect((await checkInByToken({ staff: hr2, eventId: ev.id, token: omar.token, now: dayN(4) })).status).toBe("ALREADY_CHECKED_IN");
    // paying again (another phone) is refused without a second payment
    expect((await payAndCheckIn({ staff: hr2, eventId: ev.id, attendeeId: omar.id, kind: "entry", method: "qr", now: dayN(4) })).status).toBe("ALREADY_CHECKED_IN");
    expect((await query("select 1 from payments where attendee_id = $1", [omar.id])).rowCount).toBe(1);
    // the entry fee doesn't make them a member for a session day
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: omar.token, now: dayN(2) })).status).toBe("PAYMENT_REQUIRED");
  });

  it("an expired membership doesn't count", async () => {
    const ev = await makePaidEvent(["members"]);
    const email = `${uniq("old")}@example.com`;
    await addMember("Old Member", email, null, dateIn(-1));
    const p = await person(ev.id, "Old Member", email);
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: p.token })).status).toBe("PAYMENT_REQUIRED");
  });

  it("HR can link someone to the member list (different email) and they get in", async () => {
    const ev = await makePaidEvent(["members"]);
    const memberId = await addMember("Ines Ben Salah", `${uniq("ines")}@uni.tn`, null);
    const p = await person(ev.id, "Ines", `${uniq("ines")}@gmail.com`);
    const cookie = await cookieFor(hr);
    expect((await body(await checkinPOST(req("POST", "/api/checkin", { cookie, body: { event_id: ev.id, token: p.token } }), undefined))).status).toBe("PAYMENT_REQUIRED");
    const link = await linkPOST(req("POST", `/api/attendees/${p.id}/member`, { cookie, body: { member_id: memberId } }), params({ id: p.id }));
    expect(link.status).toBe(200);
    expect(await body(await checkinPOST(req("POST", "/api/checkin", { cookie, body: { event_id: ev.id, token: p.token } }), undefined))).toMatchObject({ status: "OK", is_member: true });
  });
});

describe("payments are atomic", () => {
  it("10 phones confirm the same membership payment at once → 1 OK, 9 ALREADY, exactly one payment + one member", async () => {
    const ev = await makePaidEvent(["members"]);
    const email = `${uniq("race")}@example.com`;
    const p = await person(ev.id, "Racer", email);
    const cookies = await Promise.all([hr, hr2, admin].map(cookieFor));
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        payPOST(req("POST", "/api/checkin/pay", { cookie: cookies[i % 3], body: { event_id: ev.id, attendee_id: p.id, kind: "membership" } }), undefined).then((r) => body<{ status: string }>(r)),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === "OK")).toHaveLength(1);
    expect(statuses.filter((s) => s === "ALREADY_CHECKED_IN")).toHaveLength(9);
    expect((await query("select 1 from payments where attendee_id = $1", [p.id])).rowCount).toBe(1);
    expect((await query("select 1 from members where email = $1", [email])).rowCount).toBe(1);
    expect((await query("select 1 from checkins where attendee_id = $1", [p.id])).rowCount).toBe(1);
  });
});

describe("walk-ins on paid days", () => {
  it("non-member: PAYMENT_REQUIRED first (nothing created), then pay and join", async () => {
    const ev = await makePaidEvent(["members"]);
    const cookie = await cookieFor(hr);
    const email = `${uniq("walk")}@example.com`;
    const first = await body(await walkinPOST(req("POST", "/api/walkin", { cookie, body: { event_id: ev.id, full_name: "Walk In", email } }), undefined));
    expect(first).toMatchObject({ status: "PAYMENT_REQUIRED", options: [{ kind: "membership", amount: 15 }] });
    expect((await query("select 1 from attendees where event_id = $1", [ev.id])).rowCount).toBe(0);

    const paid = await body(
      await walkinPOST(req("POST", "/api/walkin", { cookie, body: { event_id: ev.id, full_name: "Walk In", email, payment: "membership" } }), undefined),
    );
    expect(paid).toMatchObject({ status: "OK", is_member: true, payment: { kind: "membership", amount: 15 } });
    expect((await query("select 1 from members where email = $1 and source = 'desk'", [email])).rowCount).toBe(1);
  });

  it("a walk-in already on the member list gets in free", async () => {
    const ev = await makePaidEvent(["members_or_fee"]);
    const email = `${uniq("wm")}@example.com`;
    await addMember("Listed", email, null);
    const r = await body(
      await walkinPOST(req("POST", "/api/walkin", { cookie: await cookieFor(hr), body: { event_id: ev.id, full_name: "Listed", email } }), undefined),
    );
    expect(r).toMatchObject({ status: "OK", is_member: true, payment: null });
  });
});

describe("cash", () => {
  it("totals per staff member; admins can cancel a payment (desk membership removed too)", async () => {
    const ev = await makePaidEvent(["members_or_fee"]);
    const a = await person(ev.id, "A", `${uniq("a")}@example.com`);
    const b = await person(ev.id, "B", `${uniq("b")}@example.com`);
    const c = await person(ev.id, "C", `${uniq("c")}@example.com`);
    await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: a.id, kind: "membership", method: "qr" });
    await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: b.id, kind: "entry", method: "qr" });
    await payAndCheckIn({ staff: hr2, eventId: ev.id, attendeeId: c.id, kind: "entry", method: "manual" });

    expect((await paymentsGET(req("GET", `/api/events/${ev.id}/payments`, { cookie: await cookieFor(hr) }), params({ id: ev.id }))).status).toBe(403);
    const summary = await body<{ total: number; by_staff: { staff_name: string; total: number; memberships: number; entries: number }[] }>(
      await paymentsGET(req("GET", `/api/events/${ev.id}/payments`, { cookie: await cookieFor(admin) }), params({ id: ev.id })),
    );
    expect(summary.total).toBe(25);
    expect(summary.by_staff).toEqual([
      expect.objectContaining({ staff_name: "Sara", total: 20, memberships: 1, entries: 1 }),
      expect.objectContaining({ staff_name: "Youssef", total: 5, memberships: 0, entries: 1 }),
    ]);

    const pay = await query<{ id: string }>("select id from payments where attendee_id = $1", [a.id]);
    const payId = pay.rows[0].id;
    expect((await voidPOST(req("POST", `/api/admin/payments/${payId}/void`, { cookie: await cookieFor(hr), body: {} }), params({ id: payId }))).status).toBe(403);
    const v = await voidPOST(req("POST", `/api/admin/payments/${payId}/void`, { cookie: await cookieFor(admin), body: { reason: "typed by mistake" } }), params({ id: payId }));
    expect(await body(v)).toMatchObject({ ok: true, membership_removed: true });
    const after = await body<{ total: number }>(await paymentsGET(req("GET", `/api/events/${ev.id}/payments`, { cookie: await cookieFor(admin) }), params({ id: ev.id })));
    expect(after.total).toBe(10);
    const m = await query<{ member_id: string | null }>("select member_id from attendees where id = $1", [a.id]);
    expect(m.rows[0].member_id).toBeNull();
  });

  it("CSV has member_until and per-day paid / paid_to", async () => {
    const ev = await makePaidEvent(["free", "members"]);
    const a = await person(ev.id, "Payer", `${uniq("p")}@example.com`);
    await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: a.id, kind: "membership", method: "qr", now: dayN(1) });
    const res = await csvGET(req("GET", `/api/events/${ev.id}/export.csv`, { cookie: await cookieFor(admin) }), params({ id: ev.id }));
    const [header, row] = (await res.text()).replace(/^﻿/, "").trim().split("\r\n").map((l) => l.split(","));
    const rec = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    expect(rec.member_until).toBe(defaultValidUntil());
    expect(rec[`Session 2 (${ev.days[1].date}) paid`]).toBe("membership 15 DT");
    expect(rec[`Session 2 (${ev.days[1].date}) paid_to`]).toBe("Sara");
    expect(rec[`Session 1 (${ev.days[0].date}) paid`]).toBe("");
  });
});

describe("member list import", () => {
  it("parses a paste from Excel with French headers", () => {
    const text = "Nom et prénom\tEmail\tTéléphone\nAmira Trabelsi\tAmira@Example.com\t+216 98 111 222\nSami Ben Ali\t\t55 444 333\n\t\t\n";
    expect(parseMemberList(text)).toEqual({
      rows: [
        { full_name: "Amira Trabelsi", email: "amira@example.com", phone: "+216 98 111 222" },
        { full_name: "Sami Ben Ali", email: null, phone: "55 444 333" },
      ],
      skipped: 0,
    });
  });

  it("parses a CSV with semicolons, and rows with no header", () => {
    expect(parseMemberList("name;email;phone\nA B;a@b.co;20123456").rows).toEqual([{ full_name: "A B", email: "a@b.co", phone: "20123456" }]);
    expect(parseMemberList("Rania Gharbi,rania@x.tn,22 111 000\nOmar K,omar@x.tn,").rows).toEqual([
      { full_name: "Rania Gharbi", email: "rania@x.tn", phone: "22 111 000" },
      { full_name: "Omar K", email: "omar@x.tn", phone: null },
    ]);
  });

  it("imports through the API; re-importing updates instead of duplicating; HR can't import", async () => {
    const e1 = `${uniq("imp")}@example.com`;
    const text = `Name\tEmail\tPhone\nImported One\t${e1}\t20 000 001`;
    const hrRes = await importPOST(req("POST", "/api/admin/members/import", { cookie: await cookieFor(hr), body: { text, valid_until: "2027-08-31" } }), undefined);
    expect(hrRes.status).toBe(403);
    const cookie = await cookieFor(admin);
    const preview = await body(await importPOST(req("POST", "/api/admin/members/import", { cookie, body: { text, dry_run: true } }), undefined));
    expect(preview).toMatchObject({ count: 1, skipped: 0 });
    expect((await query("select 1 from members where email = $1", [e1])).rowCount).toBe(0);
    expect(await body(await importPOST(req("POST", "/api/admin/members/import", { cookie, body: { text, valid_until: "2027-08-31" } }), undefined))).toMatchObject({ added: 1, updated: 0 });
    expect(await body(await importPOST(req("POST", "/api/admin/members/import", { cookie, body: { text, valid_until: "2027-08-31" } }), undefined))).toMatchObject({ added: 0, updated: 1 });
    expect((await query("select 1 from members where email = $1", [e1])).rowCount).toBe(1);
  });
});

describe("QR email on paid events", () => {
  it("explains each day's entry rule", () => {
    const days = BOOTCAMP.map((access, i) => ({ day_date: `2026-12-0${i + 1}`, label: i === 4 ? "Competition" : `Session ${i + 1}`, access, entry_fee: 5 }));
    const lines = accessLines({ days, membershipFee: 15 });
    expect(lines).toEqual([
      "Session 1: free for everyone.",
      "Session 2: club members only. Not a member? Join at the desk for 15 DT.",
      "Session 3: club members only. Not a member? Join at the desk for 15 DT.",
      "Session 4: club members only. Not a member? Join at the desk for 15 DT.",
      "Competition: free for club members, 5 DT for everyone else.",
      "Club membership costs 15 DT, is valid for the whole academic year, and makes every day free.",
    ]);
    const msg = buildQrEmail("x@example.com", { fullName: "X", eventName: "Bootcamp", location: null, days, shortCode: "ABCDEF", membershipFee: 15 }, Buffer.from(""));
    expect(msg.text).toContain("Entry:");
    expect(msg.text).toContain("Competition: free for club members, 5 DT for everyone else.");
    expect(msg.html).toContain("Members free · others 5 DT");
    expect(accessLines({ days: days.map((d) => ({ ...d, access: "free" })), membershipFee: 15 })).toEqual([]);
  });
});

describe("undo reverses the whole door action", () => {
  it("paid to join / claimed / paid entry, then undo → nothing paid, not a member, the next scan asks again", async () => {
    const ev = await makePaidEvent(["members", "members_or_fee"]);
    const joiner = await person(ev.id, "Joiner", `${uniq("j")}@example.com`);
    const claimer = await person(ev.id, "Claimer", `${uniq("c")}@example.com`);
    const payer = await person(ev.id, "Payer", `${uniq("p")}@example.com`);
    const ask = (p: { token: string }, n: number) => checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: dayN(n) });
    const undo = async (r: Awaited<ReturnType<typeof payAndCheckIn>>) => undoCheckin({ staff: hr, checkinId: (r as { checkin_id: string }).checkin_id });

    // Joined the club (15 DT), then undone.
    expect((await ask(joiner, 0)).status).toBe("PAYMENT_REQUIRED");
    const joined = await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: joiner.id, kind: "membership", method: "qr", now: dayN(0) });
    expect(joined).toMatchObject({ status: "OK", payment: { kind: "membership", amount: 15 } });
    expect(await undo(joined)).toMatchObject({ ok: true, refund: 15, membership_removed: true });
    expect((await ask(joiner, 0)).status).toBe("PAYMENT_REQUIRED");
    const pay = await query<{ voided: boolean; void_reason: string }>("select voided_at is not null as voided, void_reason from payments where attendee_id = $1", [joiner.id]);
    expect(pay.rows).toEqual([{ voided: true, void_reason: "Check-in undone" }]);

    // "Already a member, not on the list", then undone.
    const claimed = await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: claimer.id, kind: "claim", method: "qr", now: dayN(0) });
    expect(claimed).toMatchObject({ status: "OK", claimed: true });
    expect(await undo(claimed)).toMatchObject({ refund: 0, membership_removed: true });
    expect((await ask(claimer, 0)).status).toBe("PAYMENT_REQUIRED");
    expect((await query("select 1 from members where email = (select email from attendees where id = $1)", [claimer.id])).rowCount).toBe(0);

    // Paid the 5 DT entry, then undone.
    const entry = await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: payer.id, kind: "entry", method: "qr", now: dayN(1) });
    expect(await undo(entry)).toMatchObject({ refund: 5, membership_removed: false });
    expect((await ask(payer, 1)).status).toBe("PAYMENT_REQUIRED");
  });

  it("renewing an EXPIRED membership, then undo / void in Cash → the old end date is back, the next scan asks again", async () => {
    const ev = await makePaidEvent(["members", "members"]);
    const ask = (p: { token: string }, n: number) => checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: dayN(n) });
    const validUntil = async (email: string) => (await query<{ v: string; r: boolean }>("select valid_until::text as v, needs_review as r from members where email = $1", [email])).rows[0];

    // Pays 15 DT to renew, HR undoes it.
    const e1 = `${uniq("x")}@example.com`;
    await addMember("Expired One", e1, null, "2020-08-31");
    const p1 = await person(ev.id, "Expired One", e1);
    expect((await ask(p1, 0)).status).toBe("PAYMENT_REQUIRED");
    const paid = await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: p1.id, kind: "membership", method: "qr", now: dayN(0) });
    expect((await validUntil(e1)).v).not.toBe("2020-08-31");
    expect(await undoCheckin({ staff: hr, checkinId: (paid as { checkin_id: string }).checkin_id })).toMatchObject({ refund: 15, membership_removed: true });
    expect(await validUntil(e1)).toEqual({ v: "2020-08-31", r: false });
    expect((await ask(p1, 0)).status).toBe("PAYMENT_REQUIRED");

    // "Already a member" on an expired record, HR undoes it.
    const e2 = `${uniq("x")}@example.com`;
    await addMember("Expired Two", e2, null, "2020-08-31");
    const p2 = await person(ev.id, "Expired Two", e2);
    const claimed = await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: p2.id, kind: "claim", method: "qr", now: dayN(0) });
    await undoCheckin({ staff: hr, checkinId: (claimed as { checkin_id: string }).checkin_id });
    expect(await validUntil(e2)).toEqual({ v: "2020-08-31", r: false });

    // Pays 15 DT to renew, the admin voids it in Cash (the check-in stays).
    const e3 = `${uniq("x")}@example.com`;
    await addMember("Expired Three", e3, null, "2020-08-31");
    const p3 = await person(ev.id, "Expired Three", e3);
    await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: p3.id, kind: "membership", method: "qr", now: dayN(0) });
    const pay = (await query<{ id: string }>("select id from payments where attendee_id = $1", [p3.id])).rows[0];
    const v = await voidPOST(req("POST", `/api/admin/payments/${pay.id}/void`, { cookie: await cookieFor(admin), body: { reason: "test" } }), params({ id: pay.id }));
    expect(await body(v)).toMatchObject({ ok: true, membership_removed: true });
    expect((await validUntil(e3)).v).toBe("2020-08-31");
    expect((await ask(p3, 1)).status).toBe("PAYMENT_REQUIRED");
  });

  it("undoing an Add Person removes the person (added by mistake), unless their email went out or they came another day", async () => {
    const ev = await makePaidEvent(["free", "members"]);
    const add = (name: string, n: number, payment?: "membership") =>
      createWalkIn({ eventId: ev.id, staff: hr, now: dayN(n), payment, fields: cleanAttendeeFields({ full_name: name, email: `${uniq("w")}@example.com`, phone: null }) }) as Promise<{ status: string; attendee_id: string; checkin_id: string }>;
    const exists = async (id: string) => (await query("select 1 from attendees where id = $1", [id])).rowCount === 1;

    // Free day: added by mistake → undo → gone, email never sent.
    const a = await add("Typo Name", 0);
    expect(a.status).toBe("OK");
    expect(await undoCheckin({ staff: hr, checkinId: a.checkin_id })).toMatchObject({ ok: true, person_removed: true, refund: 0 });
    expect(await exists(a.attendee_id)).toBe(false);

    // Paid 15 DT: undo → refund 15, membership and person gone.
    const b = await add("Wrong Person", 1, "membership");
    expect(await undoCheckin({ staff: hr, checkinId: b.checkin_id })).toMatchObject({ refund: 15, membership_removed: true, person_removed: true });
    expect(await exists(b.attendee_id)).toBe(false);
    expect((await query("select 1 from payments where attendee_id = $1", [b.attendee_id])).rowCount).toBe(0);

    // Their QR email already went out → keep them.
    const c = await add("Emailed Person", 0);
    await query("update attendees set email_status = 'sent' where id = $1", [c.attendee_id]);
    expect(await undoCheckin({ staff: hr, checkinId: c.checkin_id })).toMatchObject({ person_removed: false });
    expect(await exists(c.attendee_id)).toBe(true);

    // Came on another day too → keep them (only that day is undone).
    const d = await add("Two Days", 0);
    const d2 = await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: d.attendee_id, kind: "membership", method: "manual", now: dayN(1) });
    expect(await undoCheckin({ staff: hr, checkinId: (d2 as { checkin_id: string }).checkin_id })).toMatchObject({ refund: 15, person_removed: false });
    expect(await undoCheckin({ staff: hr, checkinId: d.checkin_id })).toMatchObject({ person_removed: false });
    expect(await exists(d.attendee_id)).toBe(true);

    // A registered (form) person is never removed by an undo.
    const f = await person(ev.id, "Form Person", `${uniq("f")}@example.com`);
    const fr = await checkInByToken({ staff: hr, eventId: ev.id, token: f.token, now: dayN(0) });
    expect(await undoCheckin({ staff: hr, checkinId: (fr as { checkin_id: string }).checkin_id })).toMatchObject({ person_removed: false });
    expect(await exists(f.id)).toBe(true);
  });

  it("undoing a member's check-in leaves their membership alone", async () => {
    const ev = await makePaidEvent(["members"]);
    const email = `${uniq("m")}@example.com`;
    await addMember("Old Member", email, null);
    const p = await person(ev.id, "Old Member", email);
    const r = await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: dayN(0) });
    expect(r).toMatchObject({ status: "OK", is_member: true });
    expect(await undoCheckin({ staff: hr, checkinId: (r as { checkin_id: string }).checkin_id })).toMatchObject({ refund: 0, membership_removed: false });
    expect((await query("select 1 from members where email = $1", [email])).rowCount).toBe(1);
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: dayN(0) })).status).toBe("OK");
  });
});
