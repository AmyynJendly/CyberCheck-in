"use client";

import Link from "next/link";
import { useApp } from "@/components/AppContext";
import { api } from "@/components/api";
import { useStats } from "@/components/useStats";
import { DayPicker } from "@/components/DayPicker";
import { Button, Card, Notice, OfflineBanner, btn } from "@/components/ui";
import { dayName } from "@/components/types";

export default function Home() {
  const { ready, me, events, event, selectEvent, activeDay, dayOverrideId } = useApp();
  const { stats } = useStats(event?.id, dayOverrideId, 15_000);

  const logout = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => {});
    window.location.href = "/login";
  };

  if (!ready) return <p className="p-6 text-slate-400">Loading…</p>;

  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-12">
      <OfflineBanner />
      <header className="flex items-center justify-between px-4 pb-2 pt-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-teal-400">Cybertrace check-in</p>
          <p className="text-lg font-bold">
            {me?.name} <span className="text-sm font-normal text-slate-400">({me?.role})</span>
          </p>
        </div>
        <Button variant="ghost" onClick={logout}>
          Log out
        </Button>
      </header>

      <main className="space-y-4 px-4">
        {events.length === 0 && (
          <Notice tone="warn">
            No active events. {me?.role === "admin" ? <Link className="underline" href="/admin">Create one in Admin.</Link> : "Ask an admin to create one."}
          </Notice>
        )}

        {events.length > 1 && (
          <Card>
            <p className="mb-2 text-sm text-slate-400">Event</p>
            <div className="grid gap-2">
              {events.map((e) => (
                <button
                  key={e.id}
                  onClick={() => selectEvent(e.id)}
                  className={`rounded-xl border px-4 py-3 text-left ${
                    e.id === event?.id ? "border-teal-400 bg-teal-500/10" : "border-slate-800 bg-slate-950 hover:border-slate-600"
                  }`}
                >
                  <span className="block font-semibold">{e.name}</span>
                  <span className="text-xs text-slate-400">
                    {e.days.map((d) => d.day_date).join(" · ") || "no days"}
                    {e.today_day_id ? " · today" : ""}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {event && (
          <>
            <Card>
              <h2 className="text-xl font-bold">{event.name}</h2>
              {event.location && <p className="text-sm text-slate-400">{event.location}</p>}
              <p className="mt-1 text-sm">
                {activeDay ? (
                  <span className="text-teal-300">
                    {dayName(activeDay)} · {activeDay.day_date}
                    {dayOverrideId ? " (picked by admin)" : ""}
                  </span>
                ) : (
                  <span className="text-amber-300">No event day today</span>
                )}
              </p>
              {stats && (
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <Stat label="Checked in" value={stats.today ? `${stats.today.checked_in}` : "—"} />
                  <Stat label="Registered" value={`${stats.registered}`} />
                  <Stat label="Walk-ins" value={`${stats.walk_ins}`} />
                </div>
              )}
              {stats && stats.days.length > 1 && (
                <p className="mt-3 text-xs text-slate-400">
                  {stats.days.map((d) => `${d.label}: ${d.checked_in}`).join(" · ")}
                </p>
              )}
            </Card>

            {!activeDay && me?.role !== "admin" && (
              <Notice tone="warn">Today is not an event day, so check-ins are disabled. An admin can pick a day manually.</Notice>
            )}
            <DayPicker />

            <div className="grid grid-cols-2 gap-3">
              <Tile href="/scan" emoji="📷" label="Scan" primary />
              <Tile href="/search" emoji="🔎" label="Search" />
              <Tile href="/walkin" emoji="➕" label="Walk-in" />
              <Tile href="/recent" emoji="🕘" label="My recent" />
            </div>

            <Card>
              <p className="mb-3 text-sm text-slate-400">Exports</p>
              <div className="flex flex-wrap gap-2">
                <a className={btn("secondary")} href={`/api/events/${event.id}/export.csv`}>
                  Download CSV
                </a>
                <a className={btn("secondary")} href={`/api/events/${event.id}/backup`} target="_blank" rel="noreferrer">
                  Backup list (print / PDF)
                </a>
              </div>
            </Card>
          </>
        )}

        <a href="/hr-guide.html" target="_blank" rel="noreferrer" className="block text-center text-sm text-slate-400 underline">
          Desk guide for volunteers
        </a>

        {me?.role === "admin" && (
          <Link href="/admin" className={`${btn("secondary", true)} w-full text-center`}>
            ⚙️ Admin
          </Link>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-950 py-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  );
}

function Tile({ href, emoji, label, primary }: { href: string; emoji: string; label: string; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={`flex flex-col items-center justify-center gap-1 rounded-2xl py-6 text-lg font-bold transition active:scale-[0.98] ${
        primary ? "bg-teal-500 text-slate-950" : "border border-slate-800 bg-slate-900 hover:border-slate-600"
      }`}
    >
      <span className="text-3xl" aria-hidden>
        {emoji}
      </span>
      {label}
    </Link>
  );
}
