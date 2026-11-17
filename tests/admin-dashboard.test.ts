// Admin dashboard: overview numbers, people list, pasted registrations, email template.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as overviewGET } from "@/app/api/admin/events/[id]/overview/route";
import { GET as peopleGET } from "@/app/api/admin/events/[id]/people/route";
import { POST as importPOST } from "@/app/api/admin/events/[id]/import/route";
import { POST as previewPOST } from "@/app/api/admin/events/[id]/email-preview/route";
import { POST as testPOST } from "@/app/api/admin/events/[id]/email-test/route";
import { PATCH as eventPATCH } from "@/app/api/admin/events/[id]/route";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { closePool, query } from "@/lib/db";
import { devOutbox, drainEmailQueue } from "@/lib/email";
import { body, cookieFor, makeEvent, makeStaff, params, req, tokenOf } from "./helpers";
import type { Staff } from "@/lib/auth";

let admin: Staff;
let adminCookie: string;
let hrCookie: string;

beforeAll(async () => {
  process.env.DEV_EMAIL_MODE = "log";
  admin = await makeStaff("admin");
  adminCookie = await cookieFor(admin);
  hrCookie = await cookieFor(await makeStaff("hr"));
});
afterAll(() => closePool());

describe("pasted registrations", () => {
  it("imports a pasted Google Sheet, emails everyone once; re-import changes nothing", async () => {
    const ev = await makeEvent();
    const text = "Horodateur\tFull name\tEmail\tPhone\n15/11/2026\tLina Ayari\tlina.dash@example.com\t20 111 222\n15/11/2026\tSami K\tsami.dash@example.com\t";
    const dry = await body(await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: adminCookie, body: { text, dry_run: true } }), params({ id: ev.id })));
    expect(dry).toMatchObject({ count: 2, preview: [{ full_name: "Lina Ayari", email: "lina.dash@example.com", phone: "20 111 222" }, { full_name: "Sami K" }] });

    expect((await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: hrCookie, body: { text } }), params({ id: ev.id }))).status).toBe(403);
    const r1 = await body(await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: adminCookie, body: { text } }), params({ id: ev.id })));
    expect(r1).toMatchObject({ created: 2, emails_queued: 2 });
    await drainEmailQueue();
    expect(devOutbox().filter((m) => m.to === "lina.dash@example.com")).toHaveLength(1);

    const r2 = await body(await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: adminCookie, body: { text } }), params({ id: ev.id })));
    expect(r2).toMatchObject({ created: 0, unchanged: 2, emails_queued: 0 });
    expect((await query("select 1 from attendees where event_id = $1", [ev.id])).rowCount).toBe(2);
  });
});

describe("overview and people", () => {
  it("shows per-day check-ins against capacity, and everyone with their status", async () => {
    const ev = await makeEvent({ days: [0, 1] });
    await query("update event_days set capacity = 80 where id = $1", [ev.days[0].id]);
    const text = "Name\tEmail\nA One\ta1.ov@example.com\nB Two\tb2.ov@example.com\nC Three\tc3.ov@example.com";
    await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: adminCookie, body: { text } }), params({ id: ev.id }));
    const ids = await query<{ id: string }>("select id from attendees where event_id = $1 order by full_name", [ev.id]);
    for (const { id } of ids.rows.slice(0, 2)) {
      await checkinPOST(req("POST", "/api/checkin", { cookie: hrCookie, body: { event_id: ev.id, token: await tokenOf(id) } }), undefined);
    }

    expect((await overviewGET(req("GET", `/api/admin/events/${ev.id}/overview`, { cookie: hrCookie }), params({ id: ev.id }))).status).toBe(403);
    const o = await body<{ registered: number; today: { checked_in: number; capacity: number }; days: { checked_in: number }[] }>(
      await overviewGET(req("GET", `/api/admin/events/${ev.id}/overview`, { cookie: adminCookie }), params({ id: ev.id })),
    );
    expect(o.registered).toBe(3);
    expect(o.today).toMatchObject({ checked_in: 2, capacity: 80 });
    expect(o.days.map((d) => d.checked_in)).toEqual([2, 0]);

    const p = await body<{ people: { full_name: string; days: Record<string, { by: string }> }[] }>(
      await peopleGET(req("GET", `/api/admin/events/${ev.id}/people`, { cookie: adminCookie }), params({ id: ev.id })),
    );
    expect(p.people.map((x) => x.full_name)).toEqual(["A One", "B Two", "C Three"]);
    expect(Object.keys(p.people[0].days)).toEqual([ev.days[0].id]);
    expect(Object.keys(p.people[2].days)).toEqual([]);
  });
});

describe("email template", () => {
  it("admin saves a template; preview and real emails use it; reset goes back to the default", async () => {
    const ev = await makeEvent();
    const tpl = { email_subject: "Ton QR pour {{event}}", email_body: "Salut {{name}},\n\n{{qr}}\n\nCode : {{code}}" };
    expect((await eventPATCH(req("PATCH", `/api/admin/events/${ev.id}`, { cookie: adminCookie, body: tpl }), params({ id: ev.id }))).status).toBe(200);

    const prev = await body<{ subject: string; html: string }>(
      await previewPOST(req("POST", `/api/admin/events/${ev.id}/email-preview`, { cookie: adminCookie, body: {} }), params({ id: ev.id })),
    );
    expect(prev.subject).toBe(`Ton QR pour ${ev.name}`);
    expect(prev.html).toContain("data:image/png;base64,");
    expect(prev.html).toContain("Salut <strong>Yasmine Gharbi</strong>,");

    const t = await testPOST(req("POST", `/api/admin/events/${ev.id}/email-test`, { cookie: adminCookie, body: { to: "me.test@example.com" } }), params({ id: ev.id }));
    expect(await body(t)).toEqual({ ok: true, to: "me.test@example.com" });
    expect(devOutbox().find((m) => m.to === "me.test@example.com")?.subject).toBe(`[TEST] Ton QR pour ${ev.name}`);

    await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: adminCookie, body: { text: "Name\tEmail\nReal Person\treal.tpl@example.com" } }), params({ id: ev.id }));
    await drainEmailQueue();
    const real = devOutbox().find((m) => m.to === "real.tpl@example.com")!;
    expect(real.subject).toBe(`Ton QR pour ${ev.name}`);
    expect(real.text).toContain("Salut Real Person,");
    // The secret inside the QR never appears in the email (only the 6-letter backup code does).
    const tok = await query<{ qr_token: string }>("select qr_token from attendees where email = 'real.tpl@example.com'");
    expect(real.html).not.toContain(tok.rows[0].qr_token);
    expect(real.text).not.toContain(tok.rows[0].qr_token);

    await eventPATCH(req("PATCH", `/api/admin/events/${ev.id}`, { cookie: adminCookie, body: { email_subject: "", email_body: "" } }), params({ id: ev.id }));
    const r = await query<{ email_subject: string | null; email_body: string | null }>("select email_subject, email_body from events where id = $1", [ev.id]);
    expect(r.rows[0]).toEqual({ email_subject: null, email_body: null });
  });
});
