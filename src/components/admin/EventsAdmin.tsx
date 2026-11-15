"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, Card, Field, Notice, btn, inputClass } from "../ui";
import { useApp } from "../AppContext";

interface AdminDay {
  id: string;
  day_date: string;
  label: string | null;
  checkins: number;
}
interface AdminEvent {
  id: string;
  slug: string;
  name: string;
  location: string | null;
  form_secret: string;
  is_active: boolean;
  created_at: string;
  days: AdminDay[];
  attendees: number;
}

export function EventsAdmin() {
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { refresh } = useApp();

  const load = useCallback(async () => {
    try {
      setEvents((await api<{ events: AdminEvent[] }>("/api/admin/events")).events);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = async () => {
    await load();
    await refresh().catch(() => {});
  };

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      <CreateEvent onCreated={changed} />
      {events?.map((ev) => (
        <Card key={ev.id}>
          <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(open === ev.id ? null : ev.id)}>
            <div>
              <p className="text-lg font-bold">
                {ev.name} {!ev.is_active && <span className="text-xs font-normal text-amber-400">(inactive)</span>}
              </p>
              <p className="text-xs text-slate-400">
                {ev.slug} · {ev.attendees} attendees · {ev.days.map((d) => d.day_date).join(", ") || "no days"}
              </p>
            </div>
            <span className="text-slate-500">{open === ev.id ? "▲" : "▼"}</span>
          </button>
          {open === ev.id && <EventDetail ev={ev} onChange={changed} />}
        </Card>
      ))}
    </div>
  );
}

function CreateEvent({ onCreated }: { onCreated: () => Promise<void> }) {
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ name: "", slug: "", location: "" });
  const [days, setDays] = useState<{ day_date: string; label: string }[]>([{ day_date: "", label: "Day 1" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoSlug = (name: string) =>
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/events", { body: { ...f, days: days.filter((d) => d.day_date) } });
      setShow(false);
      setF({ name: "", slug: "", location: "" });
      setDays([{ day_date: "", label: "Day 1" }]);
      await onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!show)
    return (
      <Button big className="w-full" onClick={() => setShow(true)}>
        + New event
      </Button>
    );
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <h3 className="text-lg font-bold">New event</h3>
        <Field label="Name *">
          <input
            className={inputClass}
            value={f.name}
            required
            onChange={(e) => setF((s) => ({ ...s, name: e.target.value, slug: s.slug && s.slug !== autoSlug(s.name) ? s.slug : autoSlug(e.target.value) }))}
          />
        </Field>
        <Field label="Slug *" hint="Used by the Google Form script (EVENT_SLUG). e.g. mini-ctf-2026">
          <input className={inputClass} value={f.slug} required pattern="[a-z0-9][a-z0-9-]{1,62}" onChange={(e) => setF((s) => ({ ...s, slug: e.target.value }))} />
        </Field>
        <Field label="Location">
          <input className={inputClass} value={f.location} onChange={(e) => setF((s) => ({ ...s, location: e.target.value }))} />
        </Field>
        <p className="text-sm font-medium text-slate-300">Days</p>
        {days.map((d, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="date"
              className={inputClass}
              value={d.day_date}
              onChange={(e) => setDays((ds) => ds.map((x, j) => (j === i ? { ...x, day_date: e.target.value } : x)))}
            />
            <input
              className={inputClass}
              value={d.label}
              placeholder="Label"
              onChange={(e) => setDays((ds) => ds.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            />
            {days.length > 1 && (
              <Button type="button" variant="ghost" onClick={() => setDays((ds) => ds.filter((_, j) => j !== i))}>
                ✕
              </Button>
            )}
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setDays((ds) => [...ds, { day_date: "", label: `Day ${ds.length + 1}` }])}>
          + Add day
        </Button>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            Create event
          </Button>
          <Button type="button" variant="ghost" onClick={() => setShow(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          prompt("Copy this:", value);
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

function EventDetail({ ev, onChange }: { ev: AdminEvent; onChange: () => Promise<void> }) {
  const [f, setF] = useState({ name: ev.name, slug: ev.slug, location: ev.location ?? "" });
  const [newDay, setNewDay] = useState({ day_date: "", label: "" });
  const [showSecret, setShowSecret] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const apiUrl = typeof window !== "undefined" ? `${window.location.origin}/api/form-submit` : "/api/form-submit";

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      await onChange();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-5 border-t border-slate-800 pt-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <section className="space-y-3">
        <h4 className="font-semibold">Details</h4>
        <Field label="Name">
          <input className={inputClass} value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} />
        </Field>
        <Field label="Slug" hint="Changing it breaks the Apps Script until you update EVENT_SLUG there.">
          <input className={inputClass} value={f.slug} onChange={(e) => setF((s) => ({ ...s, slug: e.target.value }))} />
        </Field>
        <Field label="Location">
          <input className={inputClass} value={f.location} onChange={(e) => setF((s) => ({ ...s, location: e.target.value }))} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => run(() => api(`/api/admin/events/${ev.id}`, { method: "PATCH", body: f }), "Saved.")}>
            Save
          </Button>
          <Button
            variant={ev.is_active ? "secondary" : "primary"}
            disabled={busy}
            onClick={() => run(() => api(`/api/admin/events/${ev.id}`, { method: "PATCH", body: { is_active: !ev.is_active } }), ev.is_active ? "Deactivated." : "Activated.")}
          >
            {ev.is_active ? "Deactivate" : "Activate"}
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="font-semibold">Days</h4>
        {ev.days.map((d) => (
          <DayRow key={d.id} eventId={ev.id} day={d} run={run} busy={busy} />
        ))}
        <div className="flex gap-2">
          <input type="date" className={inputClass} value={newDay.day_date} onChange={(e) => setNewDay((s) => ({ ...s, day_date: e.target.value }))} />
          <input className={inputClass} placeholder={`Day ${ev.days.length + 1}`} value={newDay.label} onChange={(e) => setNewDay((s) => ({ ...s, label: e.target.value }))} />
          <Button
            disabled={busy || !newDay.day_date}
            onClick={() =>
              run(async () => {
                await api(`/api/admin/events/${ev.id}/days`, { body: newDay });
                setNewDay({ day_date: "", label: "" });
              }, "Day added.")
            }
          >
            Add
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="font-semibold">Exports</h4>
        <div className="flex flex-wrap gap-2">
          <a className={btn("secondary")} href={`/api/events/${ev.id}/export.csv`}>
            Download CSV
          </a>
          <a className={btn("secondary")} href={`/api/events/${ev.id}/backup`} target="_blank" rel="noreferrer">
            Backup list (print / PDF)
          </a>
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="font-semibold">Google Form connection</h4>
        <p className="text-sm text-slate-400">
          In the form: ⋮ → Script editor → paste <code>apps-script/Code.gs</code> → Project Settings → Script Properties:
        </p>
        <PropRow name="API_URL" value={apiUrl} />
        <PropRow name="EVENT_SLUG" value={ev.slug} />
        <div className="rounded-xl bg-slate-950 p-3">
          <p className="text-xs text-slate-400">FORM_SECRET</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-sm">{showSecret ? ev.form_secret : "•".repeat(24)}</code>
            <Button variant="ghost" onClick={() => setShowSecret((s) => !s)}>
              {showSecret ? "Hide" : "Show"}
            </Button>
            <Copy value={ev.form_secret} />
          </div>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-400">
          <li>
            Form questions (exact titles): <code>Full name</code>, <code>Email</code>, <code>Phone</code>, <code>Class / Year</code>, <code>Team name</code>.
          </li>
          <li>Set the 3 Script Properties above.</li>
          <li>
            Run <code>setup</code> once (authorize when asked). It installs the on-submit trigger and the 5-minute retry trigger.
          </li>
          <li>
            Run <code>testConnection</code>: it should log <code>OK</code>.
          </li>
          <li>
            Already have responses? Run <code>syncAll</code> (safe to repeat).
          </li>
        </ol>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            if (confirm("Regenerate the secret? The form's Apps Script stops working until you paste the new FORM_SECRET there."))
              void run(() => api(`/api/admin/events/${ev.id}`, { method: "PATCH", body: { regenerate_secret: true } }), "New secret generated. Update FORM_SECRET in the Apps Script.");
          }}
        >
          Regenerate secret
        </Button>
      </section>
    </div>
  );
}

function PropRow({ name, value }: { name: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-950 p-3">
      <p className="text-xs text-slate-400">{name}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all text-sm">{value}</code>
        <Copy value={value} />
      </div>
    </div>
  );
}

function DayRow({
  eventId,
  day,
  run,
  busy,
}: {
  eventId: string;
  day: AdminDay;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
  busy: boolean;
}) {
  const [label, setLabel] = useState(day.label ?? "");
  const [date, setDate] = useState(day.day_date);
  const dirty = label !== (day.label ?? "") || date !== day.day_date;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-950 p-2">
      <input type="date" className={`${inputClass} w-auto flex-1 py-2`} value={date} onChange={(e) => setDate(e.target.value)} />
      <input className={`${inputClass} w-auto flex-1 py-2`} value={label} onChange={(e) => setLabel(e.target.value)} />
      <span className="text-xs text-slate-400">{day.checkins} in</span>
      {dirty && (
        <Button disabled={busy} onClick={() => run(() => api(`/api/admin/events/${eventId}/days/${day.id}`, { method: "PATCH", body: { label, day_date: date } }), "Day saved.")}>
          Save
        </Button>
      )}
      {day.checkins === 0 && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => confirm(`Delete ${day.day_date}?`) && run(() => api(`/api/admin/events/${eventId}/days/${day.id}`, { method: "DELETE" }), "Day deleted.")}
        >
          ✕
        </Button>
      )}
    </div>
  );
}
