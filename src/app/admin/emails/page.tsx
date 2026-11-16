"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { AdminTitle } from "@/components/admin/AdminShell";
import { EmailsAdmin } from "@/components/admin/EmailsAdmin";
import { Button, FieldRow, NeedEvent, Notice, Row, Section, TextField } from "@/components/ui";

const DEFAULT_SUBJECT = "Your check-in QR code — {{event}}";
const DEFAULT_BODY = `Hi {{name}},

You're registered for {{event}}.
{{dates}}
{{location}}

Show this QR code at the entrance:
{{qr}}

If the QR doesn't work, give this code at the desk: {{code}}

{{entry}}

Don't share this code. It works once per day.

— Cybertrace Club`;

const CHIPS: { key: string; hint: string }[] = [
  { key: "name", hint: "Their full name" },
  { key: "qr", hint: "The QR code image" },
  { key: "code", hint: "6-character backup code" },
  { key: "event", hint: "Event name" },
  { key: "dates", hint: "When: day labels and dates" },
  { key: "location", hint: "Where: location" },
  { key: "entry", hint: "Entry rules per day (paid events)" },
];

type Msg = { tone: "ok" | "error"; text: string } | null;

function TemplateEditor({ eventId }: { eventId: string }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [saved, setSaved] = useState({ subject: "", body: "" });
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    (async () => {
      const r = await api<{ events: { id: string; email_subject: string | null; email_body: string | null }[] }>("/api/admin/events");
      const e = r.events.find((x) => x.id === eventId);
      const s = e?.email_subject ?? DEFAULT_SUBJECT;
      const b = e?.email_body ?? DEFAULT_BODY;
      setSubject(s);
      setBody(b);
      setSaved({ subject: s, body: b });
    })().catch((e) => setMsg({ tone: "error", text: errorMessage(e) }));
  }, [eventId]);

  const refreshPreview = useCallback(async () => {
    try {
      setPreview(await api(`/api/admin/events/${eventId}/email-preview`, { body: { subject, body } }));
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  }, [eventId, subject, body]);

  useEffect(() => {
    if (!body) return;
    const t = setTimeout(refreshPreview, 400);
    return () => clearTimeout(t);
  }, [refreshPreview, body]);

  const insert = (key: string) => {
    const el = area.current;
    const token = `{{${key}}}`;
    if (!el) return setBody((b) => b + token);
    const { selectionStart: a, selectionEnd: z } = el;
    const next = body.slice(0, a) + token + body.slice(z);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const dirty = subject !== saved.subject || body !== saved.body;

  return (
    <section className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Section header="QR email template" footer="Plain text. A blank line starts a new paragraph. Tap a placeholder to insert it where the cursor is.">
            <FieldRow label="Subject" htmlFor="tpl-subject">
              <TextField id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </FieldRow>
            <div className="px-4 py-3">
              <textarea
                ref={area}
                aria-label="Email body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={16}
                className="w-full resize-y rounded-[10px] bg-fill px-3 py-2 text-[15px] leading-6 text-label outline-none"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {CHIPS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    title={c.hint}
                    onClick={() => insert(c.key)}
                    className="rounded-full bg-accent/15 px-2.5 py-1 font-mono text-[12px] text-accent active:bg-accent/25"
                  >
                    {`{{${c.key}}}`}
                  </button>
                ))}
              </div>
            </div>
          </Section>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !dirty}
              onClick={() =>
                run(async () => {
                  await api(`/api/admin/events/${eventId}`, { method: "PATCH", body: { email_subject: subject, email_body: body } });
                  setSaved({ subject, body });
                  return "Template saved. New emails use it.";
                })
              }
            >
              Save Template
            </Button>
            <Button
              variant="gray"
              disabled={busy}
              onClick={() => {
                setSubject(DEFAULT_SUBJECT);
                setBody(DEFAULT_BODY);
              }}
            >
              Reset to Default
            </Button>
          </div>
          <Section header="Send a test" footer="Sends this template with sample data (the QR in it isn't a real ticket). Unsaved changes are included.">
            <FieldRow label="To" htmlFor="tpl-test">
              <TextField id="tpl-test" type="email" autoCapitalize="off" placeholder="you@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
            </FieldRow>
            <Row
              title="Send Test Email"
              accent
              disabled={busy || !testTo.trim()}
              onClick={() =>
                run(async () => {
                  await api(`/api/admin/events/${eventId}/email-test`, { body: { to: testTo, subject, body }, timeoutMs: 30_000 });
                  return `Test sent to ${testTo}. Check the inbox (and spam).`;
                })
              }
            />
          </Section>
        </div>

        <div>
          <h2 className="t-footnote mb-1.5 px-4 uppercase text-label2">Preview</h2>
          <div className="overflow-hidden rounded-[12px] bg-bg2">
            <p className="border-b border-sep/60 px-4 py-2.5 t-subhead">
              <span className="text-label2">Subject: </span>
              {preview?.subject}
            </p>
            {preview ? (
              <iframe title="Email preview" srcDoc={preview.html} sandbox="" className="h-[640px] w-full bg-white" />
            ) : (
              <p className="p-6 t-subhead text-label2">Loading preview…</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ImportRegistrations({ eventId }: { eventId: string }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ preview: { full_name: string; email: string | null; phone: string | null }[]; count: number; skipped: number } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const call = async (dry: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      if (dry) {
        const r = await api<NonNullable<typeof preview>>(`/api/admin/events/${eventId}/import`, { body: { text, dry_run: true } });
        setPreview(r);
        setMsg({ tone: "ok", text: `Found ${r.count} people. Check the first rows, then import.` });
      } else {
        const r = await api<{ created: number; updated: number; unchanged: number; emails_queued: number }>(`/api/admin/events/${eventId}/import`, {
          body: { text },
          timeoutMs: 60_000,
        });
        setText("");
        setPreview(null);
        setMsg({
          tone: "ok",
          text: `${r.created} added, ${r.updated} updated, ${r.unchanged} already there. ${r.emails_queued} QR email${r.emails_queued === 1 ? "" : "s"} queued; they go out one by one.`,
        });
      }
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="max-w-2xl space-y-4">
      <Section
        header="Add registrations by pasting"
        footer="Use this if people registered somewhere other than the connected Google Form, for example the form's response sheet. Copy the rows with the header (name, email, phone) and paste. Everyone with an email gets their QR. Pasting the same list again doesn't duplicate anyone or resend emails."
      >
        <div className="px-4 py-3">
          <textarea
            aria-label="Pasted registrations"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            rows={5}
            placeholder={"Full name\tEmail\tPhone\nYasmine Gharbi\tyasmine@example.com\t50 000 000"}
            className="w-full resize-y rounded-[10px] bg-fill px-3 py-2 font-mono text-[13px] leading-5 text-label placeholder:text-label3 outline-none"
          />
        </div>
      </Section>
      {preview && preview.preview.length > 0 && (
        <Section header={`Preview · first ${preview.preview.length} of ${preview.count}`}>
          {preview.preview.map((p, i) => (
            <Row key={i} title={p.full_name} subtitle={[p.email ?? "no email (no QR email)", p.phone ?? "no phone"].join(" · ")} />
          ))}
        </Section>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="grid grid-cols-2 gap-2.5">
        <Button variant="gray" size="large" disabled={busy || !text.trim()} onClick={() => call(true)}>
          Preview
        </Button>
        <Button size="large" disabled={busy || !preview?.count} onClick={() => call(false)}>
          Import {preview?.count ?? ""} & Email
        </Button>
      </div>
    </section>
  );
}

export default function AdminEmailsPage() {
  const { event } = useApp();
  return (
    <>
      <AdminTitle title="Emails" subtitle="The QR email everyone receives, the sending queue, and pasting registrations." />
      {!event ? (
        <NeedEvent />
      ) : (
        <div className="space-y-12">
          <TemplateEditor eventId={event.id} />
          <section className="max-w-2xl">
            <h2 className="t-title3 mb-3">Sending</h2>
            <EmailsAdmin />
          </section>
          <ImportRegistrations eventId={event.id} />
        </div>
      )}
    </>
  );
}
