import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { GET as adminEventsGET, POST as adminEventsPOST } from "@/app/api/admin/events/route";
import { PATCH as staffPATCH } from "@/app/api/admin/staff/[id]/route";
import { POST as staffPOST } from "@/app/api/admin/staff/route";
import { POST as unblockPOST } from "@/app/api/admin/staff/unblock/route";
import { GET as eventsGET } from "@/app/api/events/route";
import { closePool, query } from "@/lib/db";
import { hashPin } from "@/lib/pin";
import { verifySession } from "@/lib/session";
import { body, cookieFor, freshPin, makeStaff, makeStaffWithPin, params, req, uniq } from "./helpers";

const login = (pin: string, ip = "10.0.0.1") =>
  loginPOST(req("POST", "/api/auth/login", { body: { pin }, headers: { "x-real-ip": ip } }), undefined);

// A PIN nobody has (freshPin never returns values below 300000).
const WRONG = "000001";

afterAll(() => closePool());
beforeEach(async () => {
  await query("delete from login_throttle");
});

describe("PIN-only login", () => {
  it("the PIN alone signs in the right person: httpOnly SameSite=Lax 12h cookie", async () => {
    const [p1, p2] = [freshPin(), freshPin()];
    const a = await makeStaffWithPin(p1, "hr");
    const b = await makeStaffWithPin(p2, "admin");
    const res = await login(p1);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/ct_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(await verifySession(cookie.match(/ct_session=([^;]+)/)![1])).toMatchObject({ sid: a.id, role: "hr" });
    expect(await body(await login(p2))).toMatchObject({ staff: { id: b.id, role: "admin" } });
    expect((await query("select 1 from audit_log where staff_id = $1 and action = 'login'", [a.id])).rowCount).toBe(1);
  });

  it("wrong PIN, bad format, deactivated staff are rejected", async () => {
    expect((await login(WRONG)).status).toBe(401);
    expect((await login("12ab")).status).toBe(400);
    const pin = freshPin();
    const s = await makeStaffWithPin(pin);
    await query("update staff set is_active = false where id = $1", [s.id]);
    expect((await login(pin)).status).toBe(401);
  });

  it("accounts from before PIN-only login sign in once by PIN, then get a lookup", async () => {
    const pin = freshPin();
    const r = await query<{ id: string }>("insert into staff (name, pin_hash, role) values ($1, $2, 'hr') returning id", [uniq("legacy"), await hashPin(pin)]);
    expect(await body(await login(pin))).toMatchObject({ staff: { id: r.rows[0].id } });
    const row = await query<{ pin_lookup: string | null }>("select pin_lookup from staff where id = $1", [r.rows[0].id]);
    expect(row.rows[0].pin_lookup).toMatch(/^[0-9a-f]{64}$/);
    expect((await login(pin)).status).toBe(200);
  });
});

describe("wrong-PIN limits", () => {
  it("5 tries per phone (IP) per 15 min, even for a right PIN; other phones still work", async () => {
    const pin = freshPin();
    await makeStaffWithPin(pin);
    for (let i = 0; i < 5; i++) expect((await login(WRONG, "10.1.1.1")).status).toBe(401);
    const blocked = await login(pin, "10.1.1.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect((await login(pin, "10.1.1.2")).status).toBe(200);

    // When the window is over, the phone can try again.
    await query("update login_throttle set window_start = now() - interval '16 minutes' where key = 'ip:10.1.1.1'");
    expect((await login(pin, "10.1.1.1")).status).toBe(200);
  });

  it("parallel guessing from one phone can't get more than 5 tries", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => login(String(100000 + i), "10.2.2.2")));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
    expect(codes.filter((c) => c === 200)).toHaveLength(0);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(15);
  });

  it("app-wide: 20 wrong PINs an hour from any phones blocks new tries; a success gives its try back", async () => {
    const pin = freshPin();
    await makeStaffWithPin(pin);
    expect((await login(pin, "10.3.0.99")).status).toBe(200); // doesn't count
    for (let i = 0; i < 20; i++) expect((await login(WRONG, `10.3.${i}.1`)).status).toBe(401);
    expect((await login(pin, "10.3.200.1")).status).toBe(429);
    const g = await query<{ attempts: number }>("select attempts from login_throttle where key = 'global'");
    expect(g.rows[0].attempts).toBe(21);
  });

  it("a successful login resets the phone's counter", async () => {
    const pin = freshPin();
    await makeStaffWithPin(pin);
    for (let i = 0; i < 4; i++) await login(WRONG, "10.4.4.4");
    expect((await login(pin, "10.4.4.4")).status).toBe(200);
    const r = await query<{ attempts: number }>("select attempts from login_throttle where key = 'ip:10.4.4.4'");
    expect(r.rows[0].attempts).toBe(0);
  });

  it("an admin can unblock logins", async () => {
    const pin = freshPin();
    await makeStaffWithPin(pin);
    for (let i = 0; i < 5; i++) await login(WRONG, "10.5.5.5");
    expect((await login(pin, "10.5.5.5")).status).toBe(429);
    const hr = await makeStaff("hr");
    expect((await unblockPOST(req("POST", "/api/admin/staff/unblock", { cookie: await cookieFor(hr), body: {} }), undefined)).status).toBe(403);
    const admin = await makeStaff("admin");
    expect((await unblockPOST(req("POST", "/api/admin/staff/unblock", { cookie: await cookieFor(admin), body: {} }), undefined)).status).toBe(200);
    expect((await login(pin, "10.5.5.5")).status).toBe(200);
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

  it("admin creates an event (with secret + days) and staff; PINs are unique; can't remove the last admin", async () => {
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
    expect(await body(await login("135790"))).toMatchObject({ staff: { id } });

    // Same PIN for someone else: refused.
    const taken = await staffPOST(req("POST", "/api/admin/staff", { cookie, body: { name: "Copycat", pin: "135790" } }), undefined);
    expect(taken.status).toBe(409);
    expect(await body(taken)).toMatchObject({ error: "PIN_TAKEN" });

    const reset = await staffPATCH(req("PATCH", `/api/admin/staff/${id}`, { cookie, body: { pin: "112233" } }), params({ id }));
    expect(reset.status).toBe(200);
    expect((await login("135790")).status).toBe(401);
    expect((await login("112233")).status).toBe(200);

    const other = await staffPOST(req("POST", "/api/admin/staff", { cookie, body: { name: "Other HR", pin: "224466" } }), undefined);
    const otherId = (await body<{ id: string }>(other)).id;
    const clash = await staffPATCH(req("PATCH", `/api/admin/staff/${otherId}`, { cookie, body: { pin: "112233" } }), params({ id: otherId }));
    expect(clash.status).toBe(409);

    const self = await staffPATCH(req("PATCH", `/api/admin/staff/${admin.id}`, { cookie, body: { is_active: false } }), params({ id: admin.id }));
    expect(self.status).toBe(400);
    const pinRow = await query("select pin_hash from staff where id = $1", [id]);
    expect(pinRow.rows[0].pin_hash).toMatch(/^\$2[aby]\$/);
  });
});
