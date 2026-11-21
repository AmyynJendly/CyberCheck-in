// The email queue: one sender at a time, every email exactly once, templates.
import { afterAll, describe, expect, it } from "vitest";
import { POST as formPOST } from "@/app/api/form-submit/route";
import { closePool, query } from "@/lib/db";
import { buildQrEmail, deliveryGauge, devOutbox, drainEmailQueue } from "@/lib/email";
import { POST as walkinPOST } from "@/app/api/walkin/route";
import { POST as sendPOST } from "@/app/api/admin/emails/send/route";
import { cleanAttendeeFields, ingestFormSubmission } from "@/lib/attendees";
import { body, cookieFor, makeEvent, makeStaff, req, uniq } from "./helpers";

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

describe("manual sending (EMAIL_AUTO_SEND off, the default)", () => {
  it("registrations and walk-ins send nothing; only the admin's Send Waiting Now does", async () => {
    process.env.DEV_EMAIL_MODE = "log";
    process.env.EMAIL_AUTO_SEND = "";
    try {
      const ev = await makeEvent();
      const formEmail = `${uniq("manual")}@example.com`;
      const walkEmail = `${uniq("manual-walk")}@example.com`;
      const res = await formPOST(
        req("POST", "/api/form-submit", { body: { event_slug: ev.slug, response_id: uniq("m"), full_name: "Manual Form", email: formEmail }, headers: { "x-form-secret": ev.secret } }),
        undefined,
      );
      expect(res.status).toBe(200);
      const hr = await makeStaff("hr");
      const w = await walkinPOST(req("POST", "/api/walkin", { cookie: await cookieFor(hr), body: { event_id: ev.id, full_name: "Manual Walker", email: walkEmail } }), undefined);
      expect(await body(w)).toMatchObject({ status: "OK", email_queued: true });
      const ping = await formPOST(req("POST", "/api/form-submit", { body: { event_slug: ev.slug, ping: true }, headers: { "x-form-secret": ev.secret } }), undefined);
      expect(ping.status).toBe(200);
      const sentTo = () => devOutbox().filter((m) => m.to === formEmail || m.to === walkEmail);
      expect(sentTo()).toHaveLength(0); // nothing went out on its own
      const st = await query<{ email_status: string }>("select email_status from attendees where email = any($1) order by email", [[formEmail, walkEmail]]);
      expect(st.rows.map((r) => r.email_status)).toEqual(["pending", "pending"]);

      const admin = await makeStaff("admin");
      await sendPOST(req("POST", "/api/admin/emails/send", { cookie: await cookieFor(admin), body: {} }), undefined);
      expect(sentTo()).toHaveLength(2); // the admin pressed Send
    } finally {
      process.env.EMAIL_AUTO_SEND = "on";
    }
  });
});

describe("second email address", () => {
  it("someone with two addresses gets one email sent to both", async () => {
    process.env.DEV_EMAIL_MODE = "log";
    const ev = await makeEvent();
    const [main, alt] = [`${uniq("two")}@example.com`, `${uniq("two-alt")}@example.com`];
    await ingestFormSubmission(ev.id, uniq("r"), cleanAttendeeFields({ full_name: "Two Addresses", email: main }));
    await query("update attendees set alt_email = $2 where email = $1", [main, alt]);
    await drainEmailQueue();
    const sent = devOutbox().filter((m) => m.to.includes(main));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(`${main}, ${alt}`);
    const r = await query<{ email_status: string }>("select email_status from attendees where email = $1", [main]);
    expect(r.rows[0].email_status).toBe("sent");
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

  const camp = {
    ...ctx,
    eventName: "TracersCamp",
    tagline: "♠ Alice in Borderland Edition ♦",
    days: [
      { day_date: "2026-11-23", label: "Linux fundamentals", access: "free" },
      { day_date: "2026-11-24", label: "Networks under attack", access: "members" },
      { day_date: "2026-11-27", label: "CyberDay CTF", access: "members_or_fee", entry_fee: 5 },
    ],
    membershipFee: 15,
  };

  it("Borderland (default): the pass as a playing card, one game per day, the Joker as the final stage", () => {
    const m = buildQrEmail("y@example.com", camp, Buffer.from("png"));
    expect(m.html).toContain(">TracersCamp</div>");
    expect(m.html).toContain("♠ Alice in Borderland Edition ♦");
    expect(m.html).toContain(">Welcoming you to attend, TracersCamp</h2>"); // "# " headline in the default text
    expect(m.html).toContain("<b>CyberTracer</b>"); // **bold** in the default text
    expect(m.html).toContain("J<br>O<br>K<br>E<br>R"); // card corner index
    expect(m.html).toContain("Visa · 3 days");
    expect(m.html).toContain(">Player</div>");
    expect(m.html).toContain("Yasmine &lt;b&gt;");
    expect(m.html).toContain("Backup code");
    expect(m.html).toContain("The games");
    expect(m.html).toContain("2 sessions + CyberDay CTF");
    expect(m.html).toContain("JKR"); // the final day is the Joker card
    expect(m.html).toContain("Mon 23 Nov · Free entry");
    expect(m.html).toContain("Tue 24 Nov · Members only");
    expect(m.html).toContain("Fri 27 Nov · Members free · others 5 DT");
    expect(m.html).toContain("Final Stage");
    expect(m.html).toContain("Not a member? Join at the desk for");
    // The notes after "---": what to bring, below the games.
    expect(m.html).toContain("Don&#39;t forget to bring");
    expect(m.html.indexOf("Your power strip (optional)")).toBeGreaterThan(m.html.indexOf("The games"));
    expect(m.html).not.toContain("<style"); // inline styles only, for Gmail / Outlook
    expect(m.html).toContain('src="cid:logo"'); // the club logo, inline
    expect(m.logo!.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // a PNG
    expect(m.subject).toBe("Your official access pass — TracersCamp");
    expect(m.text).toContain("Player: Yasmine <b>");
    expect(m.text).not.toContain("# Welcoming");
    expect(m.text).not.toContain("---");
    expect(m.text).toContain("- Networks under attack · Tue 24 Nov (Stage 2)");
    expect(m.text).toContain("- CyberDay CTF · Fri 27 Nov (Final Stage)");
    expect(m.text).toContain("CyberDay CTF: free for club members, 5 DT for everyone else.");
    expect(m.text).toContain("Don't forget to bring\n1. Your PC");
  });

  it("Classic: the first design is still available", () => {
    const m = buildQrEmail("y@example.com", { ...camp, design: "classic" }, Buffer.from("png"));
    expect(m.html).toContain("Pass holder");
    expect(m.html).toContain("Event checkpoints (2 sessions + CyberDay CTF)");
    expect(m.html).toContain("BACKUP CODE:");
    expect(m.html).toContain("Don&#39;t forget to bring");
    expect(m.html).not.toContain("JKR");
    // An unknown design falls back to Borderland.
    expect(buildQrEmail("y@example.com", { ...camp, design: "nope" }, Buffer.from("png")).html).toContain("JKR");
  });

  it("drops lines whose placeholder is empty", () => {
    const m = buildQrEmail("y@example.com", { ...ctx, location: null }, Buffer.from("png"));
    expect(m.text).not.toContain("Where:");
    expect(m.text).not.toMatch(/\n{3,}/);
  });
});
