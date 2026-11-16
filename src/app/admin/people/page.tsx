"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Download } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { AdminTitle } from "@/components/admin/AdminShell";
import { MemberBadge } from "@/components/Payment";
import { NeedEvent, Notice, SearchField, Segmented, Spinner, btn, fmtTime } from "@/components/ui";
import { fmtDT } from "@/components/types";

interface Day {
  id: string;
  day_date: string;
  label: string | null;
}
interface Person {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  source: "form" | "walk_in";
  short_code: string;
  email_status: string;
  email_error: string | null;
  member_until: string | null;
  added_by: string | null;
  days: Record<string, { checked_at: string; by: string; method: string; paid?: { kind: string; amount: number; by: string } }>;
}

type Filter = "all" | "in" | "out" | "walk_in" | "members";

const EMAIL_TONE: Record<string, string> = { sent: "text-sys-green", pending: "text-sys-orange", failed: "text-sys-red", none: "text-label3" };

export default function AdminPeople() {
  const { event, activeDay } = useApp();
  const [data, setData] = useState<{ days: Day[]; people: Person[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    if (!event) return;
    try {
      setData(await api(`/api/admin/events/${event.id}/people`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [event]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const todayId = activeDay?.id;
  const rows = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    const digits = term.replace(/\D/g, "");
    return data.people.filter((p) => {
      if (filter === "in" && !(todayId && p.days[todayId])) return false;
      if (filter === "out" && todayId && p.days[todayId]) return false;
      if (filter === "walk_in" && p.source !== "walk_in") return false;
      if (filter === "members" && !p.member_until) return false;
      if (!term) return true;
      return (
        p.full_name.toLowerCase().includes(term) ||
        (p.email ?? "").includes(term) ||
        p.short_code.toLowerCase() === term ||
        (digits.length >= 3 && (p.phone ?? "").replace(/\D/g, "").includes(digits))
      );
    });
  }, [data, q, filter, todayId]);

  if (!event)
    return (
      <>
        <AdminTitle title="People" />
        <NeedEvent />
      </>
    );

  return (
    <>
      <AdminTitle
        title="People"
        subtitle={data ? `${rows.length} of ${data.people.length} shown` : undefined}
        actions={
          <a className={btn("gray")} href={`/api/events/${event.id}/export.csv`}>
            <Download className="h-4 w-4" aria-hidden /> Full CSV
          </a>
        }
      />
      <div className="mb-4 space-y-3">
        <SearchField value={q} onChange={setQ} placeholder="Name, email, phone or code" />
        <div className="max-w-xl">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "in", label: todayId ? "In today" : "In" },
              { value: "out", label: "Not yet" },
              { value: "walk_in", label: "Walk-ins" },
              { value: "members", label: "Members" },
            ]}
          />
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <Spinner />}
      {data && (
        <div className="overflow-x-auto rounded-[14px] bg-bg2">
          <table className="w-full min-w-[760px] text-left">
            <thead className="t-footnote text-label2">
              <tr className="border-b border-sep/60">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Contact</th>
                <th className="px-3 py-2.5 font-medium">QR email</th>
                {data.days.map((d) => (
                  <th key={d.id} className={`px-2 py-2.5 text-center font-medium ${d.id === todayId ? "text-accent" : ""}`} title={d.day_date}>
                    {d.label || d.day_date}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="t-subhead">
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-sep/40 last:border-0">
                  <td className="px-4 py-2.5">
                    <p className="font-semibold">
                      {p.full_name} {p.member_until && <MemberBadge small />}
                    </p>
                    <p className="t-footnote text-label2">
                      <span className="font-mono tracking-wider">{p.short_code}</span>
                      {p.source === "walk_in" && ` · walk-in${p.added_by ? ` by ${p.added_by}` : ""}`}
                    </p>
                  </td>
                  <td className="max-w-[240px] px-3 py-2.5">
                    <p className="truncate">{p.email ?? <span className="text-label3">no email</span>}</p>
                    <p className="t-footnote text-label2">{p.phone}</p>
                  </td>
                  <td className={`px-3 py-2.5 t-footnote font-semibold capitalize ${EMAIL_TONE[p.email_status] ?? ""}`} title={p.email_error ?? undefined}>
                    {p.email_status === "none" ? "—" : p.email_status === "pending" ? "waiting" : p.email_status}
                  </td>
                  {data.days.map((d) => {
                    const c = p.days[d.id];
                    return (
                      <td key={d.id} className="px-2 py-2.5 text-center">
                        {c ? (
                          <span
                            className="inline-grid h-6 w-6 place-items-center rounded-full bg-sys-green/20 text-sys-green"
                            title={`${fmtTime(c.checked_at)} by ${c.by}${c.paid ? ` · paid ${fmtDT(c.paid.amount)} (${c.paid.kind})` : ""}`}
                          >
                            <Check className="h-4 w-4" strokeWidth={3} aria-label={`Checked in at ${fmtTime(c.checked_at)} by ${c.by}`} />
                          </span>
                        ) : (
                          <span className="text-label3" aria-label="Not checked in">
                            ·
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3 + data.days.length} className="px-4 py-8 text-center text-label2">
                    Nobody matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
