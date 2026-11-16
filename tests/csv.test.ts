import { afterAll, describe, expect, it } from "vitest";
import { GET as csvGET } from "@/app/api/events/[id]/export.csv/route";
import { GET as backupGET } from "@/app/api/events/[id]/backup/route";
import { GET as backupPdfGET } from "@/app/api/events/[id]/backup.pdf/route";
import { checkInByToken } from "@/lib/checkin";
import { createWalkIn, ingestFormSubmission } from "@/lib/attendees";
import { csvCell, tickedDay } from "@/lib/csv";
import { closePool, query } from "@/lib/db";
import { DAY_MS, cookieFor, makeEvent, makeStaff, params, req, tokenOf } from "./helpers";

afterAll(() => closePool());

/** Minimal RFC 4180 parser for the test. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (c !== "\r") cell += c;
  }
  return rows;
}

describe("CSV export", () => {
  it("has name, email, phone, class, team, source, added_by and per-day checked_at + checked_by", async () => {
    const ev = await makeEvent({ days: [0, 1] });
    const sara = await makeStaff("hr", "Sara");
    const omar = await makeStaff("hr", "Omar");

    const a = await ingestFormSubmission(ev.id, "r1", {
      full_name: 'Amine "The Root" Haddad',
      email: "amine@example.com",
      phone: "+216 20 123 456",
      class_year: "2nd year, ING",
      team_name: "=cmd|evil",
    });
    await checkInByToken({ staff: sara, eventId: ev.id, token: await tokenOf(a.attendeeId) });
    await checkInByToken({ staff: omar, eventId: ev.id, token: await tokenOf(a.attendeeId), now: new Date(Date.now() + DAY_MS) });
    const w = await createWalkIn({ eventId: ev.id, staff: omar, fields: { full_name: "Zeineb Walk", email: null, phone: null, class_year: null, team_name: "Blue" } });
    expect(w.status).toBe("OK");
    await ingestFormSubmission(ev.id, "r3", { full_name: "Bilel No-show", email: "bilel@example.com", phone: null, class_year: null, team_name: null });

    // HR can't export; admins can.
    expect((await csvGET(req("GET", `/api/events/${ev.id}/export.csv`, { cookie: await cookieFor(sara) }), params({ id: ev.id }))).status).toBe(403);
    const admin = await makeStaff("admin");
    const res = await csvGET(req("GET", `/api/events/${ev.id}/export.csv`, { cookie: await cookieFor(admin) }), params({ id: ev.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(new RegExp(`attachment; filename="${ev.slug}-all-`));
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 3).toString("hex")).toBe("efbbbf"); // UTF-8 BOM for Excel
    const [header, ...rows] = parseCsv(bytes.subarray(3).toString("utf8"));
    const d1 = `Day 1 (${ev.days[0].day_date})`;
    const d2 = `Day 2 (${ev.days[1].day_date})`;
    expect(header).toEqual([
      "name", "email", "phone", "class_year", "team_name", "source", "added_by", "short_code", "email_status", "registered_at",
      `${d1} checked_at`, `${d1} checked_by`, `${d1} method`,
      `${d2} checked_at`, `${d2} checked_by`, `${d2} method`,
    ]);
    expect(rows).toHaveLength(3);
    const rec = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
    // sorted by name
    expect(rec.map((r) => r.name)).toEqual(['Amine "The Root" Haddad', "Bilel No-show", "Zeineb Walk"]);

    const amine = rec[0];
    expect(amine).toMatchObject({
      email: "amine@example.com",
      phone: "+216 20 123 456",
      class_year: "2nd year, ING",
      team_name: "'=cmd|evil", // spreadsheet formula neutralised
      source: "form",
      added_by: "",
      [`${d1} checked_by`]: "Sara",
      [`${d1} method`]: "qr",
      [`${d2} checked_by`]: "Omar",
    });
    expect(amine[`${d1} checked_at`]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(amine[`${d2} checked_at`]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    expect(rec[1]).toMatchObject({ source: "form", [`${d1} checked_at`]: "", [`${d1} checked_by`]: "" });
    expect(rec[2]).toMatchObject({ source: "walk_in", added_by: "Omar", [`${d1} checked_by`]: "Omar", [`${d1} method`]: "walk_in", [`${d2} checked_at`]: "" });

    const log = await query("select staff_id from audit_log where action = 'export' and event_id = $1", [ev.id]);
    expect(log.rows).toEqual([{ staff_id: admin.id }]);

    // One CSV per session day: only the people checked in that day.
    const dayRes = await csvGET(req("GET", `/api/events/${ev.id}/export.csv?day_id=${ev.days[1].id}`, { cookie: await cookieFor(admin) }), params({ id: ev.id }));
    expect(dayRes.headers.get("content-disposition")).toContain(`${ev.slug}-${ev.days[1].day_date}-day-2.csv`);
    const [h2, ...r2] = parseCsv(Buffer.from(await dayRes.arrayBuffer()).subarray(3).toString("utf8"));
    expect(h2).toEqual(["name", "email", "phone", "class_year", "team_name", "source", "member_until", "checked_at", "checked_by", "method", "paid", "paid_to"]);
    expect(r2.map((r) => r[0])).toEqual(['Amine "The Root" Haddad']);
    expect(r2[0][8]).toBe("Omar");
  });

  it("points out sessions attended but not ticked on the form", async () => {
    const ev = await makeEvent({ days: [0, 1] });
    await query("update event_days set label = 'Linux fundamentals' where id = $1", [ev.days[0].id]);
    await query("update event_days set label = 'Offensive Web 101' where id = $1", [ev.days[1].id]);
    const hr = await makeStaff("hr");
    const a = await ingestFormSubmission(ev.id, "t1", {
      full_name: "Ticker", email: "ticker@example.com", phone: null, class_year: null, team_name: null,
      enrollment: "Linux fundamentals, Networks under attack",
    });
    await checkInByToken({ staff: hr, eventId: ev.id, token: await tokenOf(a.attendeeId) });
    await checkInByToken({ staff: hr, eventId: ev.id, token: await tokenOf(a.attendeeId), now: new Date(Date.now() + DAY_MS) });
    await ingestFormSubmission(ev.id, "t2", {
      full_name: "Web Only", email: "web@example.com", phone: null, class_year: null, team_name: null,
      enrollment: "Offensive Web 101(from interception to exploitation)",
    });
    await createWalkIn({ eventId: ev.id, staff: hr, fields: { full_name: "Walker", email: null, phone: null, class_year: null, team_name: null } });

    const cookie = await cookieFor(await makeStaff("admin"));
    const res = await csvGET(req("GET", `/api/events/${ev.id}/export.csv`, { cookie }), params({ id: ev.id }));
    const [header, ...rows] = parseCsv(Buffer.from(await res.arrayBuffer()).subarray(3).toString("utf8"));
    const rec = Object.fromEntries(rows.map((r) => [r[0], Object.fromEntries(header.map((h, i) => [h, r[i]]))]));
    const linux = `Linux fundamentals (${ev.days[0].day_date}) ticked`;
    const web = `Offensive Web 101 (${ev.days[1].day_date}) ticked`;
    expect(rec.Ticker).toMatchObject({ attended_not_ticked: "Offensive Web 101", [linux]: "yes", [web]: "NOT TICKED" });
    expect(rec["Web Only"]).toMatchObject({ attended_not_ticked: "", [linux]: "", [web]: "yes" });
    expect(rec.Walker).toMatchObject({ attended_not_ticked: "Linux fundamentals", [linux]: "NOT TICKED", [web]: "" });

    const dayRes = await csvGET(req("GET", `/api/events/${ev.id}/export.csv?day_id=${ev.days[1].id}`, { cookie }), params({ id: ev.id }));
    const [h2, ...r2] = parseCsv(Buffer.from(await dayRes.arrayBuffer()).subarray(3).toString("utf8"));
    expect(h2).toContain("ticked");
    expect(r2.map((r) => [r[0], r[h2.indexOf("ticked")]])).toEqual([["Ticker", "NOT TICKED"]]);
  });

  it("tickedDay matches a day label against the start of each ticked option", () => {
    const e = "Linux fundamentals, Offensive Web 101(from interception to exploitation), Cybersecurity and CTF fundamentals";
    expect(tickedDay(e, "Offensive Web 101")).toBe(true);
    expect(tickedDay(e, "Networks under attack")).toBe(false);
    expect(tickedDay(e, "Main event")).toBe(false);
    expect(tickedDay(null, "Linux fundamentals")).toBe(false);
  });

  it("csvCell keeps phone numbers and escapes quotes/commas", () => {
    expect(csvCell("+216 20 123 456")).toBe("+216 20 123 456");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
  });
});

describe("backup list", () => {
  it("printable HTML sorted by name with code and one tick box per day; backup.pdf redirects to it", async () => {
    const ev = await makeEvent({ days: [0, 1] });
    const hr = await makeStaff("hr");
    await ingestFormSubmission(ev.id, "b", { full_name: "Zed", email: null, phone: null, class_year: "1st", team_name: "T" });
    await ingestFormSubmission(ev.id, "a", { full_name: "Adam <script>", email: null, phone: null, class_year: null, team_name: null });
    expect((await backupGET(req("GET", `/api/events/${ev.id}/backup`, { cookie: await cookieFor(hr) }), params({ id: ev.id }))).status).toBe(403);
    const cookie = await cookieFor(await makeStaff("admin"));
    const res = await backupGET(req("GET", `/api/events/${ev.id}/backup`, { cookie }), params({ id: ev.id }));
    const html = await res.text();
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(html).toContain("@media print");
    expect(html.indexOf("Adam &lt;script&gt;")).toBeLessThan(html.indexOf("Zed"));
    expect(html.match(/class="box"/g)).toHaveLength(4);
    const codes = await query<{ short_code: string }>("select short_code from attendees where event_id = $1", [ev.id]);
    for (const c of codes.rows) expect(html).toContain(c.short_code);

    const pdf = await backupPdfGET(req("GET", `/api/events/${ev.id}/backup.pdf`, { cookie }), params({ id: ev.id }));
    expect(pdf.status).toBe(307);
    expect(pdf.headers.get("location")).toMatch(new RegExp(`/api/events/${ev.id}/backup$`));
  });
});
