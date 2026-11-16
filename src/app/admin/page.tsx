"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Download, Printer } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { AdminTitle } from "@/components/admin/AdminShell";
import { Notice, Spinner, btn } from "@/components/ui";
import { accessLabel, fmtDT, type DayAccess } from "@/components/types";

interface DayRow {
  id: string;
  label: string;
  day_date: string;
  access: DayAccess;
  entry_fee: number;
  capacity: number | null;
  checked_in: number;
  walk_ins: number;
  members_in: number;
  payments: number;
  cash: number;
}
interface Overview {
  event: { id: string; name: string; location: string | null; membership_fee: number };
  today_date: string;
  today: DayRow | null;
  registered: number;
  from_form: number;
  walk_ins: number;
  emails: { sent: number; pending: number; failed: number; none: number };
  cash_total: number;
  stand_total: number;
  members_to_review: number;
  days: DayRow[];
}

function Meter({ value, max }: { value: number; max: number | null }) {
  if (!max) return null;
  const pct = Math.min(100, Math.round((value / max) * 100));
  const tone = pct >= 100 ? "bg-sys-red" : pct >= 90 ? "bg-sys-orange" : "bg-accent";
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-fill" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Tile({ label, value, sub, children, warn }: { label: string; value: string; sub?: string; children?: React.ReactNode; warn?: boolean }) {
  return (
    <div className="rounded-[14px] bg-bg2 p-4">
      <p className="t-footnote text-label2">{label}</p>
      <p className={`mt-1 font-rounded text-[30px] font-bold leading-none tabular ${warn ? "text-sys-orange" : ""}`}>{value}</p>
      {sub && <p className="t-footnote mt-1.5 text-label2">{sub}</p>}
      {children}
    </div>
  );
}

export default function AdminOverview() {
  const { event, ready } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!event) return;
    try {
      setData(await api<Overview>(`/api/admin/events/${event.id}/overview`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [event]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (!ready) return <Spinner />;
  if (!event)
    return (
      <>
        <AdminTitle title="Overview" />
        <Notice tone="warn">
          No active event. <Link href="/admin/events">Create or activate one in Events.</Link>
        </Notice>
      </>
    );

  const t = data?.today;
  const left = t?.capacity ? Math.max(0, t.capacity - t.checked_in) : null;

  return (
    <>
      <AdminTitle
        title="Overview"
        subtitle={`${event.name}${t ? ` · today is ${t.label}` : " · no session today"} · updates every 10 s`}
        actions={
          <>
            <a className={btn("gray")} href={`/api/events/${event.id}/export.csv`}>
              <Download className="h-4 w-4" aria-hidden /> Full CSV
            </a>
            <a className={btn("gray")} href={`/api/events/${event.id}/backup`} target="_blank" rel="noreferrer">
              <Printer className="h-4 w-4" aria-hidden /> Backup list
            </a>
          </>
        }
      />
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <Spinner />}
      {data && data.members_to_review > 0 && (
        <div className="mb-6">
          <Notice tone="warn">
            {data.members_to_review} {data.members_to_review === 1 ? "person was" : "people were"} let in as “already a member” without being on the list.{" "}
            <Link href="/admin/members">Check them in Members.</Link>
          </Notice>
        </div>
      )}
      {data && (
        <div className="space-y-8">
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile
              label={t ? `Checked in · ${t.label}` : "Checked in today"}
              value={t ? `${t.checked_in}${t.capacity ? ` / ${t.capacity}` : ""}` : "–"}
              sub={t ? (left !== null ? (left === 0 ? "Full" : `${left} seats left`) : "No seat limit") : "Not an event day"}
              warn={left === 0}
            >
              {t && <Meter value={t.checked_in} max={t.capacity} />}
            </Tile>
            <Tile label="Registered" value={String(data.registered)} sub={`${data.from_form} form · ${data.walk_ins} walk-in`} />
            <Tile
              label="Door cash today"
              value={fmtDT(t?.cash ?? 0)}
              sub={`${fmtDT(data.cash_total)} all days${data.stand_total ? ` · ${fmtDT(data.stand_total)} at the stand` : ""}`}
            />
            <Tile
              label="QR emails"
              value={String(data.emails.sent)}
              sub={
                data.emails.pending || data.emails.failed
                  ? `${data.emails.pending} waiting · ${data.emails.failed} failed`
                  : "All sent"
              }
              warn={data.emails.failed > 0}
            />
          </section>

          <section>
            <h2 className="t-title3 mb-3">Sessions</h2>
            <div className="overflow-x-auto rounded-[14px] bg-bg2">
              <table className="w-full min-w-[720px] text-left">
                <thead className="t-footnote text-label2">
                  <tr className="border-b border-sep/60">
                    <th className="px-4 py-2.5 font-medium">Day</th>
                    <th className="px-3 py-2.5 font-medium">Entry</th>
                    <th className="px-3 py-2.5 font-medium">Seats</th>
                    <th className="px-3 py-2.5 text-right font-medium">Walk-ins</th>
                    <th className="px-3 py-2.5 text-right font-medium">Members</th>
                    <th className="px-3 py-2.5 text-right font-medium">Cash</th>
                    <th className="px-4 py-2.5 text-right font-medium">Export</th>
                  </tr>
                </thead>
                <tbody className="t-subhead">
                  {data.days.map((d) => (
                    <tr key={d.id} className={`border-b border-sep/40 last:border-0 ${d.day_date === data.today_date ? "bg-accent/[0.06]" : ""}`}>
                      <td className="px-4 py-3">
                        <p className="font-semibold">
                          {d.label}
                          {d.day_date === data.today_date && <span className="ml-2 rounded-full bg-sys-green/15 px-2 py-0.5 t-caption font-semibold text-sys-green">Today</span>}
                        </p>
                        <p className="t-footnote text-label2">{d.day_date}</p>
                      </td>
                      <td className="px-3 py-3 text-label2">{accessLabel(d, data.event.membership_fee)}</td>
                      <td className="w-44 px-3 py-3">
                        <span className="tabular">
                          {d.checked_in}
                          {d.capacity ? ` / ${d.capacity}` : ""}
                        </span>
                        <Meter value={d.checked_in} max={d.capacity} />
                      </td>
                      <td className="px-3 py-3 text-right tabular">{d.walk_ins}</td>
                      <td className="px-3 py-3 text-right tabular">{d.access === "free" ? "–" : d.members_in}</td>
                      <td className="px-3 py-3 text-right tabular">{d.cash ? fmtDT(d.cash) : "–"}</td>
                      <td className="px-4 py-3 text-right">
                        <a
                          className={btn("tinted", "small")}
                          href={`/api/events/${event.id}/export.csv?day_id=${d.id}`}
                          aria-label={`Download CSV for ${d.label}`}
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden /> CSV
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="t-footnote mt-2 px-1 text-label2">
              Each day&apos;s CSV lists the people checked in that day (time, staff, payment). Download it after each session.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
