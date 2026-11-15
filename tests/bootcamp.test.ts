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
import { checkInByToken, payAndCheckIn } from "@/lib/checkin";
import { cleanAttendeeFields, ingestFormSubmission } from "@/lib/attendees";
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

    const summary = await body<{ total: number; by_staff: { staff_name: string; total: number; memberships: number; entries: number }[] }>(
      await paymentsGET(req("GET", `/api/events/${ev.id}/payments`, { cookie: await cookieFor(hr) }), params({ id: ev.id })),
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
    const after = await body<{ total: number }>(await paymentsGET(req("GET", `/api/events/${ev.id}/payments`, { cookie: await cookieFor(hr) }), params({ id: ev.id })));
    expect(after.total).toBe(10);
    const m = await query<{ member_id: string | null }>("select member_id from attendees where id = $1", [a.id]);
    expect(m.rows[0].member_id).toBeNull();
  });

  it("CSV has member_until and per-day paid / paid_to", async () => {
    const ev = await makePaidEvent(["free", "members"]);
    const a = await person(ev.id, "Payer", `${uniq("p")}@example.com`);
    await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: a.id, kind: "membership", method: "qr", now: dayN(1) });
    const res = await csvGET(req("GET", `/api/events/${ev.id}/export.csv`, { cookie: await cookieFor(hr) }), params({ id: ev.id }));
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
    expect(msg.html).toContain("Competition: free for club members, 5 DT for everyone else.");
    expect(accessLines({ days: days.map((d) => ({ ...d, access: "free" })), membershipFee: 15 })).toEqual([]);
  });
});
