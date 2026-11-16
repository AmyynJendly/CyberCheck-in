"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, MenuSelect, Notice, Row, Section, Spinner, fmtDateTime } from "../ui";
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

const LABELS: Record<string, string> = {
  login: "Signed in",
  login_failed: "Failed sign-in",
  logout: "Signed out",
  checkin: "Checked in (QR)",
  checkin_rejected: "Scan rejected",
  manual_checkin: "Checked in (manual)",
  walk_in: "Walk-in",
  undo: "Undid check-in",
  resend: "Resent QR",
  edit_email: "Fixed email",
  email_sent: "Email sent",
  email_failed: "Email failed",
  retry_failed_emails: "Retried emails",
  form_submit: "Form response",
  form_rejected: "Form rejected",
  export: "Exported CSV",
  backup_list: "Opened backup list",
  create_event: "Created event",
  update_event: "Edited event",
  regenerate_form_secret: "New form secret",
  create_day: "Added day",
  update_day: "Edited day",
  delete_day: "Deleted day",
  create_staff: "Added staff",
  update_staff: "Edited staff",
  reset_pin: "Reset PIN",
  deactivate_staff: "Deactivated staff",
  activate_staff: "Reactivated staff",
  clear_login_blocks: "Unblocked logins",
  payment: "Payment taken",
  void_payment: "Payment cancelled",
  import_members: "Imported members",
  add_member: "Added member",
  delete_member: "Removed member",
  link_member: "Linked to member list",
};

const DOT: Record<string, string> = {
  login_failed: "bg-sys-red",
  checkin_rejected: "bg-sys-orange",
  undo: "bg-sys-orange",
  email_failed: "bg-sys-red",
  form_rejected: "bg-sys-red",
  checkin: "bg-sys-green",
  manual_checkin: "bg-sys-green",
  walk_in: "bg-sys-green",
  payment: "bg-sys-blue",
  void_payment: "bg-sys-red",
};

function summary(e: Entry): string | null {
  const d = e.details ?? {};
  if (e.action === "checkin_rejected" && typeof d.reason === "string") return d.reason.replace(/_/g, " ").toLowerCase();
  if (e.action === "login_failed" && typeof d.reason === "string") return d.reason.replace(/_/g, " ");
  if ((e.action === "email_sent" || e.action === "email_failed" || e.action === "resend") && typeof d.to === "string") return String(d.to);
  if (e.action === "edit_email") return `${d.from ?? "none"} → ${d.to}`;
  if (e.action === "form_submit" && typeof d.outcome === "string") return d.outcome.replace(/_/g, " ");
  if (e.action === "export" && d.rows !== undefined) return `${d.rows} rows`;
  if ((e.action === "payment" || e.action === "void_payment") && d.amount !== undefined) return `${d.kind} ${d.amount} DT`;
  if (e.action === "import_members") return `${d.added} new, ${d.updated} updated`;
  return null;
}

export function AuditAdmin() {
  const { events } = useApp();
  const [eventId, setEventId] = useState("");
  const [action, setAction] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
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
        setEntries((cur) => (before && cur ? [...cur, ...r.entries] : r.entries));
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
    <div className="space-y-7">
      <Section>
        <Row
          title="Event"
          trailing={<MenuSelect label="Event" value={eventId} onChange={setEventId} options={[{ value: "", label: "All" }, ...events.map((e) => ({ value: e.id, label: e.name }))]} />}
        />
        <Row
          title="Action"
          trailing={
            <MenuSelect
              label="Action"
              value={action}
              onChange={setAction}
              options={[{ value: "", label: "All" }, ...Object.entries(LABELS).map(([value, label]) => ({ value, label }))]}
            />
          }
        />
      </Section>
      {error && <Notice tone="error">{error}</Notice>}
      {entries === null && !error && <Spinner />}
      {entries?.length === 0 && <p className="t-subhead py-6 text-center text-label2">No activity.</p>}
      {entries && entries.length > 0 && (
        <Section inset={34}>
          {entries.map((e) => {
            const extra = summary(e);
            return (
              <div key={e.id} className="flex gap-3 px-4 py-2.5">
                <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${DOT[e.action] ?? "bg-label3"}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="t-subhead font-semibold">{LABELS[e.action] ?? e.action}</p>
                    <time className="t-caption shrink-0 tabular text-label2">{fmtDateTime(e.at)}</time>
                  </div>
                  <p className="t-footnote text-label2">
                    {e.staff_name ?? "System"}
                    {e.attendee_name && ` → ${e.attendee_name}`}
                    {extra && ` · ${extra}`}
                    {e.event_name && !eventId && ` · ${e.event_name}`}
                  </p>
                </div>
              </div>
            );
          })}
        </Section>
      )}
      {next && (
        <Button variant="gray" className="w-full" onClick={() => load(next)}>
          Load More
        </Button>
      )}
    </div>
  );
}
