"use client";

import Link from "next/link";
import { useState } from "react";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { DayPicker } from "@/components/DayPicker";
import { Button, Field, NeedEvent, Notice, Page, inputClass } from "@/components/ui";

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
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!event || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<WalkInResult>("/api/walkin", { body: { event_id: event.id, ...form, ...dayParam } });
      setResult(r);
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
              <Notice tone="warn">No event day today — walk-ins are checked in for today, so this is disabled.</Notice>
              <DayPicker />
            </>
          )}
          {result?.status === "OK" && (
            <div className="rounded-2xl bg-emerald-600 p-5 text-white">
              <p className="text-sm font-semibold uppercase tracking-wide">✓ Added & checked in · {result.day_label}</p>
              <p className="text-2xl font-bold">{result.name}</p>
              <p className="mt-1">
                Backup code: <span className="font-mono text-xl font-bold tracking-widest">{result.short_code}</span>
              </p>
              {result.email_queued && <p className="text-sm opacity-90">Their QR is being emailed.</p>}
            </div>
          )}
          {result?.status === "EMAIL_EXISTS" && (
            <Notice tone="warn">
              <strong>{result.name}</strong> is already registered with that email.{" "}
              <Link className="font-semibold underline" href={`/search?q=${encodeURIComponent(form.email)}`}>
                Find them and check in →
              </Link>
            </Notice>
          )}
          {result?.status === "NO_EVENT_DAY" && <Notice tone="error">No event day today. Not added.</Notice>}
          {error && <Notice tone="error">{error}</Notice>}

          <form onSubmit={submit} className="space-y-4">
            <Field label="Full name *">
              <input className={inputClass} value={form.full_name} onChange={set("full_name")} required autoComplete="off" autoFocus />
            </Field>
            <Field label="Phone">
              <input className={inputClass} value={form.phone} onChange={set("phone")} inputMode="tel" autoComplete="off" />
            </Field>
            <Field label="Email" hint="If given, they get their QR by email (useful for day 2).">
              <input className={inputClass} value={form.email} onChange={set("email")} type="email" autoCapitalize="off" autoComplete="off" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Class / Year">
                <input className={inputClass} value={form.class_year} onChange={set("class_year")} autoComplete="off" />
              </Field>
              <Field label="Team">
                <input className={inputClass} value={form.team_name} onChange={set("team_name")} autoComplete="off" />
              </Field>
            </div>
            <Button big type="submit" className="w-full py-5 text-xl" disabled={busy || !activeDay || !form.full_name.trim()}>
              {busy ? "Adding…" : "Add & check in"}
            </Button>
          </form>
        </>
      )}
    </Page>
  );
}
