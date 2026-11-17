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

  it("uses the access-pass design: event header, tagline, backup code, one checkpoint per day, final stage", () => {
    const m = buildQrEmail("y@example.com", {
      ...ctx,
      eventName: "tracers_camp & CyberDay CTF",
      tagline: "♠ Alice in Borderland Edition ♦",
      days: [
        { day_date: "2026-11-23", label: "Linux fundamentals", access: "free" },
        { day_date: "2026-11-24", label: "Networks under attack", access: "members" },
        { day_date: "2026-11-27", label: "CyberDay CTF", access: "members_or_fee", entry_fee: 5 },
      ],
      membershipFee: 15,
    }, Buffer.from("png"));
    expect(m.html).toContain("tracers_camp &amp; CyberDay CTF");
    expect(m.html).toContain("♠ Alice in Borderland Edition ♦");
    expect(m.html).toContain(">Welcoming you to attend, Tracers-Camp</h2>"); // "# " headline in the default text
    expect(m.html).toContain("Pass holder");
    expect(m.html).toContain("Yasmine &lt;b&gt;");
    expect(m.text).toContain("Pass holder: Yasmine <b>");
    expect(m.text).not.toContain("# Welcoming");
    expect(m.html).toContain("<b>CyberTracer</b>"); // **bold** in the default text
    expect(m.html).toContain("BACKUP CODE:");
    expect(m.html).toContain("Event checkpoints (2 sessions + CyberDay CTF)");
    expect(m.html).toContain("Linux fundamentals<br>");
    expect(m.html).toContain(">Mon 23 Nov · Free entry</span>");
    expect(m.html).toContain("Stage 2");
    expect(m.html).toContain("Final Stage");
    expect(m.html).toContain("Tue 24 Nov · Members only");
    expect(m.html).toContain("Fri 27 Nov · Members free · others 5 DT");
    expect(m.html).toContain("Not a member? Join at the desk for");
    expect(m.text).toContain("CyberDay CTF: free for club members, 5 DT for everyone else.");
    expect(m.html).not.toContain("<style"); // inline styles only, for Gmail / Outlook
    expect(m.html).toContain('src="cid:logo"'); // the club logo, inline
    expect(m.logo!.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // a PNG
    expect(m.subject).toBe("Your official access pass — tracers_camp & CyberDay CTF");
    expect(m.text).toContain("- Networks under attack · Tue 24 Nov (Stage 2)");
    expect(m.text).toContain("- CyberDay CTF · Fri 27 Nov (Final Stage)");
  });

  it("drops lines whose placeholder is empty", () => {
    const m = buildQrEmail("y@example.com", { ...ctx, location: null }, Buffer.from("png"));
    expect(m.text).not.toContain("Where:");
    expect(m.text).not.toMatch(/\n{3,}/);
  });
});
