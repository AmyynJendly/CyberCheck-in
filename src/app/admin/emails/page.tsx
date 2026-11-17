"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { AdminTitle } from "@/components/admin/AdminShell";
import { EmailsAdmin } from "@/components/admin/EmailsAdmin";
import { Button, FieldRow, NeedEvent, Notice, Row, Section, TextField } from "@/components/ui";
import { DEFAULT_BODY, DEFAULT_SUBJECT } from "@/lib/email-defaults";

const CHIPS: { key: string; hint: string }[] = [
  { key: "name", hint: "Their full name" },
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
  const [tagline, setTagline] = useState("");
  const [saved, setSaved] = useState({ subject: "", body: "", tagline: "" });
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    (async () => {
      const r = await api<{ events: { id: string; email_subject: string | null; email_body: string | null; email_tagline: string | null }[] }>("/api/admin/events");
      const e = r.events.find((x) => x.id === eventId);
      const s = e?.email_subject ?? DEFAULT_SUBJECT;
      const b = e?.email_body ?? DEFAULT_BODY;
      const t = e?.email_tagline ?? "";
      setSubject(s);
      setBody(b);
      setTagline(t);
      setSaved({ subject: s, body: b, tagline: t });
    })().catch((e) => setMsg({ tone: "error", text: errorMessage(e) }));
  }, [eventId]);

  const refreshPreview = useCallback(async () => {
    try {
      setPreview(await api(`/api/admin/events/${eventId}/email-preview`, { body: { subject, body, tagline } }));
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  }, [eventId, subject, body, tagline]);

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

  const dirty = subject !== saved.subject || body !== saved.body || tagline !== saved.tagline;

  return (
    <section className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Section
            header="QR email template"
            footer="The text at the top of the email. A blank line starts a new paragraph; a line starting with “# ” is a headline; **like this** is bold. The pass holder's name, QR code, backup code, session list and entry rules are always added below it. Tap a placeholder to insert it."
          >
            <FieldRow label="Subject" htmlFor="tpl-subject">
              <TextField id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </FieldRow>
            <FieldRow label="Tagline" htmlFor="tpl-tagline">
              <TextField id="tpl-tagline" value={tagline} placeholder="Line under the event name (optional)" onChange={(e) => setTagline(e.target.value)} />
            </FieldRow>
            <div className="px-4 py-3">
              <textarea
                ref={area}
                aria-label="Email body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
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
                  await api(`/api/admin/events/${eventId}`, { method: "PATCH", body: { email_subject: subject, email_body: body, email_tagline: tagline } });
                  setSaved({ subject, body, tagline });
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
                  await api(`/api/admin/events/${eventId}/email-test`, { body: { to: testTo, subject, body, tagline }, timeoutMs: 30_000 });
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

export default function AdminEmailsPage() {
  const { event } = useApp();
  return (
    <>
      <AdminTitle title="Emails" subtitle="The QR email everyone receives, and the sending queue." />
      {!event ? (
        <NeedEvent />
      ) : (
        <div className="space-y-12">
          <TemplateEditor eventId={event.id} />
          <section className="max-w-2xl">
            <h2 className="t-title3 mb-3">Sending</h2>
            <EmailsAdmin />
          </section>
          <p className="t-footnote max-w-2xl px-1 text-label2">
            To add registrations from a sheet (for example the registration stand&apos;s), use People → Import sheet. Everyone new gets their QR email from here.
          </p>
        </div>
      )}
    </>
  );
}
