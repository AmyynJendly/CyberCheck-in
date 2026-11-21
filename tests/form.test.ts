import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as formPOST } from "@/app/api/form-submit/route";
import { POST as walkinPOST } from "@/app/api/walkin/route";
import { POST as resendPOST } from "@/app/api/attendees/[id]/resend/route";
import { POST as retryPOST } from "@/app/api/admin/emails/retry-failed/route";
import { GET as searchGET } from "@/app/api/attendees/search/route";
import { closePool, query } from "@/lib/db";
import { devOutbox } from "@/lib/email";
import { qrContent } from "@/lib/qr-format";
import { body, cookieFor, makeEvent, makeStaff, params, req, uniq } from "./helpers";
import type { Staff } from "@/lib/auth";

type Ev = Awaited<ReturnType<typeof makeEvent>>;
let ev: Ev;
let hr: Staff;
let admin: Staff;

const submit = (e: Ev, payload: Record<string, unknown>, secret = e.secret) =>
  formPOST(req("POST", "/api/form-submit", { body: { event_slug: e.slug, ...payload }, headers: { "x-form-secret": secret } }), undefined);

const outboxFor = (email: string) => devOutbox().filter((m) => m.to === email);

beforeAll(async () => {
  hr = await makeStaff("hr");
  admin = await makeStaff("admin");
});
beforeEach(async () => {
  ev = await makeEvent({ days: [0, 1] });
  process.env.DEV_EMAIL_MODE = "log";
});
afterAll(() => closePool());

describe("/api/form-submit auth", () => {
  it("wrong secret → 401, unknown slug → 401, nothing stored", async () => {
    const email = `${uniq("a")}@example.com`;
    expect((await submit(ev, { response_id: "r1", full_name: "A", email }, "nope")).status).toBe(401);
    const res = await formPOST(
      req("POST", "/api/form-submit", { body: { event_slug: "does-not-exist", response_id: "r1", full_name: "A" }, headers: { "x-form-secret": ev.secret } }),
      undefined,
    );
    expect(res.status).toBe(401);
    const n = await query("select 1 from attendees where event_id = $1", [ev.id]);
    expect(n.rowCount).toBe(0);
    const log = await query("select details from audit_log where action = 'form_rejected' and event_id = $1", [ev.id]);
    expect(log.rowCount).toBe(1);
  });

  it("missing response_id → 400 (used by the Apps Script testConnection)", async () => {
    const res = await submit(ev, { full_name: "A" });
    expect(res.status).toBe(400);
  });
});

describe("idempotent form", () => {
  it("same response_id posted 3 times → 1 attendee, 1 email", async () => {
    const email = `${uniq("idem")}@Example.com `;
    const payload = { response_id: "resp-123", full_name: "Nour Ben Ali", email, phone: "+216 22 111 222", class_year: "1st", team_name: "" };
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await submit(ev, payload);
      expect(res.status).toBe(200);
      outcomes.push((await body<{ outcome: string }>(res)).outcome);
    }
    expect(outcomes).toEqual(["created", "duplicate_response", "duplicate_response"]);
    const rows = await query<{ email: string; email_status: string; form_response_id: string }>(
      "select email, email_status, form_response_id from attendees where event_id = $1",
      [ev.id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ email: email.trim().toLowerCase(), email_status: "sent", form_response_id: "resp-123" });
    expect(outboxFor(email.trim().toLowerCase())).toHaveLength(1);
  });

  it("same response_id posted 3 times in parallel → 1 attendee, 1 email", async () => {
    const email = `${uniq("par")}@example.com`;
    const payload = { response_id: "resp-par", full_name: "Parallel", email };
    const res = await Promise.all([1, 2, 3].map(() => submit(ev, payload)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await query("select 1 from attendees where event_id = $1", [ev.id])).rowCount).toBe(1);
    expect(outboxFor(email)).toHaveLength(1);
  });
});

describe("same email twice", () => {
  it("different response ids → 1 attendee, details updated, the same QR resent", async () => {
    const email = `${uniq("dup")}@example.com`;
    await submit(ev, { response_id: "first", full_name: "Old Name", email, team_name: "Team A" });
    const res = await submit(ev, { response_id: "second", full_name: "New Name", email: email.toUpperCase(), class_year: "3rd" });
    expect((await body<{ outcome: string }>(res)).outcome).toBe("updated");

    const rows = await query<{ full_name: string; team_name: string; class_year: string; qr_token: string; short_code: string }>(
      "select full_name, team_name, class_year, qr_token, short_code from attendees where event_id = $1",
      [ev.id],
    );
    expect(rows.rowCount).toBe(1);
    const a = rows.rows[0];
    expect(a).toMatchObject({ full_name: "New Name", team_name: "Team A", class_year: "3rd" });

    const sent = outboxFor(email);
    expect(sent).toHaveLength(2);
    // Both emails carry the same QR image and short code.
    expect(sent[0].png.equals(sent[1].png)).toBe(true);
    expect(sent[0].shortCode).toBe(a.short_code);
    expect(sent[1].shortCode).toBe(a.short_code);

    // Re-posting either response id (e.g. Apps Script syncAll) sends nothing more.
    await submit(ev, { response_id: "first", full_name: "New Name", email });
    await submit(ev, { response_id: "second", full_name: "New Name", email });
    expect(outboxFor(email)).toHaveLength(2);
    expect((await query("select 1 from attendees where event_id = $1", [ev.id])).rowCount).toBe(1);
  });

  it("the same email in a different event is a different attendee", async () => {
    const other = await makeEvent();
    const email = `${uniq("x")}@example.com`;
    await submit(ev, { response_id: "r", full_name: "X", email });
    await submit(other, { response_id: "r", full_name: "X", email });
    const r = await query("select 1 from attendees where email = $1", [email]);
    expect(r.rowCount).toBe(2);
  });
});

describe("email content", () => {
  it("has subject, cid:qr inline image, short code, warning and plain text", async () => {
    const email = `${uniq("c")}@example.com`;
    await submit(ev, { response_id: "c1", full_name: "Mariem <b>", email });
    const [m] = outboxFor(email);
    const a = await query<{ qr_token: string; short_code: string }>("select qr_token, short_code from attendees where email = $1", [email]);
    expect(m.subject).toBe(`Your official access pass — ${ev.name}`);
    expect(m.html).toContain('src="cid:qr"');
    expect(m.html).not.toContain("data:image");
    expect(m.html).toContain("Mariem &lt;b&gt;");
    expect(m.html).toContain(a.rows[0].short_code);
    expect(m.text).toContain(`Backup code (if the QR doesn't work): ${a.rows[0].short_code}`);
    expect(m.text).toContain("Don't share this code. It works once per day.");
    expect(m.html).toContain("Don&#39;t share this code. It works once per day.");
    expect(m.text).toContain("ISSAT Sousse");
    expect(m.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(qrContent(a.rows[0].qr_token)).toMatch(/^CT1:[A-Z2-7]{26}$/);
  });

  it("Gmail not configured → the email waits in the queue (not failed); admin retry sends it once fixed", async () => {
    process.env.DEV_EMAIL_MODE = "smtp"; // GMAIL_APP_PASSWORD is a placeholder in tests → can't send
    const email = `${uniq("f")}@example.com`;
    const res = await submit(ev, { response_id: "f1", full_name: "Fail", email });
    expect(res.status).toBe(200);
    const a = await query<{ email_status: string; email_error: string; email_attempts: number }>(
      "select email_status, email_error, email_attempts from attendees where email = $1",
      [email],
    );
    // Not even tried: no attempt used up, so nothing can end up "failed" before the password is set.
    expect(a.rows[0]).toMatchObject({ email_status: "pending", email_attempts: 0, email_error: null });

    process.env.DEV_EMAIL_MODE = "log";
    const hrRes = await retryPOST(req("POST", "/api/admin/emails/retry-failed", { cookie: await cookieFor(hr), body: {} }), undefined);
    expect(hrRes.status).toBe(403);
    const r = await retryPOST(req("POST", "/api/admin/emails/retry-failed", { cookie: await cookieFor(admin), body: { event_id: ev.id } }), undefined);
    expect(await body(r)).toMatchObject({ remaining: 0 });
    const after = await query<{ email_status: string }>("select email_status from attendees where email = $1", [email]);
    expect(after.rows[0].email_status).toBe("sent");
    expect(outboxFor(email)).toHaveLength(1);
  });

  it("a malformed address fails right away (no endless retries)", async () => {
    await submit(ev, { response_id: "bad1", full_name: "Bad", email: "not-an-email" });
    const a = await query<{ email_status: string; email_error: string }>("select email_status, email_error from attendees where event_id = $1", [ev.id]);
    expect(a.rows[0]).toEqual({ email_status: "failed", email_error: "Invalid email address." });
  });
});

describe("walk-ins", () => {
  it("any HR creates + checks in for today in one step, and the QR is emailed", async () => {
    const email = `${uniq("w")}@example.com`;
    const res = await walkinPOST(
      req("POST", "/api/walkin", { cookie: await cookieFor(hr), body: { event_id: ev.id, full_name: "Walk In", phone: "55 123 456", email } }),
      undefined,
    );
    const r = await body<{ status: string; attendee_id: string; short_code: string; day_label: string }>(res);
    expect(r).toMatchObject({ status: "OK", day_label: "Day 1" });
    const a = await query<{ source: string; added_by_staff_id: string; email_status: string }>(
      "select source, added_by_staff_id, email_status from attendees where id = $1",
      [r.attendee_id],
    );
    expect(a.rows[0]).toEqual({ source: "walk_in", added_by_staff_id: hr.id, email_status: "sent" });
    const c = await query<{ method: string; staff_id: string }>("select method, staff_id from checkins where attendee_id = $1", [r.attendee_id]);
    expect(c.rows).toEqual([{ method: "walk_in", staff_id: hr.id }]);
    expect(outboxFor(email)).toHaveLength(1);
  });

  it("name only is enough; an email already registered → EMAIL_EXISTS, nothing created", async () => {
    const cookie = await cookieFor(hr);
    const r1 = await body(await walkinPOST(req("POST", "/api/walkin", { cookie, body: { event_id: ev.id, full_name: "Only Name" } }), undefined));
    expect(r1.status).toBe("OK");
    const email = `${uniq("e")}@example.com`;
    await submit(ev, { response_id: "e1", full_name: "Registered", email });
    const r2 = await body(await walkinPOST(req("POST", "/api/walkin", { cookie, body: { event_id: ev.id, full_name: "Dup", email } }), undefined));
    expect(r2).toMatchObject({ status: "EMAIL_EXISTS", name: "Registered" });
    expect((await query("select 1 from attendees where event_id = $1", [ev.id])).rowCount).toBe(2);
  });

  it("missing name → 400", async () => {
    const res = await walkinPOST(req("POST", "/api/walkin", { cookie: await cookieFor(hr), body: { event_id: ev.id, full_name: "  " } }), undefined);
    expect(res.status).toBe(400);
  });
});

describe("search, resend, fix email", () => {
  it("finds by name, email, phone digits and short code", async () => {
    const email = `${uniq("s")}@example.com`;
    await submit(ev, { response_id: "s1", full_name: "Skander Trabelsi", email, phone: "+216 98 765 432" });
    const a = await query<{ short_code: string; id: string }>("select id, short_code from attendees where email = $1", [email]);
    const cookie = await cookieFor(hr);
    for (const q of ["skander", email.slice(0, 8), "98765", a.rows[0].short_code.toLowerCase()]) {
      const r = await body<{ results: { id: string }[] }>(
        await searchGET(req("GET", `/api/attendees/search?event_id=${ev.id}&q=${encodeURIComponent(q)}`, { cookie }), undefined),
      );
      expect(r.results.map((x) => x.id), q).toContain(a.rows[0].id);
    }
  });

  it("fix a typo'd email then resend the same QR; audit records who did it", async () => {
    const typo = `${uniq("typo")}@gmial.com`;
    await submit(ev, { response_id: "t1", full_name: "Typo", email: typo });
    const a = await query<{ id: string; qr_token: string }>("select id, qr_token from attendees where email = $1", [typo]);
    const fixed = typo.replace("gmial", "gmail");
    const res = await resendPOST(req("POST", `/api/attendees/${a.rows[0].id}/resend`, { cookie: await cookieFor(hr), body: { email: fixed } }), params({ id: a.rows[0].id }));
    expect(await body(res)).toMatchObject({ ok: true, email: fixed, email_status: "sent" });
    expect(outboxFor(fixed)).toHaveLength(1);
    expect(outboxFor(fixed)[0].png.equals(outboxFor(typo)[0].png)).toBe(true);
    const log = await query<{ action: string; staff_id: string }>(
      "select action, staff_id from audit_log where attendee_id = $1 and action in ('edit_email', 'resend') order by id",
      [a.rows[0].id],
    );
    expect(log.rows).toEqual([
      { action: "edit_email", staff_id: hr.id },
      { action: "resend", staff_id: hr.id },
    ]);
  });
});
