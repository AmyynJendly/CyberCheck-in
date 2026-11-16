// Bootcamp details: "already a member" claims, the registration-stand sheet,
// admin-recorded payments, and the form's enrollment checkbox.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { POST as payPOST } from "@/app/api/checkin/pay/route";
import { POST as walkinPOST } from "@/app/api/walkin/route";
import { POST as formPOST } from "@/app/api/form-submit/route";
import { POST as importPOST } from "@/app/api/admin/events/[id]/import/route";
import { POST as adminPayPOST } from "@/app/api/admin/attendees/[id]/payment/route";
import { GET as reviewGET } from "@/app/api/admin/members/review/route";
import { POST as reviewPOST } from "@/app/api/admin/members/[id]/review/route";
import { GET as paymentsGET } from "@/app/api/events/[id]/payments/route";
import { checkInByToken } from "@/lib/checkin";
import { cleanAttendeeFields, ingestFormSubmission } from "@/lib/attendees";
import { closePool, query } from "@/lib/db";
import { devOutbox, drainEmailQueue } from "@/lib/email";
import { newFormSecret } from "@/lib/ids";
import { DAY_MS, body, cookieFor, dateIn, makeStaff, params, req, tokenOf, uniq } from "./helpers";
import type { Staff } from "@/lib/auth";

let hr: Staff;
let admin: Staff;
let hrCookie: string;
let adminCookie: string;

/** Bootcamp: day 0 free · days 1–3 members only · day 4 main event (members free, others 5 DT). */
async function bootcamp() {
  const slug = uniq("boot");
  const secret = newFormSecret();
  const e = await query<{ id: string }>(
    "insert into events (slug, name, form_secret, membership_fee) values ($1, 'Bootcamp', $2, 15) returning id",
    [slug, secret],
  );
  const id = e.rows[0].id;
  const rules = ["free", "members", "members", "members", "members_or_fee"];
  const days: string[] = [];
  for (const [i, access] of rules.entries()) {
    const d = await query<{ id: string }>(
      "insert into event_days (event_id, day_date, label, access, entry_fee) values ($1, $2, $3, $4, 5) returning id",
      [id, dateIn(i), i === 4 ? "Main event" : `Session ${i + 1}`, access],
    );
    days.push(d.rows[0].id);
  }
  return { id, slug, secret, days };
}
const onDay = (n: number) => new Date(Date.now() + n * DAY_MS);
async function person(eventId: string, name: string, email: string | null = `${uniq("p")}@example.com`) {
  const r = await ingestFormSubmission(eventId, uniq("resp"), cleanAttendeeFields({ full_name: name, email }));
  return { id: r.attendeeId, token: await tokenOf(r.attendeeId) };
}

beforeAll(async () => {
  process.env.DEV_EMAIL_MODE = "log";
  hr = await makeStaff("hr", "Sara");
  admin = await makeStaff("admin", "Amyyn");
  hrCookie = await cookieFor(hr);
  adminCookie = await cookieFor(admin);
});
afterAll(() => closePool());

describe("already a member, not on the list", () => {
  it("HR admits them without money; later days are free; an admin reviews (reject → asked to pay again)", async () => {
    const ev = await bootcamp();
    const p = await person(ev.id, "Claimer");
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: onDay(1) })).status).toBe("PAYMENT_REQUIRED");

    // The route uses today's date; today is day 0 (free), so test the claim through the lib on day 1.
    const { payAndCheckIn } = await import("@/lib/checkin");
    const r = await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: p.id, kind: "claim", method: "qr", now: onDay(1) });
    expect(r).toMatchObject({ status: "OK", is_member: true, payment: null, claimed: true });
    expect((await query("select 1 from payments where attendee_id = $1", [p.id])).rowCount).toBe(0);
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: onDay(2) })).status).toBe("OK");

    expect((await reviewGET(req("GET", "/api/admin/members/review", { cookie: hrCookie }), undefined)).status).toBe(403);
    const list = await body<{ members: { id: string; full_name: string; claimed_by: string }[] }>(
      await reviewGET(req("GET", "/api/admin/members/review", { cookie: adminCookie }), undefined),
    );
    const m = list.members.find((x) => x.full_name === "Claimer")!;
    expect(m.claimed_by).toBe("Sara");
    const audit = await query("select 1 from audit_log where action = 'claim_member' and attendee_id = $1 and staff_id = $2", [p.id, hr.id]);
    expect(audit.rowCount).toBe(1);

    await reviewPOST(req("POST", `/api/admin/members/${m.id}/review`, { cookie: adminCookie, body: { decision: "reject" } }), params({ id: m.id }));
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: onDay(3) })).status).toBe("PAYMENT_REQUIRED");
  });

  it("confirm keeps the membership and clears the review", async () => {
    const ev = await bootcamp();
    const p = await person(ev.id, "Confirmed Claimer");
    const { payAndCheckIn } = await import("@/lib/checkin");
    await payAndCheckIn({ staff: hr, eventId: ev.id, attendeeId: p.id, kind: "claim", method: "manual", now: onDay(1) });
    const mid = (await query<{ member_id: string }>("select member_id from attendees where id = $1", [p.id])).rows[0].member_id;
    await reviewPOST(req("POST", `/api/admin/members/${mid}/review`, { cookie: adminCookie, body: { decision: "confirm" } }), params({ id: mid }));
    expect((await query<{ needs_review: boolean }>("select needs_review from members where id = $1", [mid])).rows[0].needs_review).toBe(false);
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: onDay(4) })).status).toBe("OK");
  });

  it("works in Add Person too (route, today = a members-only day)", async () => {
    const ev = await bootcamp();
    await query("update event_days set access = 'members' where id = $1", [ev.days[0]]);
    const first = await body(await walkinPOST(req("POST", "/api/walkin", { cookie: hrCookie, body: { event_id: ev.id, full_name: "Walk Claimer", email: `${uniq("wc")}@example.com` } }), undefined));
    expect(first.status).toBe("PAYMENT_REQUIRED");
    const r = await body(
      await walkinPOST(req("POST", "/api/walkin", { cookie: hrCookie, body: { event_id: ev.id, full_name: "Walk Claimer", email: `${uniq("wc")}@example.com`, payment: "claim" } }), undefined),
    );
    expect(r).toMatchObject({ status: "OK", is_member: true, payment: null, claimed: true });
  });

  it("the pay route accepts claim", async () => {
    const ev = await bootcamp();
    await query("update event_days set access = 'members' where id = $1", [ev.days[0]]);
    const p = await person(ev.id, "Route Claimer");
    const r = await body(await payPOST(req("POST", "/api/checkin/pay", { cookie: hrCookie, body: { event_id: ev.id, attendee_id: p.id, kind: "claim" } }), undefined));
    expect(r).toMatchObject({ status: "OK", claimed: true });
  });
});

describe("admin panel payments", () => {
  it("admin sells the membership on the free first session (no check-in needed); HR can't", async () => {
    const ev = await bootcamp();
    const p = await person(ev.id, "Early Joiner");
    const call = (cookie: string, kind: string) =>
      adminPayPOST(req("POST", `/api/admin/attendees/${p.id}/payment`, { cookie, body: { kind } }), params({ id: p.id }));
    expect((await call(hrCookie, "membership")).status).toBe(403);
    expect((await call(adminCookie, "membership")).status).toBe(200);
    expect((await call(adminCookie, "membership")).status).toBe(409); // already a member
    const pay = await query<{ kind: string; amount: number; channel: string; event_day_id: string }>(
      "select kind, amount, channel, event_day_id from payments where attendee_id = $1",
      [p.id],
    );
    expect(pay.rows).toEqual([{ kind: "membership", amount: 15, channel: "desk", event_day_id: ev.days[0] }]);
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: onDay(2) })).status).toBe("OK");
  });

  it("admin records the main-event entry fee", async () => {
    const ev = await bootcamp();
    const p = await person(ev.id, "Competitor");
    const call = () => adminPayPOST(req("POST", `/api/admin/attendees/${p.id}/payment`, { cookie: adminCookie, body: { kind: "entry" } }), params({ id: p.id }));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(409);
    expect(await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: onDay(4) })).toMatchObject({ status: "OK", is_member: false, payment: null });
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: p.token, now: onDay(1) })).status).toBe("PAYMENT_REQUIRED");
  });
});

describe("enrollment checkbox", () => {
  it("the form's checkbox answer is stored and understood", async () => {
    const ev = await bootcamp();
    const send = (id: string, enrollment: string) =>
      formPOST(
        req("POST", "/api/form-submit", {
          body: { event_slug: ev.slug, response_id: id, full_name: id, email: `${uniq(id)}@example.com`, enrollment },
          headers: { "x-form-secret": ev.secret },
        }),
        undefined,
      );
    await send("both", "Sessions du bootcamp, Compétition finale (CTF)");
    await send("main", "Main event");
    await send("odd", "Something else");
    const r = await query<{ full_name: string; enrollment: string; enroll_sessions: boolean | null; enroll_main: boolean | null }>(
      "select full_name, enrollment, enroll_sessions, enroll_main from attendees where event_id = $1 order by full_name",
      [ev.id],
    );
    expect(r.rows).toEqual([
      { full_name: "both", enrollment: "Sessions du bootcamp, Compétition finale (CTF)", enroll_sessions: true, enroll_main: true },
      { full_name: "main", enrollment: "Main event", enroll_sessions: false, enroll_main: true },
      { full_name: "odd", enrollment: "Something else", enroll_sessions: null, enroll_main: null },
    ]);
  });
});

describe("registration-stand sheet", () => {
  it("detects the columns, records stand payments, doesn't re-email, and re-import changes nothing", async () => {
    const ev = await bootcamp();
    // Already registered through the form (QR already emailed).
    const existingEmail = `${uniq("lina")}@example.com`;
    await ingestFormSubmission(ev.id, "form-1", cleanAttendeeFields({ full_name: "Lina Ayari", email: existingEmail }));
    await drainEmailQueue();
    const sentBefore = devOutbox().filter((m) => m.to === existingEmail).length;
    expect(sentBefore).toBe(1);

    const omar = `${uniq("omar")}@example.com`;
    const text = [
      "Horodateur\tNom et prénom\tEmail\tTéléphone\tVous participez à\tPayé",
      `14/11/2026 10:02\tLina Ayari\t${existingEmail}\t20 111 222\tSessions, Compétition\tOui`,
      `14/11/2026 10:05\tOmar Kefi\t${omar}\t55 000 111\tCompétition\t5`,
      `14/11/2026 10:09\tRim Saidi\t${uniq("rim")}@example.com\t\tSessions\t`,
      `14/11/2026 10:12\tUnknown Choice\t${uniq("u")}@example.com\t\t\toui`,
    ].join("\n");

    expect((await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: hrCookie, body: { text, dry_run: true } }), params({ id: ev.id }))).status).toBe(403);
    const dry = await body<{
      mapping: Record<string, number>;
      enrollment_values: { value: string; meaning: string }[];
      summary: Record<string, number>;
      unclear_rows: { full_name: string }[];
    }>(await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: adminCookie, body: { text, dry_run: true } }), params({ id: ev.id })));
    expect(dry.mapping).toEqual({ name: 1, email: 2, phone: 3, enrollment: 4, paid: 5 });
    expect(dry.enrollment_values).toEqual([
      { value: "Sessions", count: 2, meaning: "sessions" },
      { value: "Compétition", count: 2, meaning: "main" },
    ].map(({ value, meaning }) => expect.objectContaining({ value, meaning })));
    expect(dry.summary).toEqual({ paid_membership: 1, paid_entry: 1, unclear: 1, not_paid: 1 });
    expect(dry.unclear_rows.map((r) => r.full_name)).toEqual(["Unknown Choice"]);

    const res = await body(await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: adminCookie, body: { text } }), params({ id: ev.id })));
    expect(res).toMatchObject({ created: 3, updated: 1, memberships: 1, entries: 1, emails_queued: 3 });
    await drainEmailQueue();
    expect(devOutbox().filter((m) => m.to === existingEmail)).toHaveLength(sentBefore); // not emailed again
    expect(devOutbox().filter((m) => m.to === omar)).toHaveLength(1);

    // Lina: member from the stand → free on sessions and the main event.
    const lina = (await query<{ id: string }>("select id from attendees where email = $1", [existingEmail])).rows[0];
    const linaToken = await tokenOf(lina.id);
    expect(await checkInByToken({ staff: hr, eventId: ev.id, token: linaToken, now: onDay(2) })).toMatchObject({ status: "OK", is_member: true });
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: linaToken, now: onDay(4) })).status).toBe("OK");
    // Omar: paid the main event only → free on the main event, asked to pay on a session.
    const omarId = (await query<{ id: string }>("select id from attendees where email = $1", [omar])).rows[0].id;
    const omarToken = await tokenOf(omarId);
    expect(await checkInByToken({ staff: hr, eventId: ev.id, token: omarToken, now: onDay(4) })).toMatchObject({ status: "OK", is_member: false, payment: null });
    expect((await checkInByToken({ staff: hr, eventId: ev.id, token: omarToken, now: onDay(3) })).status).toBe("PAYMENT_REQUIRED");

    // Stand money is separate from cash taken at the door.
    const cash = await body<{ total: number; stand: { memberships: number; entries: number; total: number } }>(
      await paymentsGET(req("GET", `/api/events/${ev.id}/payments`, { cookie: adminCookie }), params({ id: ev.id })),
    );
    expect(cash.total).toBe(0);
    expect(cash.stand).toEqual({ memberships: 1, entries: 1, total: 20 });

    // Importing the same sheet again changes nothing.
    const again = await body(await importPOST(req("POST", `/api/admin/events/${ev.id}/import`, { cookie: adminCookie, body: { text } }), params({ id: ev.id })));
    expect(again).toMatchObject({ created: 0, memberships: 0, entries: 0, emails_queued: 0, already_member: 1 });
    expect((await query("select 1 from payments where event_id = $1", [ev.id])).rowCount).toBe(2);
  });

  it("the admin can override the column choice and what an answer means", async () => {
    const ev = await bootcamp();
    const text = "Who\tContact\tTrack\tStatus\nSami\tsami.track@example.com\tTrack A\tyes";
    const dry = await body<{ summary: Record<string, number> }>(
      await importPOST(
        req("POST", `/api/admin/events/${ev.id}/import`, {
          cookie: adminCookie,
          body: { text, dry_run: true, mapping: { name: 0, email: 1, enrollment: 2, paid: 3 }, meanings: { "Track A": "main" } },
        }),
        params({ id: ev.id }),
      ),
    );
    expect(dry.summary).toEqual({ paid_membership: 0, paid_entry: 1, unclear: 0, not_paid: 0 });
  });
});
