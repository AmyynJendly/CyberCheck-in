import { afterAll, describe, expect, it } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { GET as staffListGET } from "@/app/api/staff/list/route";
import { GET as adminEventsGET, POST as adminEventsPOST } from "@/app/api/admin/events/route";
import { PATCH as staffPATCH } from "@/app/api/admin/staff/[id]/route";
import { POST as staffPOST } from "@/app/api/admin/staff/route";
import { GET as eventsGET } from "@/app/api/events/route";
import { closePool, query } from "@/lib/db";
import { verifySession } from "@/lib/session";
import { TEST_PIN, body, cookieFor, makeStaff, params, req, uniq } from "./helpers";

const login = (staff_id: string, pin: string) => loginPOST(req("POST", "/api/auth/login", { body: { staff_id, pin } }), undefined);

afterAll(() => closePool());

describe("login", () => {
  it("correct PIN → httpOnly SameSite=Lax 12h session cookie", async () => {
    const s = await makeStaff("hr");
    const res = await login(s.id, TEST_PIN);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/ct_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=43200/);
    const token = cookie.match(/ct_session=([^;]+)/)![1];
    expect(await verifySession(token)).toMatchObject({ sid: s.id, role: "hr" });
    const audit = await query("select 1 from audit_log where staff_id = $1 and action = 'login'", [s.id]);
    expect(audit.rowCount).toBe(1);
  });

  it("staff list is public and only has ids + names of active staff", async () => {
    const s = await makeStaff("hr");
    await query("update staff set is_active = false where id = $1", [s.id]);
    const r = await body<{ staff: Record<string, unknown>[] }>(await staffListGET(req("GET", "/api/staff/list"), undefined));
    expect(r.staff.find((x) => x.id === s.id)).toBeUndefined();
    expect(Object.keys(r.staff[0]).sort()).toEqual(["id", "name"]);
  });
});

describe("PIN lockout", () => {
  it("locks after 5 wrong PINs for 10 minutes, even for the right PIN; logs login_failed", async () => {
    const s = await makeStaff("hr");
    const left: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await login(s.id, "000000");
      expect(res.status).toBe(401);
      left.push((await body(res)).attempts_left);
    }
    expect(left).toEqual([4, 3, 2, 1]);
    const fifth = await login(s.id, "000000");
    expect(fifth.status).toBe(423);

    const right = await login(s.id, TEST_PIN);
    expect(right.status).toBe(423);
    expect(right.headers.get("set-cookie")).toBeNull();

    const row = await query<{ mins: number }>("select extract(epoch from locked_until - now()) / 60 as mins from staff where id = $1", [s.id]);
    expect(Number(row.rows[0].mins)).toBeGreaterThan(9.5);
    expect(Number(row.rows[0].mins)).toBeLessThanOrEqual(10);
    const fails = await query("select 1 from audit_log where staff_id = $1 and action = 'login_failed'", [s.id]);
    expect(fails.rowCount).toBe(6);

    // After the lock expires the right PIN works again.
    await query("update staff set locked_until = now() - interval '1 second' where id = $1", [s.id]);
    expect((await login(s.id, TEST_PIN)).status).toBe(200);
  });

  it("parallel guessing can't get more than 5 tries", async () => {
    const s = await makeStaff("hr");
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => login(s.id, String(100000 + i))));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(4);
    expect(codes.filter((c) => c === 200)).toHaveLength(0);
    expect((await login(s.id, TEST_PIN)).status).toBe(423);
  });

  it("a successful login resets the counter", async () => {
    const s = await makeStaff("hr");
    for (let i = 0; i < 3; i++) await login(s.id, "000000");
    expect((await login(s.id, TEST_PIN)).status).toBe(200);
    const r = await query<{ failed_attempts: number }>("select failed_attempts from staff where id = $1", [s.id]);
    expect(r.rows[0].failed_attempts).toBe(0);
  });

  it("bad PIN format / unknown staff are rejected", async () => {
    expect((await login((await makeStaff()).id, "12ab")).status).toBe(400);
    expect((await login("00000000-0000-0000-0000-000000000000", TEST_PIN)).status).toBe(401);
  });
});

describe("roles", () => {
  it("HR can't use admin routes; admin can", async () => {
    const hr = await makeStaff("hr");
    const admin = await makeStaff("admin");
    expect((await adminEventsGET(req("GET", "/api/admin/events", { cookie: await cookieFor(hr) }), undefined)).status).toBe(403);
    expect((await adminEventsGET(req("GET", "/api/admin/events", { cookie: await cookieFor(admin) }), undefined)).status).toBe(200);
    expect((await eventsGET(req("GET", "/api/events"), undefined)).status).toBe(401);
  });

  it("deactivated staff lose access immediately (cookie still valid)", async () => {
    const hr = await makeStaff("hr");
    const cookie = await cookieFor(hr);
    expect((await eventsGET(req("GET", "/api/events", { cookie }), undefined)).status).toBe(200);
    await query("update staff set is_active = false where id = $1", [hr.id]);
    expect((await eventsGET(req("GET", "/api/events", { cookie }), undefined)).status).toBe(401);
  });

  it("admin creates an event (with secret + days) and staff; can't remove the last admin", async () => {
    const admin = await makeStaff("admin");
    const cookie = await cookieFor(admin);
    const slug = uniq("evt").toLowerCase();
    const created = await adminEventsPOST(
      req("POST", "/api/admin/events", { cookie, body: { slug, name: "Mini CTF", location: "Lab 3", days: [{ day_date: "2027-03-14" }, { day_date: "2027-03-15", label: "Finals" }] } }),
      undefined,
    );
    expect(created.status).toBe(201);
    const ev = await query<{ form_secret: string; labels: string[] }>(
      "select e.form_secret, array_agg(d.label order by d.day_date) as labels from events e join event_days d on d.event_id = e.id where slug = $1 group by e.id",
      [slug],
    );
    expect(ev.rows[0].form_secret.length).toBeGreaterThanOrEqual(32);
    expect(ev.rows[0].labels).toEqual(["Day 1", "Finals"]);
    const dup = await adminEventsPOST(req("POST", "/api/admin/events", { cookie, body: { slug, name: "Again" } }), undefined);
    expect(dup.status).toBe(409);

    const st = await staffPOST(req("POST", "/api/admin/staff", { cookie, body: { name: "New HR", pin: "135790" } }), undefined);
    expect(st.status).toBe(201);
    const { id } = await body<{ id: string }>(st);
    expect((await login(id, "135790")).status).toBe(200);

    const reset = await staffPATCH(req("PATCH", `/api/admin/staff/${id}`, { cookie, body: { pin: "112233" } }), params({ id }));
    expect(reset.status).toBe(200);
    expect((await login(id, "135790")).status).toBe(401);
    expect((await login(id, "112233")).status).toBe(200);

    const self = await staffPATCH(req("PATCH", `/api/admin/staff/${admin.id}`, { cookie, body: { is_active: false } }), params({ id: admin.id }));
    expect(self.status).toBe(400);
    const pinRow = await query("select pin_hash from staff where id = $1", [id]);
    expect(pinRow.rows[0].pin_hash).toMatch(/^\$2[aby]\$/);
  });
});
