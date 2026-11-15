"use client";

import Link from "next/link";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { DayPicker } from "@/components/DayPicker";
import { Button, FieldRow, NeedEvent, Notice, Page, Section, TextField } from "@/components/ui";

type WalkInResult =
  | { status: "OK"; name: string; short_code: string; day_label: string; email_queued: boolean }
  | { status: "NO_EVENT_DAY" }
  | { status: "EMAIL_EXISTS"; attendee_id: string; name: string };

const EMPTY = { full_name: "", phone: "", email: "", class_year: "", team_name: "" };

export default function WalkInPage() {
  const { event, activeDay } = useApp();
  const dayParam = useDayParam();
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WalkInResult | null>(null);
  const [lastEmail, setLastEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!event || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<WalkInResult>("/api/walkin", { body: { event_id: event.id, ...form, ...dayParam } });
      setResult(r);
      setLastEmail(form.email);
      if (r.status === "OK") {
        setForm(EMPTY);
        try {
          navigator.vibrate?.(120);
        } catch {}
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Walk-in">
      {!event ? (
        <NeedEvent />
      ) : (
        <>
          {!activeDay && (
            <>
              <Notice tone="warn">No event day today. Walk-ins are checked in for today, so this is off.</Notice>
              <DayPicker />
            </>
          )}

          {result?.status === "OK" && (
            <div className="anim-fade flex items-start gap-3 rounded-[14px] bg-sys-green/15 p-4">
              <CircleCheck className="mt-0.5 h-7 w-7 shrink-0 text-sys-green" strokeWidth={2.2} aria-hidden />
              <div className="min-w-0">
                <p className="t-headline">{result.name}</p>
                <p className="t-subhead text-label2">Added and checked in for {result.day_label}.</p>
                <p className="t-subhead mt-2 text-label2">
                  Backup code <span className="ml-1 font-mono text-[17px] font-semibold tracking-[0.14em] text-label">{result.short_code}</span>
                </p>
                {result.email_queued && <p className="t-footnote mt-1 text-label2">Their QR code is on its way by email.</p>}
              </div>
            </div>
          )}
          {result?.status === "EMAIL_EXISTS" && (
            <Notice tone="warn">
              <strong>{result.name}</strong> already registered with this email.{" "}
              <Link href={`/search?q=${encodeURIComponent(lastEmail)}`}>Find them and check in</Link>
            </Notice>
          )}
          {result?.status === "NO_EVENT_DAY" && <Notice tone="error">No event day today. Nobody was added.</Notice>}
          {error && <Notice tone="error">{error}</Notice>}

          <form onSubmit={submit} className="space-y-7">
            <Section header="Required">
              <FieldRow label="Full name" htmlFor="wi-name">
                <TextField id="wi-name" value={form.full_name} onChange={set("full_name")} required autoComplete="off" autoFocus placeholder="First and last name" />
              </FieldRow>
            </Section>
            <Section header="Optional" footer="With an email, they also get their QR code for the next days.">
              <FieldRow label="Phone" htmlFor="wi-phone">
                <TextField id="wi-phone" value={form.phone} onChange={set("phone")} inputMode="tel" autoComplete="off" placeholder="+216" />
              </FieldRow>
              <FieldRow label="Email" htmlFor="wi-email">
                <TextField id="wi-email" value={form.email} onChange={set("email")} type="email" autoCapitalize="off" autoComplete="off" placeholder="name@example.com" />
              </FieldRow>
              <FieldRow label="Class / Year" htmlFor="wi-class">
                <TextField id="wi-class" value={form.class_year} onChange={set("class_year")} autoComplete="off" placeholder="e.g. ING 2" />
              </FieldRow>
              <FieldRow label="Team" htmlFor="wi-team">
                <TextField id="wi-team" value={form.team_name} onChange={set("team_name")} autoComplete="off" placeholder="Team name" />
              </FieldRow>
            </Section>
            <Button type="submit" size="large" className="w-full" disabled={busy || !activeDay || !form.full_name.trim()}>
              {busy ? "Adding…" : "Add & Check In"}
            </Button>
          </form>
        </>
      )}
    </Page>
  );
}
