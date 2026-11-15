"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, Copy, Eye, EyeOff, FileSpreadsheet, Plus, Printer, Trash2 } from "lucide-react";
import { api, errorMessage } from "../api";
import { Button, FieldRow, IconTile, Notice, Row, Section, Sheet, SheetAction, Spinner, TextField, Toggle } from "../ui";
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

type Msg = { tone: "ok" | "error"; text: string } | null;

export function EventsAdmin() {
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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

  const open = events?.find((e) => e.id === openId);
  if (open) return <EventDetail ev={open} onBack={() => setOpenId(null)} onChange={changed} />;
  if (creating)
    return (
      <CreateEvent
        onCancel={() => setCreating(false)}
        onCreated={async (id) => {
          setCreating(false);
          await changed();
          setOpenId(id);
        }}
      />
    );

  return (
    <div className="space-y-7">
      {error && <Notice tone="error">{error}</Notice>}
      <Button size="large" className="w-full" onClick={() => setCreating(true)}>
        <Plus className="h-5 w-5" strokeWidth={2.5} aria-hidden />
        New Event
      </Button>
      {events === null && !error && <Spinner />}
      {events && events.length > 0 && (
        <Section header="Events">
          {events.map((ev) => (
            <Row
              key={ev.id}
              title={ev.name}
              subtitle={`${ev.attendees} registered · ${ev.days.map((d) => d.day_date).join(", ") || "no days"}`}
              value={ev.is_active ? undefined : "Inactive"}
              chevron
              onClick={() => setOpenId(ev.id)}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="-ml-2 -mt-3 flex items-center text-accent active:opacity-50">
      <ChevronLeft className="h-7 w-7" strokeWidth={2.4} aria-hidden />
      <span className="t-body -ml-0.5">{label}</span>
    </button>
  );
}

const autoSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

function CreateEvent({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => Promise<void> }) {
  const [f, setF] = useState({ name: "", slug: "", location: "" });
  const [slugTouched, setSlugTouched] = useState(false);
  const [days, setDays] = useState<{ day_date: string; label: string }[]>([{ day_date: "", label: "Day 1" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>("/api/admin/events", { body: { ...f, days: days.filter((d) => d.day_date) } });
      await onCreated(r.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-7">
      <BackLink label="Events" onClick={onCancel} />
      <h2 className="t-title2 -mt-4">New Event</h2>
      <Section footer="The slug identifies the event in its Google Form script, e.g. mini-ctf-2026.">
        <FieldRow label="Name" htmlFor="ne-name">
          <TextField
            id="ne-name"
            value={f.name}
            required
            placeholder="Mini CTF 2026"
            onChange={(e) => setF((s) => ({ ...s, name: e.target.value, slug: slugTouched ? s.slug : autoSlug(e.target.value) }))}
          />
        </FieldRow>
        <FieldRow label="Slug" htmlFor="ne-slug">
          <TextField
            id="ne-slug"
            value={f.slug}
            required
            pattern="[a-z0-9][a-z0-9-]{1,62}"
            autoCapitalize="off"
            placeholder="mini-ctf-2026"
            className="font-mono"
            onChange={(e) => {
              setSlugTouched(true);
              setF((s) => ({ ...s, slug: e.target.value }));
            }}
          />
        </FieldRow>
        <FieldRow label="Location" htmlFor="ne-loc">
          <TextField id="ne-loc" value={f.location} placeholder="ISSAT Sousse" onChange={(e) => setF((s) => ({ ...s, location: e.target.value }))} />
        </FieldRow>
      </Section>

      <Section header="Days">
        {days.map((d, i) => (
          <div key={i} className="flex items-center gap-2 px-4">
            <TextField
              aria-label={`Day ${i + 1} date`}
              type="date"
              value={d.day_date}
              className="w-auto flex-1"
              onChange={(e) => setDays((ds) => ds.map((x, j) => (j === i ? { ...x, day_date: e.target.value } : x)))}
            />
            <TextField
              aria-label={`Day ${i + 1} label`}
              value={d.label}
              placeholder="Label"
              className="w-24 text-right text-label2"
              onChange={(e) => setDays((ds) => ds.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            />
            {days.length > 1 && (
              <button type="button" aria-label="Remove day" onClick={() => setDays((ds) => ds.filter((_, j) => j !== i))} className="text-sys-red active:opacity-50">
                <Trash2 className="h-[18px] w-[18px]" />
              </button>
            )}
          </div>
        ))}
        <Row title="Add Day" accent onClick={() => setDays((ds) => [...ds, { day_date: "", label: `Day ${ds.length + 1}` }])} />
      </Section>

      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" size="large" className="w-full" disabled={busy || !f.name.trim() || !f.slug.trim()}>
        {busy ? "Creating…" : "Create Event"}
      </Button>
    </form>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the value is selectable */
        }
      }}
      className="flex shrink-0 items-center gap-1 t-subhead text-accent active:opacity-50"
    >
      <Copy className="h-4 w-4" strokeWidth={2.2} aria-hidden />
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function PropRow({ name, value, secret }: { name: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="t-caption font-semibold uppercase tracking-wide text-label2">{name}</p>
        <p className="mt-0.5 break-all font-mono text-[14px] select-all">{shown ? value : "•".repeat(28)}</p>
      </div>
      {secret && (
        <button type="button" aria-label={shown ? "Hide secret" : "Show secret"} onClick={() => setShown((s) => !s)} className="text-label2 active:opacity-50">
          {shown ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
        </button>
      )}
      <CopyButton value={value} label={name} />
    </div>
  );
}

function EventDetail({ ev, onBack, onChange }: { ev: AdminEvent; onBack: () => void; onChange: () => Promise<void> }) {
  const [f, setF] = useState({ name: ev.name, slug: ev.slug, location: ev.location ?? "" });
  const [newDay, setNewDay] = useState({ day_date: "", label: "" });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const apiUrl = typeof window !== "undefined" ? `${window.location.origin}/api/form-submit` : "/api/form-submit";
  const dirty = f.name !== ev.name || f.slug !== ev.slug || f.location !== (ev.location ?? "");

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
    <div className="space-y-7">
      <BackLink label="Events" onClick={onBack} />
      <div className="-mt-4">
        <h2 className="t-title2">{ev.name}</h2>
        <p className="t-subhead text-label2">{ev.attendees} registered</p>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <Section header="Details" footer="Changing the slug breaks the form's script until you update EVENT_SLUG there.">
        <FieldRow label="Name" htmlFor="ed-name">
          <TextField id="ed-name" value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} />
        </FieldRow>
        <FieldRow label="Slug" htmlFor="ed-slug">
          <TextField id="ed-slug" value={f.slug} autoCapitalize="off" className="font-mono" onChange={(e) => setF((s) => ({ ...s, slug: e.target.value }))} />
        </FieldRow>
        <FieldRow label="Location" htmlFor="ed-loc">
          <TextField id="ed-loc" value={f.location} onChange={(e) => setF((s) => ({ ...s, location: e.target.value }))} />
        </FieldRow>
        {dirty && <Row title="Save Changes" accent disabled={busy} onClick={() => run(() => api(`/api/admin/events/${ev.id}`, { method: "PATCH", body: f }), "Saved.")} />}
      </Section>

      <Section footer="Inactive events are hidden from staff and refuse check-ins. Form registrations still come in.">
        <Row
          title="Active"
          trailing={
            <Toggle
              label="Active"
              checked={ev.is_active}
              disabled={busy}
              onChange={(v) => run(() => api(`/api/admin/events/${ev.id}`, { method: "PATCH", body: { is_active: v } }), v ? "Event activated." : "Event deactivated.")}
            />
          }
        />
      </Section>

      <Section header="Days" footer="A day with check-ins can't be deleted.">
        {ev.days.map((d) => (
          <DayRow key={d.id} eventId={ev.id} day={d} run={run} busy={busy} />
        ))}
        <div className="flex items-center gap-2 px-4">
          <TextField aria-label="New day date" type="date" value={newDay.day_date} className="w-auto flex-1" onChange={(e) => setNewDay((s) => ({ ...s, day_date: e.target.value }))} />
          <TextField
            aria-label="New day label"
            value={newDay.label}
            placeholder={`Day ${ev.days.length + 1}`}
            className="w-24 text-right"
            onChange={(e) => setNewDay((s) => ({ ...s, label: e.target.value }))}
          />
          <Button
            size="small"
            variant="tinted"
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
      </Section>

      <Section header="Exports" inset={60}>
        <Row
          href={`/api/events/${ev.id}/export.csv`}
          external
          icon={<IconTile color="bg-[#30b0c7]"><FileSpreadsheet className="h-[17px] w-[17px]" strokeWidth={2.2} /></IconTile>}
          title="Download CSV"
        />
        <Row
          href={`/api/events/${ev.id}/backup`}
          external
          icon={<IconTile color="bg-sys-gray"><Printer className="h-[17px] w-[17px]" strokeWidth={2.2} /></IconTile>}
          title="Backup List"
          subtitle="Print or save as PDF"
        />
      </Section>

      <Section
        header="Google Form"
        footer={
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>
              Form questions, exact titles: <b>Full name</b>, <b>Email</b>, <b>Phone</b>, <b>Class / Year</b>, <b>Team name</b>.
            </li>
            <li>
              In the form: ⋮ → Script editor → paste <span className="font-mono">apps-script/Code.gs</span>.
            </li>
            <li>Project Settings → Script Properties: add the three values above.</li>
            <li>
              Run <span className="font-mono">setup</span> once and allow access. The log should say OK.
            </li>
            <li>
              Responses from before setup? Run <span className="font-mono">syncAll</span>. It&apos;s safe to repeat.
            </li>
          </ol>
        }
      >
        <PropRow name="API_URL" value={apiUrl} />
        <PropRow name="EVENT_SLUG" value={ev.slug} />
        <PropRow name="FORM_SECRET" value={ev.form_secret} secret />
      </Section>

      <Section footer="The form stops sending registrations until you paste the new FORM_SECRET into its script. They're queued and go through after.">
        <Row title="Regenerate Secret" destructive disabled={busy} onClick={() => setConfirmRegen(true)} />
      </Section>

      <Sheet
        open={confirmRegen}
        onClose={() => setConfirmRegen(false)}
        title="Regenerate the form secret?"
        message="You'll need to update FORM_SECRET in this event's Apps Script."
      >
        <SheetAction
          destructive
          onClick={() => {
            setConfirmRegen(false);
            void run(() => api(`/api/admin/events/${ev.id}`, { method: "PATCH", body: { regenerate_secret: true } }), "New secret created. Update FORM_SECRET in the Apps Script.");
          }}
        >
          Regenerate Secret
        </SheetAction>
      </Sheet>
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
    <div className="flex items-center gap-2 px-4">
      <TextField aria-label="Date" type="date" className="w-auto flex-1" value={date} onChange={(e) => setDate(e.target.value)} />
      <TextField aria-label="Label" className="w-24 text-right" value={label} onChange={(e) => setLabel(e.target.value)} />
      {dirty ? (
        <Button
          size="small"
          variant="tinted"
          disabled={busy}
          onClick={() => run(() => api(`/api/admin/events/${eventId}/days/${day.id}`, { method: "PATCH", body: { label, day_date: date } }), "Day saved.")}
        >
          Save
        </Button>
      ) : day.checkins > 0 ? (
        <span className="t-footnote shrink-0 tabular text-label2">{day.checkins} in</span>
      ) : (
        <button
          type="button"
          aria-label={`Delete ${day.day_date}`}
          disabled={busy}
          onClick={() => run(() => api(`/api/admin/events/${eventId}/days/${day.id}`, { method: "DELETE" }), "Day deleted.")}
          className="text-sys-red active:opacity-50 disabled:opacity-40"
        >
          <Trash2 className="h-[18px] w-[18px]" />
        </button>
      )}
    </div>
  );
}
