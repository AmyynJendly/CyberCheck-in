// Final report (Excel): per-day sheets + Statistics, admin-only.
import { afterAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { GET as reportGET } from "@/app/api/events/[id]/report.xlsx/route";
import { checkInByToken, payAndCheckIn } from "@/lib/checkin";
import { cleanAttendeeFields, createWalkIn, ingestFormSubmission } from "@/lib/attendees";
import { defaultValidUntil } from "@/lib/members";
import { buildReportWorkbook, getReportData } from "@/lib/report";
import { closePool, query } from "@/lib/db";
import { newFormSecret } from "@/lib/ids";
import { DAY_MS, cookieFor, dateIn, makeStaff, params, req, tokenOf, uniq } from "./helpers";

afterAll(() => closePool());

const dayN = (n: number) => new Date(Date.now() + n * DAY_MS);

async function makeEvent() {
  const r = await query<{ id: string }>(
    "insert into events (slug, name, location, form_secret, membership_fee) values ($1, 'Bootcamp', 'ISSAT Sousse', $2, 15) returning id",
    [uniq("rep"), newFormSecret()],
  );
  const id = r.rows[0].id;
  const days: [string, string][] = [["Linux fundamentals", "free"], ["Networks under attack", "members"], ["Main event", "members_or_fee"]];
  for (const [i, [label, access]] of days.entries()) {
    await query("insert into event_days (event_id, day_date, label, access, entry_fee, capacity) values ($1, $2, $3, $4, 5, 50)", [id, dateIn(i), label, access]);
  }
  return id;
}

async function person(eventId: string, name: string, enrollment: string | null, phone: string | null = null) {
  const email = `${uniq(name.toLowerCase())}@example.com`;
  const r = await ingestFormSubmission(eventId, uniq("resp"), cleanAttendeeFields({ full_name: name, email, phone, enrollment }));
  return { id: r.attendeeId, token: await tokenOf(r.attendeeId), email };
}

describe("final report", () => {
  it("counts who registered, came, ticked, paid and was a member, day by day", async () => {
    const ev = await makeEvent();
    const hr = await makeStaff("hr", uniq("Sara HR"));
    const ali = await person(ev, "Ali", "Linux fundamentals, Networks under attack(advanced)");
    const sara = await person(ev, "Sara", "Networks under attack(advanced)");
    const omar = await person(ev, "Omar", null); // main-event form only
    await person(ev, "Lina", "Linux fundamentals"); // never comes
    await query("insert into members (full_name, email, valid_until) values ('Sara', $1, $2)", [sara.email, defaultValidUntil()]);

    const scan = (p: { token: string }, n: number) => checkInByToken({ staff: hr, eventId: ev, token: p.token, now: dayN(n) });
    expect((await scan(ali, 0)).status).toBe("OK");
    expect((await scan(sara, 0)).status).toBe("OK");
    await createWalkIn({ eventId: ev, staff: hr, now: dayN(0), fields: { full_name: "Zed", email: null, phone: null, class_year: null, team_name: null } });
    expect((await scan(ali, 1)).status).toBe("PAYMENT_REQUIRED");
    expect((await payAndCheckIn({ staff: hr, eventId: ev, attendeeId: ali.id, kind: "membership", method: "qr", now: dayN(1) })).status).toBe("OK");
    expect((await scan(sara, 1)).status).toBe("OK");
    expect((await scan(ali, 2)).status).toBe("OK");
    expect((await scan(omar, 2)).status).toBe("PAYMENT_REQUIRED");
    expect((await payAndCheckIn({ staff: hr, eventId: ev, attendeeId: omar.id, kind: "entry", method: "qr", now: dayN(2) })).status).toBe("OK");

    const data = await getReportData(ev);
    expect(data.totals).toMatchObject({
      registered: 4,
      walkIns: 1,
      registeredCame: 3,
      noShows: 1,
      checkins: 7,
      registeredForSessions: 3,
      mainOnly: 1,
      cameToSessions: 3, // Ali, Sara, Zed
      cameToMain: 2, // Ali, Omar
      sessionsAndMain: 1, // Ali
      tickedButNone: 1, // Lina
      cash: 20,
      joinedAtDoor: 1,
      entryFees: 1,
      daysAttended: [2, 1, 1], // 1 day: Omar, Zed · 2 days: Sara · 3 days: Ali
    });
    expect(data.sessionLabels).toEqual(["Linux fundamentals", "Networks under attack"]);
    expect(data.mainLabels).toEqual(["Main event"]);
    expect(data.cashByStaff).toEqual([{ name: hr.name, payments: 2, cash: 20 }]);

    const [d0, d1, d2] = data.days;
    const row = (d: typeof d0, name: string) => d.rows.find((r) => r.name === name)!;
    expect(row(d0, "Ali")).toMatchObject({ ticked: "Yes", membership: "—", registered: "Form", how: "QR", by: hr.name });
    expect(row(d0, "Sara")).toMatchObject({ ticked: "Not ticked", membership: "Member" });
    expect(row(d0, "Zed")).toMatchObject({ ticked: "Not ticked", registered: "Walk-in", how: "Walk-in" });
    expect(d0).toMatchObject({ tickable: true, tickedCount: 2, tickedCame: 1, cameWithoutTicking: 2, walkIns: 1 });
    expect(row(d1, "Ali")).toMatchObject({ membership: "Joined today", paid: "Membership · 15 DT", collectedBy: hr.name });
    expect(row(d1, "Sara")).toMatchObject({ membership: "Member", ticked: "Yes" });
    expect(d1).toMatchObject({ members: 2, cash: 15, payments: 1 });
    expect(row(d2, "Ali")).toMatchObject({ membership: "Member", ticked: null });
    expect(row(d2, "Omar")).toMatchObject({ membership: "—", paid: "Entry · 5 DT" });
    expect(d2.tickable).toBe(false);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildReportWorkbook(data)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["1 · Linux fundamentals", "2 · Networks under attack", "3 · Main event", "Statistics"]);
    const s1 = wb.worksheets[0];
    expect(s1.getCell("B2").value).toBe("Linux fundamentals");
    expect((s1.getRow(9).values as unknown[]).filter(Boolean)).toContain("Ticked this session");
    expect((wb.worksheets[2].getRow(9).values as unknown[]).filter(Boolean)).not.toContain("Ticked this session");
  });

  it("is admin-only, and downloads as .xlsx", async () => {
    const ev = await makeEvent();
    const hr = await makeStaff("hr");
    expect((await reportGET(req("GET", `/api/events/${ev}/report.xlsx`, { cookie: await cookieFor(hr) }), params({ id: ev }))).status).toBe(403);
    const admin = await makeStaff("admin");
    const res = await reportGET(req("GET", `/api/events/${ev}/report.xlsx`, { cookie: await cookieFor(admin) }), params({ id: ev }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
    expect(res.headers.get("content-disposition")).toMatch(/final-report-.*\.xlsx/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK"); // a zip, as every .xlsx is
    const log = await query("select details from audit_log where action = 'export' and event_id = $1", [ev]);
    expect(log.rows[0].details).toMatchObject({ format: "xlsx" });
  });
});
