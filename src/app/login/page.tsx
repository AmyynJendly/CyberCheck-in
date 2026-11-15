"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/components/api";
import { Notice, inputClass } from "@/components/ui";

interface StaffItem {
  id: string;
  name: string;
}

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function LoginInner() {
  const params = useSearchParams();
  const [staff, setStaff] = useState<StaffItem[] | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<StaffItem | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  useEffect(() => {
    api<{ staff: StaffItem[] }>("/api/staff/list")
      .then((r) => setStaff(r.staff))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load staff list."));
  }, []);

  const submit = useCallback(
    async (fullPin: string) => {
      if (!picked) return;
      setBusy(true);
      setError(null);
      try {
        await api("/api/auth/login", { body: { staff_id: picked.id, pin: fullPin } });
        window.location.href = safeNext(params.get("next"));
      } catch (e) {
        setPin("");
        setShake((n) => n + 1);
        if (e instanceof ApiError) {
          const left = e.data.attempts_left;
          setError(typeof left === "number" ? `${e.message} ${left} attempt${left === 1 ? "" : "s"} left.` : e.message);
        } else setError("Login failed.");
        setBusy(false);
      }
    },
    [picked, params],
  );

  const press = (d: string) => {
    if (busy || pin.length >= 6) return;
    setError(null);
    const next = pin + d;
    setPin(next);
    if (next.length === 6) void submit(next);
  };

  // Physical keyboard support (laptops at the desk).
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Escape") setPicked(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!picked) {
    const list = (staff ?? []).filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-8">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-teal-400">Cybertrace</p>
        <h1 className="mb-6 text-3xl font-bold">Who are you?</h1>
        {error && <Notice tone="error">{error}</Notice>}
        {staff && staff.length > 8 && (
          <input className={`${inputClass} mb-3`} placeholder="Search your name" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        {staff === null && !error && <p className="text-slate-400">Loading…</p>}
        {staff?.length === 0 && <Notice tone="warn">No staff yet. Run <code>npm run seed:admin</code> to create the first admin.</Notice>}
        <div className="grid gap-2">
          {list.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setPicked(s);
                setPin("");
                setError(null);
              }}
              className="rounded-2xl border border-slate-800 bg-slate-900 px-5 py-4 text-left text-lg font-semibold hover:border-teal-500 active:bg-slate-800"
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center px-4 py-8">
      <button onClick={() => setPicked(null)} className="self-start text-sm text-slate-400 hover:text-slate-200">
        ← Not {picked.name}?
      </button>
      <h1 className="mt-6 text-2xl font-bold">Hi {picked.name}</h1>
      <p className="mb-6 text-slate-400">Enter your 6-digit PIN</p>
      <div key={shake} className={`mb-4 flex gap-3 ${shake ? "shake" : ""}`} aria-label={`${pin.length} of 6 digits entered`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`h-4 w-4 rounded-full border-2 ${i < pin.length ? "border-teal-400 bg-teal-400" : "border-slate-600"}`} />
        ))}
      </div>
      <div className="mb-4 min-h-12 w-full">{error && <Notice tone="error">{error}</Notice>}</div>
      <div className="grid w-full grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <PinKey key={d} onClick={() => press(d)} disabled={busy}>
            {d}
          </PinKey>
        ))}
        <PinKey onClick={() => setPin("")} disabled={busy} subtle>
          Clear
        </PinKey>
        <PinKey onClick={() => press("0")} disabled={busy}>
          0
        </PinKey>
        <PinKey onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy} subtle>
          ⌫
        </PinKey>
      </div>
      {busy && <p className="mt-4 text-slate-400">Checking…</p>}
    </div>
  );
}

function PinKey({ children, onClick, disabled, subtle }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; subtle?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-16 rounded-2xl text-2xl font-semibold transition active:scale-95 disabled:opacity-50 ${
        subtle ? "bg-transparent text-base text-slate-400" : "bg-slate-800 hover:bg-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
