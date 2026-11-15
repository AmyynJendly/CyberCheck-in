"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { Button, Card, NeedEvent, Notice, Page, fmtTime, inputClass } from "@/components/ui";

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
        /* banner */
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
      const r = await api<{ status: string; checked_at?: string; by_staff_name?: string; day_label?: string; other_event_name?: string }>(
        "/api/checkin/manual",
        { body: { attendee_id: row.id, event_id: event.id, ...dayParam } },
      );
      if (r.status === "OK") setMsg(row.id, { tone: "ok", text: `✓ Checked in (${r.day_label})` });
      else if (r.status === "ALREADY_CHECKED_IN")
        setMsg(row.id, { tone: "warn", text: `Already checked in at ${fmtTime(r.checked_at)} by ${r.by_staff_name}` });
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
      setMsg(row.id, r.ok ? { tone: "ok", text: `QR sent to ${r.email}` } : { tone: "error", text: `Email failed: ${r.error}` });
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
      <input
        autoFocus
        className={inputClass}
        placeholder="Name, email, phone or 6-letter code"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        inputMode="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {!activeDay && <Notice tone="warn">No event day today — check-in is disabled (search still works).</Notice>}
      {loading && <p className="text-sm text-slate-500">Searching…</p>}
      {rows && rows.length === 0 && !loading && <p className="text-slate-400">No one found. Add them as a walk-in?</p>}
      {rows?.map((r) => (
        <Card key={r.id}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-lg font-bold">{r.full_name}</p>
              <p className="text-sm text-slate-400">{[r.team_name, r.class_year].filter(Boolean).join(" · ") || "—"}</p>
              <p className="break-words text-sm text-slate-400">
                <span className="break-all">{r.email ?? "no email"}</span> <EmailBadge status={r.email_status} />
                {r.phone && <span className="whitespace-nowrap"> · {r.phone}</span>}
              </p>
              {r.email_status === "failed" && r.email_error && <p className="text-xs text-red-300">{r.email_error}</p>}
            </div>
            <span className="rounded-lg bg-slate-950 px-2 py-1 font-mono text-sm tracking-widest">{r.short_code}</span>
          </div>

          {r.checkin_id ? (
            <p className="mt-3 text-sm font-semibold text-emerald-300">
              ✓ Checked in {fmtTime(r.checked_at)} by {r.checked_by}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {!r.checkin_id && activeDay && (
              <Button big onClick={() => checkIn(r)} disabled={busyId === r.id} className="flex-1">
                Check in
              </Button>
            )}
            {r.email && (
              <Button variant="secondary" onClick={() => resend(r)} disabled={busyId === r.id}>
                Resend QR
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(editing === r.id ? null : r.id);
                setEmailDraft(r.email ?? "");
              }}
            >
              {r.email ? "Fix email" : "Add email"}
            </Button>
          </div>

          {editing === r.id && (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void resend(r, emailDraft);
              }}
            >
              <input className={inputClass} type="email" value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} placeholder="correct@email.com" />
              <Button type="submit" disabled={busyId === r.id}>
                Save & send
              </Button>
            </form>
          )}
          {msgs[r.id] && (
            <div className="mt-3">
              <Notice tone={msgs[r.id].tone}>{msgs[r.id].text}</Notice>
            </div>
          )}
        </Card>
      ))}
    </>
  );
}

function EmailBadge({ status }: { status: Row["email_status"] }) {
  const map = {
    sent: "text-emerald-400",
    failed: "text-red-400",
    pending: "text-amber-400",
    none: "text-slate-500",
  } as const;
  if (status === "none") return null;
  return <span className={`text-xs font-semibold ${map[status]}`}>({status})</span>;
}

export default function SearchPage() {
  return (
    <Page title="Search">
      <Suspense>
        <SearchInner />
      </Suspense>
    </Page>
  );
}
