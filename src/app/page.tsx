"use client";

import Link from "next/link";
import { useState } from "react";
import { Banknote, BookOpen, Check, FileSpreadsheet, History, Printer, ScanLine, Search, Settings, UserPlus } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { api } from "@/components/api";
import { useStats } from "@/components/useStats";
import { DayPicker } from "@/components/DayPicker";
import { IconTile, Initials, Notice, OfflineBanner, Row, Section, Sheet, SheetAction, Spinner, btn } from "@/components/ui";
import { accessLabel, dayName } from "@/components/types";

const ic = "h-[17px] w-[17px]";

export default function Home() {
  const { ready, me, events, event, selectEvent, activeDay, dayOverrideId } = useApp();
  const { stats } = useStats(event?.id, dayOverrideId, 15_000);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const logout = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => {});
    window.location.href = "/login";
  };

  if (!ready) return <Spinner />;

  const checked = stats?.today?.checked_in ?? 0;
  const registered = stats?.registered ?? 0;
  const pct = registered ? Math.min(100, Math.round((checked / registered) * 100)) : 0;

  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <OfflineBanner />
      <header className="flex items-end justify-between px-4 pb-1 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <div>
          <p className="t-footnote font-semibold uppercase tracking-wide text-label2">
            {new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tunis", weekday: "long", day: "numeric", month: "long" }).format(new Date())}
          </p>
          <h1 className="t-large">Check-in</h1>
        </div>
        <button type="button" onClick={() => setConfirmLogout(true)} aria-label={`Signed in as ${me?.name}. Account`} className="mb-1 active:opacity-60">
          <Initials name={me?.name ?? "?"} size={36} />
        </button>
      </header>

      <main className="mt-5 space-y-7 px-4">
        {events.length === 0 && (
          <Notice tone="warn">
            No active events. {me?.role === "admin" ? <Link href="/admin">Create one in Admin.</Link> : "Ask an admin to create one."}
          </Notice>
        )}

        {events.length > 1 && (
          <Section header="Event">
            {events.map((e) => (
              <Row
                key={e.id}
                title={e.name}
                subtitle={e.days.map((d) => d.day_date).join(" · ") || "No days yet"}
                onClick={() => selectEvent(e.id)}
                trailing={e.id === event?.id ? <Check className="h-5 w-5 text-accent" strokeWidth={2.6} aria-label="Selected" /> : undefined}
              />
            ))}
          </Section>
        )}

        {event && (
          <>
            <section className="rounded-[16px] bg-bg2 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="t-title2 truncate">{event.name}</h2>
                  <p className="t-subhead mt-0.5 text-label2">
                    {[event.location, activeDay ? `${dayName(activeDay)}${dayOverrideId ? " (picked)" : ""}` : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {activeDay ? (
                  <span className="t-caption shrink-0 rounded-full bg-sys-green/15 px-2.5 py-1 font-semibold text-sys-green">Live</span>
                ) : (
                  <span className="t-caption shrink-0 rounded-full bg-sys-orange/15 px-2.5 py-1 font-semibold text-sys-orange">No event today</span>
                )}
              </div>

              <div className="mt-5 flex items-baseline gap-2">
                <span className="font-rounded text-[56px] font-bold leading-none tracking-tight tabular">{stats ? (stats.today ? checked : "–") : " "}</span>
                <span className="t-body text-label2">
                  of <span className="tabular">{registered}</span> checked in{activeDay ? " today" : ""}
                </span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-fill" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
              </div>
              {stats && (
                <dl className="mt-4 grid grid-cols-3 gap-2">
                  <Stat label="Registered" value={stats.from_form} />
                  <Stat label="Walk-ins" value={stats.walk_ins} />
                  <Stat label="Email issues" value={stats.emails.failed} warn={stats.emails.failed > 0} />
                </dl>
              )}
              {activeDay && activeDay.access !== "free" && (
                <p className="t-subhead mt-4 rounded-[10px] bg-sys-blue/15 px-3 py-2 font-semibold text-sys-blue">Today: {accessLabel(activeDay, event.membership_fee)}</p>
              )}
              {stats && stats.days.length > 1 && (
                <p className="t-footnote mt-3 text-label2">{stats.days.map((d) => `${d.label}: ${d.checked_in}`).join("  ·  ")}</p>
              )}
            </section>

            {!activeDay && me?.role !== "admin" && (
              <Notice tone="warn">Today isn't an event day, so check-in is off. An admin can pick a day.</Notice>
            )}
            <DayPicker />

            <Link href="/scan" className={`${btn("filled", "large")} w-full`}>
              <ScanLine className="h-5 w-5" strokeWidth={2.4} aria-hidden />
              Scan Tickets
            </Link>

            <Section inset={60}>
              <Row href="/search" icon={<IconTile color="bg-sys-blue"><Search className={ic} strokeWidth={2.4} /></IconTile>} title="Search" chevron />
              <Row href="/walkin" icon={<IconTile color="bg-sys-green"><UserPlus className={ic} strokeWidth={2.4} /></IconTile>} title="Walk-in" chevron />
              <Row href="/recent" icon={<IconTile color="bg-sys-orange"><History className={ic} strokeWidth={2.4} /></IconTile>} title="My Check-ins" chevron />
              {event.days.some((d) => d.access !== "free") && (
                <Row href="/cash" icon={<IconTile color="bg-[#34c759]"><Banknote className={ic} strokeWidth={2.2} /></IconTile>} title="Cash" subtitle="Payments taken at the desk" chevron />
              )}
            </Section>

            <Section header="Exports" inset={60}>
              <Row
                href={`/api/events/${event.id}/export.csv`}
                external
                icon={<IconTile color="bg-[#30b0c7]"><FileSpreadsheet className={ic} strokeWidth={2.2} /></IconTile>}
                title="Download CSV"
              />
              <Row
                href={`/api/events/${event.id}/backup`}
                external
                icon={<IconTile color="bg-sys-gray"><Printer className={ic} strokeWidth={2.2} /></IconTile>}
                title="Backup List"
                subtitle="Print or save as PDF"
              />
            </Section>
          </>
        )}

        <Section inset={60}>
          <Row
            href="/hr-guide.html"
            external
            icon={<IconTile color="bg-sys-indigo"><BookOpen className={ic} strokeWidth={2.2} /></IconTile>}
            title="Desk Guide"
          />
          {me?.role === "admin" && (
            <Row href="/admin" icon={<IconTile color="bg-sys-gray"><Settings className={ic} strokeWidth={2.2} /></IconTile>} title="Admin" chevron />
          )}
        </Section>

        <Section footer={`Signed in as ${me?.name} · ${me?.role === "admin" ? "Admin" : "HR"}`}>
          <Row title="Sign Out" destructive onClick={() => setConfirmLogout(true)} />
        </Section>
      </main>

      <Sheet open={confirmLogout} onClose={() => setConfirmLogout(false)} title={`Signed in as ${me?.name}`}>
        <SheetAction destructive onClick={logout}>
          Sign Out
        </SheetAction>
      </Sheet>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-[10px] bg-bg3 px-3 py-2.5">
      <dt className="t-caption text-label2">{label}</dt>
      <dd className={`t-title3 tabular font-rounded ${warn ? "text-sys-orange" : ""}`}>{value}</dd>
    </div>
  );
}
