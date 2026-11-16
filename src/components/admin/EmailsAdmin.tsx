"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, Notice, Section, Spinner, fmtDateTime } from "../ui";

interface EmailRow {
  id: string;
  full_name: string;
  email: string;
  email_status: "failed" | "pending";
  email_error: string | null;
  event_name: string;
  created_at: string;
}

export function EmailsAdmin() {
  const [rows, setRows] = useState<EmailRow[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api<{ emails: EmailRow[] }>("/api/admin/emails")).emails);
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Send the queue (optionally putting failed ones back first), round after round, until it's empty or Gmail pushes back. */
  const sendQueue = async (retryFailed: boolean) => {
    setBusy(true);
    setMsg({ tone: "info", text: "Sending, one at a time…" });
    let sent = 0;
    let failed = 0;
    try {
      for (let round = 0; round < 30; round++) {
        const url = retryFailed && round === 0 ? "/api/admin/emails/retry-failed" : "/api/admin/emails/send";
        const r = await api<{ sent: number; failed: number; deferred: number; remaining: number; busy: boolean }>(url, { body: {}, timeoutMs: 90_000 });
        sent += r.sent;
        failed += r.failed;
        setMsg({ tone: "info", text: `Sent ${sent}${failed ? `, failed ${failed}` : ""}… ${r.remaining} waiting` });
        if (r.remaining <= 0) break;
        if (r.deferred && !r.sent) {
          setMsg({ tone: "error", text: `Gmail is refusing for now (${r.remaining} waiting). They'll go out automatically; try again in a few minutes.` });
          return;
        }
        if (r.busy) await new Promise((res) => setTimeout(res, 3000)); // another sender is working; wait for it
      }
      setMsg({ tone: failed ? "error" : "ok", text: failed ? `Sent ${sent}. ${failed} failed; check those addresses below.` : `Sent ${sent}.` });
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const resendOne = async (r: EmailRow) => {
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; error?: string }>(`/api/attendees/${r.id}/resend`, { body: {}, timeoutMs: 30_000 });
      setMsg(res.ok ? { tone: "ok", text: `Sent to ${r.email}.` } : { tone: "error", text: `Didn't send: ${res.error}` });
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const failedCount = rows?.filter((r) => r.email_status === "failed").length ?? 0;
  const waitingCount = rows?.filter((r) => r.email_status === "pending").length ?? 0;

  return (
    <div className="space-y-7">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Button size="large" disabled={busy || !waitingCount} onClick={() => sendQueue(false)}>
          {busy ? "Sending…" : `Send Waiting Now${waitingCount ? ` (${waitingCount})` : ""}`}
        </Button>
        <Button size="large" variant="gray" disabled={busy || !failedCount} onClick={() => sendQueue(true)}>
          Retry Failed{failedCount ? ` (${failedCount})` : ""}
        </Button>
      </div>
      <p className="t-footnote -mt-4 px-1 text-label2">
        New QR emails send automatically, one at a time, right after each registration. Waiting ones are also retried every 5 minutes by the form&apos;s script.
      </p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {rows === null && <Spinner />}
      {rows?.length === 0 && (
        <div className="py-8 text-center">
          <p className="t-title3">All Emails Sent</p>
          <p className="t-subhead mt-1 text-label2">Nothing waiting or failed.</p>
        </div>
      )}
      {rows && rows.length > 0 && (
        <Section
          header="Waiting or failed"
          footer="Gmail allows about 500 emails a day. Retries go out one at a time. To fix a typo in an address, use Search → Fix Email."
        >
          {rows.map((r) => (
            <div key={r.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="t-body">{r.full_name}</p>
                <p className="t-subhead break-all text-label2">{r.email}</p>
                <p className="t-footnote mt-0.5 text-label2">
                  <span className={r.email_status === "failed" ? "font-semibold text-sys-red" : "font-semibold text-sys-orange"}>
                    {r.email_status === "failed" ? "Failed" : "Waiting"}
                  </span>{" "}
                  · {r.event_name} · {fmtDateTime(r.created_at)}
                </p>
                {r.email_error && <p className="t-footnote mt-1 text-sys-red/90">{r.email_error}</p>}
              </div>
              <Button size="small" variant="tinted" disabled={busy} onClick={() => resendOne(r)}>
                Resend
              </Button>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
