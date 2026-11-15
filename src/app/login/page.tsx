"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { Initials, Notice, Row, SearchField, Section, Spinner } from "@/components/ui";

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
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load the staff list."));
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
          setError(typeof left === "number" ? `Wrong PIN. ${left} attempt${left === 1 ? "" : "s"} left.` : e.message);
        } else setError("Couldn't sign in. Try again.");
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
  const del = () => !busy && setPin((p) => p.slice(0, -1));

  // Physical keyboard support (laptops at the desk).
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") del();
      else if (e.key === "Escape") setPicked(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!picked) {
    const list = (staff ?? []).filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));
    return (
      <div className="mx-auto min-h-dvh max-w-lg px-4 pb-10 pt-[max(3rem,env(safe-area-inset-top))]">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 grid h-[72px] w-[72px] place-items-center rounded-[18px] bg-gradient-to-b from-bg3 to-bg2 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12)]">
            <ShieldCheck className="h-9 w-9 text-accent" strokeWidth={1.8} aria-hidden />
          </span>
          <h1 className="t-title1">Cybertrace Check-in</h1>
          <p className="t-body mt-1 text-label2">Choose your name to sign in.</p>
        </div>

        <div className="space-y-4">
          {error && <Notice tone="error">{error}</Notice>}
          {staff && staff.length > 8 && <SearchField value={filter} onChange={setFilter} placeholder="Search" />}
          {staff === null && !error && <Spinner />}
          {staff?.length === 0 && (
            <Notice tone="warn">
              No staff yet. Run <code className="font-mono">npm run seed:admin</code> to create the first admin.
            </Notice>
          )}
          {list.length > 0 && (
            <Section inset={68}>
              {list.map((s) => (
                <Row
                  key={s.id}
                  icon={<Initials name={s.name} size={40} />}
                  title={s.name}
                  chevron
                  onClick={() => {
                    setPicked(s);
                    setPin("");
                    setError(null);
                  }}
                />
              ))}
            </Section>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(3.5rem,env(safe-area-inset-top))]">
      <Initials name={picked.name} size={64} />
      <h1 className="t-title3 mt-4">Enter PIN</h1>
      <p className="t-subhead mt-1 text-label2">{picked.name}</p>

      <div key={shake} className={`mt-7 flex gap-[18px] ${shake ? "shake" : ""}`} aria-label={`${pin.length} of 6 digits entered`} role="status">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className={`h-[13px] w-[13px] rounded-full border-[1.5px] transition-colors duration-100 ${i < pin.length ? "border-label bg-label" : "border-label"}`}
          />
        ))}
      </div>
      <p className="t-footnote mt-4 min-h-[18px] text-center text-sys-red" aria-live="polite">
        {error ?? (busy ? "" : "")}
      </p>

      <div className="mt-auto grid w-full max-w-[290px] grid-cols-3 gap-x-6 gap-y-4 pt-6">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Key key={d} onClick={() => press(d)} disabled={busy}>
            {d}
          </Key>
        ))}
        <button type="button" onClick={() => setPicked(null)} className="t-body h-[78px] text-label active:opacity-50">
          Cancel
        </button>
        <Key onClick={() => press("0")} disabled={busy}>
          0
        </Key>
        <button type="button" onClick={del} disabled={busy || pin.length === 0} className="t-body h-[78px] text-label active:opacity-50 disabled:opacity-0">
          Delete
        </button>
      </div>
    </div>
  );
}

function Key({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mx-auto grid h-[78px] w-[78px] place-items-center rounded-full bg-fill font-display text-[36px] font-normal leading-none text-label transition-colors duration-75 active:bg-label3 disabled:opacity-50"
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
