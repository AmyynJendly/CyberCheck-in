"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, Notice, fmtDateTime, inputClass } from "../ui";
import { useApp } from "../AppContext";

interface Entry {
  id: number;
  at: string;
  action: string;
  staff_name: string | null;
  attendee_name: string | null;
  event_name: string | null;
  details: Record<string, unknown> | null;
}

const ACTIONS = [
  "",
  "login",
  "login_failed",
  "checkin",
  "checkin_rejected",
  "manual_checkin",
  "walk_in",
  "undo",
  "resend",
  "edit_email",
  "email_sent",
  "email_failed",
  "form_submit",
  "form_rejected",
  "export",
  "create_event",
  "update_event",
  "create_staff",
  "update_staff",
  "reset_pin",
  "deactivate_staff",
];

const TONE: Record<string, string> = {
  login_failed: "text-red-300",
  checkin_rejected: "text-orange-300",
  undo: "text-amber-300",
  email_failed: "text-red-300",
  form_rejected: "text-red-300",
  checkin: "text-emerald-300",
  manual_checkin: "text-emerald-300",
  walk_in: "text-emerald-300",
};

export function AuditAdmin() {
  const { events } = useApp();
  const [eventId, setEventId] = useState("");
  const [action, setAction] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number) => {
      try {
        const qs = new URLSearchParams({ limit: "100" });
        if (eventId) qs.set("event_id", eventId);
        if (action) qs.set("action", action);
        if (before) qs.set("before_id", String(before));
        const r = await api<{ entries: Entry[]; next_before_id: number | null }>(`/api/admin/audit?${qs}`);
        setEntries((cur) => (before ? [...cur, ...r.entries] : r.entries));
        setNext(r.next_before_id);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [eventId, action],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <select className={inputClass} value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <option value="">All events</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select className={inputClass} value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a || "All actions"}
            </option>
          ))}
        </select>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="divide-y divide-slate-800 rounded-2xl border border-slate-800">
        {entries.map((e) => (
          <div key={e.id} className="px-3 py-2 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs text-slate-500">{fmtDateTime(e.at)}</span>
              <span className={`font-semibold ${TONE[e.action] ?? ""}`}>{e.action}</span>
              <span className="text-slate-300">{e.staff_name ?? "system"}</span>
              {e.attendee_name && <span className="text-slate-400">→ {e.attendee_name}</span>}
              {e.event_name && <span className="text-xs text-slate-500">({e.event_name})</span>}
            </div>
            {e.details && <p className="break-all font-mono text-xs text-slate-500">{JSON.stringify(e.details)}</p>}
          </div>
        ))}
        {!entries.length && <p className="p-3 text-slate-400">No entries.</p>}
      </div>
      {next && (
        <Button variant="secondary" onClick={() => load(next)}>
          Load more
        </Button>
      )}
    </div>
  );
}
