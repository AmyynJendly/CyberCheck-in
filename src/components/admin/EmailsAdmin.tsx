"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, Card, Notice, fmtDateTime } from "../ui";

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

  const retryAll = async () => {
    setBusy(true);
    setMsg({ tone: "info", text: "Sending, one at a time…" });
    let sent = 0;
    let failed = 0;
    try {
      for (let round = 0; round < 20; round++) {
        const r = await api<{ sent: number; failed: number; remaining: number }>("/api/admin/emails/retry-failed", { body: {}, timeoutMs: 90_000 });
        sent += r.sent;
        failed += r.failed;
        setMsg({ tone: "info", text: `Sent ${sent}, failed ${failed}…` });
        if (r.remaining <= 0) break;
      }
      setMsg({ tone: failed ? "error" : "ok", text: `Done. Sent ${sent}, still failing ${failed}.` });
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
      setMsg(res.ok ? { tone: "ok", text: `Sent to ${r.email}` } : { tone: "error", text: `Failed: ${res.error}` });
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const failedCount = rows?.filter((r) => r.email_status === "failed").length ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Emails that failed, or are stuck as pending. Gmail allows about 500 emails a day; retries go out one at a time.
      </p>
      <Button big className="w-full" disabled={busy || !rows?.length} onClick={retryAll}>
        Retry all failed ({failedCount})
      </Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {rows?.length === 0 && <Notice tone="ok">No failed or pending emails. 🎉</Notice>}
      {rows?.map((r) => (
        <Card key={r.id}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-bold">{r.full_name}</p>
              <p className="break-all text-sm text-slate-400">{r.email}</p>
              <p className="text-xs text-slate-500">
                {r.event_name} · {fmtDateTime(r.created_at)} ·{" "}
                <span className={r.email_status === "failed" ? "text-red-400" : "text-amber-400"}>{r.email_status}</span>
              </p>
              {r.email_error && <p className="mt-1 text-xs text-red-300">{r.email_error}</p>}
            </div>
            <Button variant="secondary" disabled={busy} onClick={() => resendOne(r)}>
              Resend
            </Button>
          </div>
        </Card>
      ))}
      <p className="text-xs text-slate-500">To fix a typo in an address, use Search → Fix email.</p>
    </div>
  );
}
