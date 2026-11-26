"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, History, LayoutDashboard, ScanLine, Search, UserPlus, UsersRound } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { api } from "@/components/api";
import { useStats } from "@/components/useStats";
import { DayPicker } from "@/components/DayPicker";
import { IconTile, Initials, Notice, OfflineBanner, Row, Section, Sheet, SheetAction, Spinner, btn } from "@/components/ui";
import { accessLabel, dayName, fmtDT } from "@/components/types";

const ic = "h-[17px] w-[17px]";

/** The HR app: scan, search, add a person. Everything else lives in the admin dashboard. */
export default function Home() {
  const { ready, me, events, event, selectEvent, activeDay, dayOverrideId } = useApp();
  const { stats } = useStats(event?.id, dayOverrideId, 10_000);
  const [account, setAccount] = useState(false);

  const logout = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => {});
    window.location.href = "/login";
  };

  if (!ready) return <Spinner />;

  const today = stats?.today ?? null;
  const capacity = today?.capacity ?? activeDay?.capacity ?? null;
  const checked = today?.checked_in ?? 0;
  const max = capacity ?? stats?.registered ?? 0;
  const pct = max ? Math.min(100, Math.round((checked / max) * 100)) : 0;
  const left = capacity !== null ? Math.max(0, capacity - checked) : null;
  const paidDay = !!activeDay && activeDay.access !== "free";

  return (
    <div className="mx-auto min-h-dvh max-w-lg pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <OfflineBanner />
      <header className="flex items-end justify-between px-4 pb-1 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <div>
          <p className="t-footnote font-semibold uppercase tracking-wide text-label2">
            {new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tunis", weekday: "long", day: "numeric", month: "long" }).format(new Date())}
          </p>
          <h1 className="t-large">Check-in</h1>
        </div>
        <button type="button" onClick={() => setAccount(true)} aria-label={`Signed in as ${me?.name}. Account`} className="mb-1 active:opacity-60">
          <Initials name={me?.name ?? "?"} size={36} />
        </button>
      </header>

      <main className="mt-5 space-y-6 px-4">
        {events.length === 0 && (
          <Notice tone="warn">
            No active event. {me?.role === "admin" ? <Link href="/admin/events">Create one in the admin dashboard.</Link> : "Ask an admin."}
          </Notice>
        )}

        {events.length > 1 && (
          <Section header="Event">
            {events.map((e) => (
              <Row
                key={e.id}
                title={e.name}
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
                  <h2 className="t-title3 truncate">{event.name}</h2>
                  <p className="t-subhead text-label2">{activeDay ? `${dayName(activeDay)}${dayOverrideId ? " (picked)" : ""}` : "No session today"}</p>
                </div>
                {activeDay ? (
                  left === 0 ? (
                    <span className="t-caption shrink-0 rounded-full bg-sys-red/15 px-2.5 py-1 font-semibold text-sys-red">Full</span>
                  ) : (
                    <span className="t-caption shrink-0 rounded-full bg-sys-green/15 px-2.5 py-1 font-semibold text-sys-green">Open</span>
                  )
                ) : (
                  <span className="t-caption shrink-0 rounded-full bg-sys-orange/15 px-2.5 py-1 font-semibold text-sys-orange">Closed</span>
                )}
              </div>
              {activeDay && (
                <>
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="font-rounded text-[52px] font-bold leading-none tracking-tight tabular">{stats ? checked : " "}</span>
                    <span className="t-body text-label2">
                      / <span className="tabular">{max}</span> {capacity !== null ? "seats" : "registered"}
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-fill" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`h-full rounded-full transition-[width] duration-500 ${left === 0 ? "bg-sys-red" : "bg-accent"}`} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="t-footnote mt-2 text-label2">
                    {left !== null ? (left === 0 ? "No seats left." : `${left} seat${left === 1 ? "" : "s"} left`) : "No seat limit"}
                    {" · "}
                    {accessLabel(activeDay, event.membership_fee)}
                  </p>
                </>
              )}
            </section>

            {paidDay && (stats?.my_cash_today ?? 0) > 0 && (
              <Notice tone="info">
                You&apos;ve collected <strong className="tabular">{fmtDT(stats!.my_cash_today)}</strong> today. Hand it to the admin at the end of your shift.
              </Notice>
            )}

            {!activeDay && me?.role !== "admin" && <Notice tone="warn">Today isn&apos;t a session day, so check-in is off.</Notice>}
            {activeDay && left === 0 && (
              <Notice tone="error">
                <strong>Session full.</strong> Only people who paid at the stand can still enter. The admin can open more seats.
              </Notice>
            )}

            <Link href="/scan" className={`${btn("filled", "large")} h-[64px] w-full text-[19px]`}>
              <ScanLine className="h-6 w-6" strokeWidth={2.4} aria-hidden />
              Scan Tickets
            </Link>

            <div className="grid grid-cols-2 gap-3">
              <Link href="/search" className="flex flex-col items-start gap-3 rounded-[16px] bg-bg2 p-4 active:bg-bg3">
                <IconTile color="bg-sys-blue">
                  <Search className={ic} strokeWidth={2.4} />
                </IconTile>
                <span>
                  <span className="block t-headline">Search</span>
                  <span className="block t-footnote text-label2">Name, phone, code</span>
                </span>
              </Link>
              <Link href="/walkin" className="flex flex-col items-start gap-3 rounded-[16px] bg-bg2 p-4 active:bg-bg3">
                <IconTile color="bg-sys-green">
                  <UserPlus className={ic} strokeWidth={2.4} />
                </IconTile>
                <span>
                  <span className="block t-headline">Add Person</span>
                  <span className="block t-footnote text-label2">Not registered</span>
                </span>
              </Link>
            </div>

            <Section inset={60}>
              <Row
                href="/recent"
                icon={
                  <IconTile color="bg-sys-orange">
                    <History className={ic} strokeWidth={2.4} />
                  </IconTile>
                }
                title="My Check-ins"
                subtitle="Undo a mistake (10 min)"
                chevron
              />
              <Row
                href="/teams"
                icon={
                  <IconTile color="bg-sys-indigo">
                    <UsersRound className={ic} strokeWidth={2.4} />
                  </IconTile>
                }
                title="Teams"
                subtitle="CTF teams, free spots, who has no team"
                chevron
              />
            </Section>
          </>
        )}

        {me?.role === "admin" && (
          <>
            <Link href="/admin" className={`${btn("gray", "large")} w-full`}>
              <LayoutDashboard className="h-5 w-5" strokeWidth={2.2} aria-hidden />
              Admin Dashboard
            </Link>
            <DayPicker />
          </>
        )}

        <Section footer={`Signed in as ${me?.name} · ${me?.role === "admin" ? "Admin" : "HR"}`}>
          <Row title="Sign Out" destructive onClick={() => setAccount(true)} />
        </Section>
      </main>

      <Sheet open={account} onClose={() => setAccount(false)} title={`Signed in as ${me?.name}`}>
        <SheetAction destructive onClick={logout}>
          Sign Out
        </SheetAction>
      </Sheet>
    </div>
  );
}
