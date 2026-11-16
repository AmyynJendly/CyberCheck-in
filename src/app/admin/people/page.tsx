"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Download, FileUp } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { AdminTitle } from "@/components/admin/AdminShell";
import { MemberBadge } from "@/components/Payment";
import { Button, NeedEvent, Notice, SearchField, Segmented, Sheet, SheetAction, Spinner, btn, fmtTime } from "@/components/ui";
import { StandImport } from "@/components/admin/StandImport";
import { errorMessage as errMsg } from "@/components/api";
import { fmtDT } from "@/components/types";

interface Day {
  id: string;
  day_date: string;
  label: string | null;
  access: "free" | "members" | "members_or_fee";
  entry_fee: number;
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
  member_source: string | null;
  member_review: boolean | null;
  enrollment: string | null;
  enroll_sessions: boolean | null;
  enroll_main: boolean | null;
  added_by: string | null;
  days: Record<string, { checked_at: string; by: string; method: string; paid?: { kind: string; amount: number; by: string } }>;
  payments: { kind: string; amount: number; channel: string; day_id: string | null; by: string }[];
}

type Filter = "all" | "in" | "out" | "walk_in" | "members";

const EMAIL_TONE: Record<string, string> = { sent: "text-sys-green", pending: "text-sys-orange", failed: "text-sys-red", none: "text-label3" };

export default function AdminPeople() {
  const { event, activeDay } = useApp();
  const [data, setData] = useState<{ days: Day[]; people: Person[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Person | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const record = async (p: Person, kind: "membership" | "entry" | "member") => {
    setSelected(null);
    try {
      await api(`/api/admin/attendees/${p.id}/payment`, { body: { kind } });
      setNotice({
        tone: "ok",
        text:
          kind === "membership"
            ? `${p.full_name} paid ${fmtDT(event?.membership_fee ?? 15)} and is now a member.`
            : kind === "entry"
              ? `${p.full_name}'s main-event entry is marked as paid.`
              : `${p.full_name} is marked as a member (no payment).`,
      });
      await load();
    } catch (e) {
      setNotice({ tone: "error", text: errMsg(e) });
    }
  };

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
          <>
            <Button variant={importing ? "tinted" : "gray"} onClick={() => setImporting((v) => !v)}>
              <FileUp className="h-4 w-4" aria-hidden /> Import sheet
            </Button>
            <a className={btn("gray")} href={`/api/events/${event.id}/export.csv`}>
              <Download className="h-4 w-4" aria-hidden /> Full CSV
            </a>
          </>
        }
      />
      {importing && (
        <div className="mb-8 max-w-3xl">
          <StandImport eventId={event.id} onDone={load} />
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
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
                <th className="px-3 py-2.5 font-medium">Enrolled</th>
                <th className="px-3 py-2.5 font-medium">Paid</th>
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
                <tr key={p.id} onClick={() => setSelected(p)} className="cursor-pointer border-b border-sep/40 last:border-0 hover:bg-fill/40">
                  <td className="px-4 py-2.5">
                    <p className="font-semibold">
                      {p.full_name} {p.member_until && <MemberBadge small />}
                      {p.member_review && <span className="ml-1 rounded-full bg-sys-orange/15 px-2 py-0.5 t-caption font-semibold text-sys-orange">to check</span>}
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
                  <td className="px-3 py-2.5 t-footnote text-label2" title={p.enrollment ?? undefined}>
                    {[p.enroll_sessions && "Sessions", p.enroll_main && "Main"].filter(Boolean).join(" + ") || (p.enrollment ? "?" : "—")}
                  </td>
                  <td className="px-3 py-2.5 t-footnote">
                    {p.payments.length
                      ? p.payments.map((x, i) => (
                          <span key={i} className="block whitespace-nowrap">
                            {fmtDT(x.amount)} <span className="text-label2">{x.kind === "membership" ? "member" : "entry"}{x.channel === "stand" ? " · stand" : ""}</span>
                          </span>
                        ))
                      : <span className="text-label3">—</span>}
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
                  <td colSpan={5 + data.days.length} className="px-4 py-8 text-center text-label2">
                    Nobody matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {selected && data && (
        <Sheet
          open
          onClose={() => setSelected(null)}
          title={selected.full_name}
          message={
            selected.member_until
              ? `Member until ${selected.member_until}${selected.member_review ? " (claimed at the door, to check in Members)" : ""}.`
              : "Not a member. Record a payment taken outside the door (for example during the free session)."
          }
        >
          {!selected.member_until && (
            <>
              <SheetAction onClick={() => record(selected, "membership")}>Paid {fmtDT(event.membership_fee)} · Join the club</SheetAction>
              {data.days.some((d) => d.access === "members_or_fee") &&
                !selected.payments.some((x) => x.kind === "entry") && (
                  <SheetAction onClick={() => record(selected, "entry")}>
                    Paid {fmtDT(data.days.find((d) => d.access === "members_or_fee")!.entry_fee)} · {data.days.find((d) => d.access === "members_or_fee")!.label} entry
                  </SheetAction>
                )}
              <SheetAction onClick={() => record(selected, "member")}>Is a member · no payment</SheetAction>
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
