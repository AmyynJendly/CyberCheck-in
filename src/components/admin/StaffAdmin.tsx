"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, Card, Field, Notice, inputClass } from "../ui";
import { useApp } from "../AppContext";

interface StaffRow {
  id: string;
  name: string;
  role: "hr" | "admin";
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
  is_locked: boolean;
}

export function StaffAdmin() {
  const { me } = useApp();
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [f, setF] = useState({ name: "", pin: "", role: "hr" as "hr" | "admin" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStaff((await api<{ staff: StaffRow[] }>("/api/admin/staff")).staff);
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const patch = (s: StaffRow, body: Record<string, unknown>, ok: string) =>
    run(() => api(`/api/admin/staff/${s.id}`, { method: "PATCH", body }), ok);

  return (
    <div className="space-y-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Card>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/api/admin/staff", { body: f });
              setF({ name: "", pin: "", role: "hr" });
            }, "Staff member added. Give them their PIN in person.");
          }}
        >
          <h3 className="text-lg font-bold">Add staff</h3>
          <Field label="Name">
            <input className={inputClass} value={f.name} required onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="6-digit PIN">
              <input
                className={inputClass}
                value={f.pin}
                required
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                onChange={(e) => setF((s) => ({ ...s, pin: e.target.value.replace(/\D/g, "") }))}
              />
            </Field>
            <Field label="Role">
              <select className={inputClass} value={f.role} onChange={(e) => setF((s) => ({ ...s, role: e.target.value as "hr" | "admin" }))}>
                <option value="hr">HR</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
          </div>
          <Button type="submit" disabled={busy}>
            Add
          </Button>
        </form>
      </Card>

      {staff?.map((s) => (
        <Card key={s.id} className={s.is_active ? "" : "opacity-60"}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-bold">
                {s.name} {s.id === me?.id && <span className="text-xs text-slate-400">(you)</span>}
              </p>
              <p className="text-xs text-slate-400">
                {s.role}
                {!s.is_active && " · deactivated"}
                {s.is_locked && " · 🔒 locked"}
                {s.failed_attempts > 0 && ` · ${s.failed_attempts} wrong PIN${s.failed_attempts > 1 ? "s" : ""}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  const pin = prompt(`New 6-digit PIN for ${s.name}:`);
                  if (pin) void patch(s, { pin: pin.trim() }, `PIN reset for ${s.name}.`);
                }}
              >
                Reset PIN
              </Button>
              {s.is_locked && (
                <Button variant="secondary" disabled={busy} onClick={() => patch(s, { unlock: true }, `${s.name} unlocked.`)}>
                  Unlock
                </Button>
              )}
              {s.id !== me?.id && (
                <>
                  <Button variant="secondary" disabled={busy} onClick={() => patch(s, { role: s.role === "admin" ? "hr" : "admin" }, "Role changed.")}>
                    Make {s.role === "admin" ? "HR" : "admin"}
                  </Button>
                  <Button
                    variant={s.is_active ? "danger" : "primary"}
                    disabled={busy}
                    onClick={() => patch(s, { is_active: !s.is_active }, s.is_active ? `${s.name} deactivated.` : `${s.name} reactivated.`)}
                  >
                    {s.is_active ? "Deactivate" : "Reactivate"}
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
