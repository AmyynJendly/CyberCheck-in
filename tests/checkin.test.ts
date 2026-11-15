import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { POST as manualPOST } from "@/app/api/checkin/manual/route";
import { POST as undoPOST } from "@/app/api/checkin/undo/route";
import { GET as recentGET } from "@/app/api/checkin/recent/route";
import { GET as statsGET } from "@/app/api/events/[id]/stats/route";
import { checkInByToken } from "@/lib/checkin";
import { ingestFormSubmission } from "@/lib/attendees";
import { closePool, query } from "@/lib/db";
import { parseScannedText } from "@/lib/qr-format";
import { DAY_MS, body, cookieFor, makeEvent, makeStaff, params, req, tokenOf, uniq } from "./helpers";
import type { Staff } from "@/lib/auth";

let hr: Staff;
let hr2: Staff;
let admin: Staff;
let hrCookie: string;

async function registered(eventId: string, name = "Test Person") {
  const r = await ingestFormSubmission(eventId, uniq("resp"), {
    full_name: name,
    email: `${uniq("p")}@example.com`,
    phone: "+216 20 000 000",
    class_year: "2nd year",
    team_name: "Root Rats",
  });
  return { attendeeId: r.attendeeId, token: await tokenOf(r.attendeeId) };
}

const scan = async (cookie: string, eventId: string, token: string, extra: Record<string, unknown> = {}) =>
  body<Record<string, unknown>>(await checkinPOST(req("POST", "/api/checkin", { cookie, body: { event_id: eventId, token, ...extra } }), undefined));

beforeAll(async () => {
  hr = await makeStaff("hr", "Sara");
  hr2 = await makeStaff("hr", "Youssef");
  admin = await makeStaff("admin", "Amyyn");
  hrCookie = await cookieFor(hr);
});
afterAll(() => closePool());

describe("QR format", () => {
  it("rejects anything without the CT1: prefix client-side", () => {
    const token = "a".repeat(43);
    expect(parseScannedText(`CT1:${token}`)).toBe(token);
    expect(parseScannedText(token)).toBeNull();
    expect(parseScannedText("https://example.com")).toBeNull();
    expect(parseScannedText("CT1:short")).toBeNull();
  });
});

describe("double-scan race", () => {
  it("20 parallel /api/checkin calls with the same token → exactly 1 OK, 19 ALREADY_CHECKED_IN", async () => {
    const ev = await makeEvent();
    const { attendeeId, token } = await registered(ev.id);
    // Different staff phones scanning the same code at the same moment.
    const cookies = [hrCookie, await cookieFor(hr2), await cookieFor(admin)];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => scan(cookies[i % 3], ev.id, `CT1:${token}`)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === "OK")).toHaveLength(1);
    expect(statuses.filter((s) => s === "ALREADY_CHECKED_IN")).toHaveLength(19);

    const rows = await query("select * from checkins where attendee_id = $1", [attendeeId]);
    expect(rows.rowCount).toBe(1);
    const ok = results.find((r) => r.status === "OK")!;
    for (const r of results.filter((r) => r.status === "ALREADY_CHECKED_IN")) {
      expect(r.name).toBe("Test Person");
      expect(r.checked_at).toBeTruthy();
      expect(["Sara", "Youssef", "Amyyn"]).toContain(r.by_staff_name);
      expect(r.checkin_id).toBe(ok.checkin_id);
    }
    const audits = await query<{ action: string; n: number }>(
      "select action, count(*)::int as n from audit_log where attendee_id = $1 and action like 'checkin%' group by action",
      [attendeeId],
    );
    expect(Object.fromEntries(audits.rows.map((r) => [r.action, r.n]))).toEqual({ checkin: 1, checkin_rejected: 19 });
  });

  it("OK response has name, team, class and day label", async () => {
    const ev = await makeEvent();
    const { token } = await registered(ev.id, "Lina");
    const r = await scan(hrCookie, ev.id, `CT1:${token}`);
    expect(r).toMatchObject({ status: "OK", name: "Lina", team_name: "Root Rats", class_year: "2nd year", day_label: "Day 1" });
  });
});

describe("multi-day", () => {
  it("day 1 → OK; day 2 → OK; day 2 again → ALREADY", async () => {
    const ev = await makeEvent({ days: [0, 1] });
    const { token } = await registered(ev.id);
    const day1 = new Date();
    const day2 = new Date(Date.now() + DAY_MS);
    const opts = { staff: hr, eventId: ev.id, token };
    expect((await checkInByToken({ ...opts, now: day1 })).status).toBe("OK");
    expect((await checkInByToken({ ...opts, now: day1 })).status).toBe("ALREADY_CHECKED_IN");
    const d2 = await checkInByToken({ ...opts, now: day2 });
    expect(d2).toMatchObject({ status: "OK", day_label: "Day 2" });
    expect((await checkInByToken({ ...opts, now: day2 })).status).toBe("ALREADY_CHECKED_IN");
  });

  it("not an event day → NO_EVENT_DAY; an admin can pick a day manually, HR cannot", async () => {
    const ev = await makeEvent({ days: [3] });
    const { token } = await registered(ev.id);
    expect((await scan(hrCookie, ev.id, token)).status).toBe("NO_EVENT_DAY");
    // HR's override is ignored
    expect((await scan(hrCookie, ev.id, token, { event_day_id: ev.days[0].id })).status).toBe("NO_EVENT_DAY");
    const r = await scan(await cookieFor(admin), ev.id, token, { event_day_id: ev.days[0].id });
    expect(r.status).toBe("OK");
  });
});

describe("rejections", () => {
  it("token from another event → WRONG_EVENT", async () => {
    const evA = await makeEvent({ name: "Mini CTF" });
    const evB = await makeEvent({ name: "Workshop" });
    const { token } = await registered(evA.id, "Omar");
    const r = await scan(hrCookie, evB.id, `CT1:${token}`);
    expect(r).toEqual({ status: "WRONG_EVENT", name: "Omar", other_event_name: "Mini CTF" });
  });

  it("unknown or malformed token → INVALID", async () => {
    const ev = await makeEvent();
    expect(await scan(hrCookie, ev.id, `CT1:${"Z".repeat(43)}`)).toEqual({ status: "INVALID" });
    expect(await scan(hrCookie, ev.id, "hello")).toEqual({ status: "INVALID" });
  });

  it("requires a session", async () => {
    const ev = await makeEvent();
    const res = await checkinPOST(req("POST", "/api/checkin", { body: { event_id: ev.id, token: "x" } }), undefined);
    expect(res.status).toBe(401);
  });

  it("blocks cross-site requests", async () => {
    const ev = await makeEvent();
    const res = await checkinPOST(
      req("POST", "/api/checkin", { cookie: hrCookie, body: { event_id: ev.id, token: "x" }, headers: { origin: "https://evil.example", host: "localhost:3000" } }),
      undefined,
    );
    expect(res.status).toBe(403);
  });

  it("inactive event → 409", async () => {
    const ev = await makeEvent({ active: false });
    const { token } = await registered(ev.id);
    const res = await checkinPOST(req("POST", "/api/checkin", { cookie: hrCookie, body: { event_id: ev.id, token } }), undefined);
    expect(res.status).toBe(409);
  });
});

describe("manual check-in, undo, recent", () => {
  it("manual check-in uses the same one-per-day rule", async () => {
    const ev = await makeEvent();
    const { attendeeId, token } = await registered(ev.id);
    const call = async () =>
      body<{ status: string }>(await manualPOST(req("POST", "/api/checkin/manual", { cookie: hrCookie, body: { attendee_id: attendeeId, event_id: ev.id } }), undefined));
    expect((await call()).status).toBe("OK");
    expect((await call()).status).toBe("ALREADY_CHECKED_IN");
    expect((await scan(hrCookie, ev.id, token)).status).toBe("ALREADY_CHECKED_IN");
    const m = await query("select method, staff_id from checkins where attendee_id = $1", [attendeeId]);
    expect(m.rows[0]).toMatchObject({ method: "manual", staff_id: hr.id });
  });

  it("HR can undo their own check-in within 10 minutes; then the QR works again", async () => {
    const ev = await makeEvent();
    const { attendeeId, token } = await registered(ev.id);
    const ok = await scan(hrCookie, ev.id, token);
    const res = await undoPOST(req("POST", "/api/checkin/undo", { cookie: hrCookie, body: { checkin_id: ok.checkin_id } }), undefined);
    expect(res.status).toBe(200);
    const again = await undoPOST(req("POST", "/api/checkin/undo", { cookie: hrCookie, body: { checkin_id: ok.checkin_id } }), undefined);
    expect(again.status).toBe(409);
    expect((await scan(hrCookie, ev.id, token)).status).toBe("OK");
    const log = await query("select staff_id from audit_log where action = 'undo' and attendee_id = $1", [attendeeId]);
    expect(log.rows[0].staff_id).toBe(hr.id);
  });

  it("HR cannot undo someone else's check-in, nor their own after 10 minutes; admin can", async () => {
    const ev = await makeEvent();
    const { token } = await registered(ev.id);
    const ok = await scan(await cookieFor(hr2), ev.id, token);
    const other = await undoPOST(req("POST", "/api/checkin/undo", { cookie: hrCookie, body: { checkin_id: ok.checkin_id } }), undefined);
    expect(other.status).toBe(403);
    expect((await body(other)).error).toBe("NOT_YOURS");

    await query("update checkins set checked_at = now() - interval '11 minutes' where id = $1", [ok.checkin_id]);
    const late = await undoPOST(req("POST", "/api/checkin/undo", { cookie: await cookieFor(hr2), body: { checkin_id: ok.checkin_id } }), undefined);
    expect(late.status).toBe(403);
    expect((await body(late)).error).toBe("TOO_LATE");

    const byAdmin = await undoPOST(req("POST", "/api/checkin/undo", { cookie: await cookieFor(admin), body: { checkin_id: ok.checkin_id } }), undefined);
    expect(byAdmin.status).toBe(200);
    const row = await query("select undone_by_staff_id from checkins where id = $1", [ok.checkin_id]);
    expect(row.rows[0].undone_by_staff_id).toBe(admin.id);
  });

  it("/api/checkin/recent lists my check-ins with can_undo", async () => {
    const ev = await makeEvent();
    const me = await makeStaff("hr");
    const cookie = await cookieFor(me);
    for (let i = 0; i < 3; i++) await scan(cookie, ev.id, (await registered(ev.id, `R${i}`)).token);
    const res = await recentGET(req("GET", `/api/checkin/recent?event_id=${ev.id}`, { cookie }), undefined);
    const { checkins } = await body<{ checkins: { name: string; can_undo: boolean }[] }>(res);
    expect(checkins.map((c) => c.name)).toEqual(["R2", "R1", "R0"]);
    expect(checkins.every((c) => c.can_undo)).toBe(true);
  });

  it("stats count registered, checked in today and per day", async () => {
    const ev = await makeEvent({ days: [0, 1] });
    for (let i = 0; i < 4; i++) {
      const { token } = await registered(ev.id);
      if (i < 3) await scan(hrCookie, ev.id, token);
    }
    const s = await body<{ registered: number; today: { checked_in: number }; days: { checked_in: number }[] }>(
      await statsGET(req("GET", `/api/events/${ev.id}/stats`, { cookie: hrCookie }), params({ id: ev.id })),
    );
    expect(s.registered).toBe(4);
    expect(s.today.checked_in).toBe(3);
    expect(s.days.map((d) => d.checked_in)).toEqual([3, 0]);
  });
});
