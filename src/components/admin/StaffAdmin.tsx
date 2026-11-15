"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, FieldRow, Initials, MenuSelect, Notice, Row, Section, Sheet, SheetAction, Spinner, TextField } from "../ui";
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

type Msg = { tone: "ok" | "error"; text: string } | null;

export function StaffAdmin() {
  const { me } = useApp();
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [f, setF] = useState({ name: "", pin: "", role: "hr" as "hr" | "admin" });
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<StaffRow | null>(null);
  const [pinFor, setPinFor] = useState<StaffRow | null>(null);
  const [newPin, setNewPin] = useState("");

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

  const patch = (s: StaffRow, body: Record<string, unknown>, ok: string) => {
    setSelected(null);
    return run(() => api(`/api/admin/staff/${s.id}`, { method: "PATCH", body }), ok);
  };

  const describe = (s: StaffRow) =>
    [
      s.role === "admin" ? "Admin" : "HR",
      !s.is_active && "Deactivated",
      s.is_locked && "Locked",
      s.failed_attempts > 0 && `${s.failed_attempts} wrong PIN${s.failed_attempts > 1 ? "s" : ""}`,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="space-y-7">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/admin/staff", { body: f });
            setF({ name: "", pin: "", role: "hr" });
          }, "Added. Give them their PIN in person.");
        }}
      >
        <Section header="Add Staff" footer="PINs are 6 digits. Share them in person, never in a group chat.">
          <FieldRow label="Name" htmlFor="st-name">
            <TextField id="st-name" value={f.name} required placeholder="Full name" onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} />
          </FieldRow>
          <FieldRow label="PIN" htmlFor="st-pin">
            <TextField
              id="st-pin"
              value={f.pin}
              required
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              placeholder="6 digits"
              className="font-mono tracking-[0.3em]"
              onChange={(e) => setF((s) => ({ ...s, pin: e.target.value.replace(/\D/g, "") }))}
            />
          </FieldRow>
          <Row
            title="Role"
            trailing={
              <MenuSelect
                label="Role"
                value={f.role}
                onChange={(v) => setF((s) => ({ ...s, role: v as "hr" | "admin" }))}
                options={[
                  { value: "hr", label: "HR" },
                  { value: "admin", label: "Admin" },
                ]}
              />
            }
          />
        </Section>
        <Button type="submit" size="large" className="w-full" disabled={busy || !f.name.trim() || f.pin.length !== 6}>
          Add Staff Member
        </Button>
      </form>

      {staff === null && <Spinner />}
      {staff && (
        <Section header="Team" inset={68}>
          {staff.map((s) => (
            <Row
              key={s.id}
              icon={
                <span className={s.is_active ? "" : "opacity-40"}>
                  <Initials name={s.name} size={40} />
                </span>
              }
              title={
                <span className={s.is_active ? "" : "text-label2"}>
                  {s.name}
                  {s.id === me?.id && <span className="text-label2"> (you)</span>}
                </span>
              }
              subtitle={<span className={s.is_locked ? "text-sys-orange" : ""}>{describe(s)}</span>}
              chevron
              onClick={() => setSelected(s)}
            />
          ))}
        </Section>
      )}

      <Sheet open={!!selected} onClose={() => setSelected(null)} title={selected?.name} message={selected ? describe(selected) : undefined}>
        {selected && (
          <>
            <SheetAction
              onClick={() => {
                setPinFor(selected);
                setNewPin("");
                setSelected(null);
              }}
            >
              Reset PIN
            </SheetAction>
            {selected.is_locked && <SheetAction onClick={() => patch(selected, { unlock: true }, `${selected.name} unlocked.`)}>Unlock</SheetAction>}
            {selected.id !== me?.id && (
              <>
                <SheetAction onClick={() => patch(selected, { role: selected.role === "admin" ? "hr" : "admin" }, "Role changed.")}>
                  {selected.role === "admin" ? "Make HR" : "Make Admin"}
                </SheetAction>
                <SheetAction
                  destructive={selected.is_active}
                  onClick={() => patch(selected, { is_active: !selected.is_active }, selected.is_active ? `${selected.name} deactivated.` : `${selected.name} reactivated.`)}
                >
                  {selected.is_active ? "Deactivate" : "Reactivate"}
                </SheetAction>
              </>
            )}
          </>
        )}
      </Sheet>

      <Sheet open={!!pinFor} onClose={() => setPinFor(null)} title={`New PIN for ${pinFor?.name}`} message="Their failed attempts and any lock are cleared.">
        <form
          className="border-t border-sep/60 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pinFor || newPin.length !== 6) return;
            const s = pinFor;
            setPinFor(null);
            void run(() => api(`/api/admin/staff/${s.id}`, { method: "PATCH", body: { pin: newPin } }), `PIN reset for ${s.name}.`);
          }}
        >
          <TextField
            aria-label="New 6-digit PIN"
            value={newPin}
            autoFocus
            inputMode="numeric"
            maxLength={6}
            placeholder="6 digits"
            className="rounded-[10px] bg-fill px-3 text-center font-mono tracking-[0.4em]"
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
          />
          <Button type="submit" size="large" className="mt-3 w-full" disabled={newPin.length !== 6}>
            Set PIN
          </Button>
        </form>
      </Sheet>
    </div>
  );
}
