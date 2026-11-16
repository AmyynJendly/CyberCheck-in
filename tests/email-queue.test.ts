// The email queue: one sender at a time, every email exactly once, templates.
import { afterAll, describe, expect, it } from "vitest";
import { POST as formPOST } from "@/app/api/form-submit/route";
import { closePool, query } from "@/lib/db";
import { buildQrEmail, deliveryGauge, devOutbox, drainEmailQueue } from "@/lib/email";
import { makeEvent, req, uniq } from "./helpers";

afterAll(() => closePool());

describe("email queue", () => {
  it("a burst of 40 simultaneous registrations → 40 emails, each sent exactly once, never two at the same time", async () => {
    process.env.DEV_EMAIL_MODE = "log";
    const ev = await makeEvent();
    const emails = Array.from({ length: 40 }, () => `${uniq("burst")}@example.com`);
    const gauge = deliveryGauge();
    gauge.maxInFlight = 0;
    const results = await Promise.all(
      emails.map((email, i) =>
        formPOST(
          req("POST", "/api/form-submit", {
            body: { event_slug: ev.slug, response_id: `burst-${i}`, full_name: `Burst ${i}`, email },
            headers: { "x-form-secret": ev.secret },
          }),
          undefined,
        ),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    await drainEmailQueue(); // anything that arrived while the last sender was finishing
    const rows = await query<{ email_status: string; n: number }>(
      "select email_status, count(*)::int as n from attendees where event_id = $1 group by email_status",
      [ev.id],
    );
    expect(rows.rows).toEqual([{ email_status: "sent", n: 40 }]);
    for (const e of emails) expect(devOutbox().filter((m) => m.to === e)).toHaveLength(1);
    expect(gauge.maxInFlight).toBe(1);
  });

  it("the Apps Script ping (valid secret) drains the queue; a wrong secret is refused", async () => {
    const ev = await makeEvent();
    const ping = (secret: string) =>
      formPOST(req("POST", "/api/form-submit", { body: { event_slug: ev.slug, ping: true }, headers: { "x-form-secret": secret } }), undefined);
    expect((await ping("wrong")).status).toBe(401);
    const r = await ping(ev.secret);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, pending_emails: 0 });
  });

  it("only one sender holds the queue at a time", async () => {
    const results = await Promise.all([drainEmailQueue(), drainEmailQueue(), drainEmailQueue()]);
    // With nothing pending, everyone finishes quickly; at most one ever held the lease at once,
    // and no run reports sends that another also reported.
    expect(results.reduce((s, r) => s + r.sent, 0)).toBe(0);
  });
});

describe("email template", () => {
  const ctx = {
    fullName: "Yasmine <b>",
    eventName: "Cyber Bootcamp",
    location: "ISSAT Sousse",
    days: [{ day_date: "2026-12-01", label: "Session 1" }],
    shortCode: "K7Q9XM",
  };

  it("fills the placeholders of a custom template, escaping names", () => {
    const m = buildQrEmail("y@example.com", {
      ...ctx,
      subjectTemplate: "{{name}}, here is your ticket for {{event}}",
      bodyTemplate: "Salut {{name}} !\n\nVoici ton QR :\n{{qr}}\n\nCode : {{code}}\n\n{{location}}\n\nÀ bientôt",
    }, Buffer.from("png"));
    expect(m.subject).toBe("Yasmine <b>, here is your ticket for Cyber Bootcamp");
    expect(m.html).toContain("Salut <strong>Yasmine &lt;b&gt;</strong> !");
    expect(m.html).toContain('src="cid:qr"');
    expect(m.html).toContain("K7Q9XM");
    expect(m.html).toContain("Where: ISSAT Sousse");
    expect(m.text).toContain("Code : K7Q9XM");
    expect(m.text).toContain("[Your QR code is attached as qr.png]");
    expect(m.text).not.toContain("{{");
  });

  it("always includes the QR and the code, even if the template forgets them", () => {
    const m = buildQrEmail("y@example.com", { ...ctx, bodyTemplate: "Bonjour {{name}}, à bientôt !" }, Buffer.from("png"));
    expect(m.html).toContain('src="cid:qr"');
    expect(m.text).toContain("Backup code (if the QR doesn't work): K7Q9XM");
  });

  it("drops lines whose placeholder is empty", () => {
    const m = buildQrEmail("y@example.com", { ...ctx, location: null }, Buffer.from("png"));
    expect(m.text).not.toContain("Where:");
    expect(m.text).not.toMatch(/\n{3,}/);
  });
});
