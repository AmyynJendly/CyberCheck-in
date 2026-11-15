"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CircleCheck } from "lucide-react";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { Button, NeedEvent, Notice, Page, SearchField, Spinner, TextField, fmtTime } from "@/components/ui";

interface Row {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  class_year: string | null;
  team_name: string | null;
  short_code: string;
  source: "form" | "walk_in";
  email_status: "none" | "pending" | "sent" | "failed";
  email_error: string | null;
  checkin_id: string | null;
  checked_at: string | null;
  checked_by: string | null;
}

type Msg = { tone: "ok" | "warn" | "error"; text: string };

const EMAIL_STATUS: Record<Row["email_status"], { label: string; cls: string } | null> = {
  sent: { label: "Sent", cls: "text-sys-green" },
  failed: { label: "Failed", cls: "text-sys-red" },
  pending: { label: "Sending", cls: "text-sys-orange" },
  none: null,
};

function SearchInner() {
  const { event, activeDay } = useApp();
  const dayParam = useDayParam();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [msgs, setMsgs] = useState<Record<string, Msg>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const seq = useRef(0);

  const runSearch = useCallback(
    async (term: string) => {
      if (!event || term.trim().length < 2) {
        setRows(null);
        return;
      }
      const my = ++seq.current;
      setLoading(true);
      try {
        const qs = new URLSearchParams({ event_id: event.id, q: term.trim() });
        if (dayParam.event_day_id) qs.set("day_id", dayParam.event_day_id);
        const r = await api<{ results: Row[] }>(`/api/attendees/search?${qs}`);
        if (my === seq.current) setRows(r.results);
      } catch {
        /* offline banner */
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [event, dayParam.event_day_id],
  );

  useEffect(() => {
    const t = setTimeout(() => void runSearch(q), 250);
    return () => clearTimeout(t);
  }, [q, runSearch]);

  const setMsg = (id: string, m: Msg) => setMsgs((s) => ({ ...s, [id]: m }));

  const checkIn = async (row: Row) => {
    if (!event) return;
    setBusyId(row.id);
    try {
      const r = await api<{ status: string; checked_at?: string; by_staff_name?: string; day_label?: string }>("/api/checkin/manual", {
        body: { attendee_id: row.id, event_id: event.id, ...dayParam },
      });
      if (r.status === "OK") setMsg(row.id, { tone: "ok", text: `Checked in for ${r.day_label}.` });
      else if (r.status === "ALREADY_CHECKED_IN") setMsg(row.id, { tone: "warn", text: `Already checked in at ${fmtTime(r.checked_at)} by ${r.by_staff_name}.` });
      else if (r.status === "NO_EVENT_DAY") setMsg(row.id, { tone: "error", text: "No event day today." });
      else setMsg(row.id, { tone: "error", text: r.status });
      await runSearch(q);
    } catch (e) {
      setMsg(row.id, { tone: "error", text: errorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  const resend = async (row: Row, email?: string) => {
    setBusyId(row.id);
    try {
      const r = await api<{ ok: boolean; error?: string; email: string }>(`/api/attendees/${row.id}/resend`, {
        body: email ? { email } : {},
        timeoutMs: 30_000,
      });
      setMsg(row.id, r.ok ? { tone: "ok", text: `QR code sent to ${r.email}.` } : { tone: "error", text: `The email didn't send: ${r.error}` });
      setEditing(null);
      await runSearch(q);
    } catch (e) {
      setMsg(row.id, { tone: "error", text: errorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  if (!event) return <NeedEvent />;

  return (
    <>
      <div className="-mt-3 space-y-3">
        <SearchField value={q} onChange={setQ} placeholder="Name, email, phone or code" autoFocus />
        {!activeDay && <Notice tone="warn">No event day today. You can search, but not check in.</Notice>}
      </div>

      {loading && !rows && <Spinner label="Searching" />}
      {rows && rows.length === 0 && !loading && (
        <div className="py-10 text-center">
          <p className="t-title3">No Results</p>
          <p className="t-subhead mt-1 text-label2">Check the spelling, or add them as a walk-in.</p>
        </div>
      )}
      {!rows && !loading && (
        <p className="t-subhead px-1 text-label2">Type at least two characters. Codes work in lowercase too.</p>
      )}

      <div className="space-y-3">
        {rows?.map((r) => {
          const status = EMAIL_STATUS[r.email_status];
          return (
            <article key={r.id} className="rounded-[14px] bg-bg2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="t-headline">{r.full_name}</h2>
                  <p className="t-subhead text-label2">{[r.team_name, r.class_year, r.source === "walk_in" ? "Walk-in" : null].filter(Boolean).join(" · ") || "No team or class"}</p>
                </div>
                <span className="shrink-0 rounded-[8px] bg-bg3 px-2 py-1 font-mono text-[15px] font-semibold tracking-[0.14em]">{r.short_code}</span>
              </div>

              <dl className="t-footnote mt-3 space-y-1 text-label2">
                <div className="flex gap-2">
                  <dt className="w-12 shrink-0">Email</dt>
                  <dd className="min-w-0 break-all">
                    {r.email ?? "None"}
                    {status && <span className={`ml-1.5 font-semibold ${status.cls}`}>{status.label}</span>}
                  </dd>
                </div>
                {r.phone && (
                  <div className="flex gap-2">
                    <dt className="w-12 shrink-0">Phone</dt>
                    <dd>{r.phone}</dd>
                  </div>
                )}
                {r.email_status === "failed" && r.email_error && <p className="text-sys-red">{r.email_error}</p>}
              </dl>

              {r.checkin_id && (
                <p className="t-subhead mt-3 flex items-center gap-1.5 font-semibold text-sys-green">
                  <CircleCheck className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden />
                  Checked in at {fmtTime(r.checked_at)} by {r.checked_by}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                {!r.checkin_id && activeDay && (
                  <Button onClick={() => checkIn(r)} disabled={busyId === r.id} className="min-w-[120px] flex-1">
                    Check In
                  </Button>
                )}
                {r.email && (
                  <Button variant="gray" onClick={() => resend(r)} disabled={busyId === r.id}>
                    Resend QR
                  </Button>
                )}
                <Button
                  variant="gray"
                  onClick={() => {
                    setEditing(editing === r.id ? null : r.id);
                    setEmailDraft(r.email ?? "");
                  }}
                >
                  {r.email ? "Fix Email" : "Add Email"}
                </Button>
              </div>

              {editing === r.id && (
                <form
                  className="mt-3 flex items-center gap-2 rounded-[10px] bg-bg3 pl-3 pr-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void resend(r, emailDraft);
                  }}
                >
                  <TextField
                    type="email"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    placeholder="name@example.com"
                    autoCapitalize="off"
                    autoFocus
                    aria-label="Corrected email"
                  />
                  <Button type="submit" size="small" disabled={busyId === r.id || !emailDraft.trim()}>
                    Save & Send
                  </Button>
                </form>
              )}
              {msgs[r.id] && (
                <div className="mt-3">
                  <Notice tone={msgs[r.id].tone}>{msgs[r.id].text}</Notice>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

export default function SearchPage() {
  return (
    <Page title="Search" showContext={false}>
      <Suspense>
        <SearchInner />
      </Suspense>
    </Page>
  );
}
