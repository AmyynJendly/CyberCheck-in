"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { api, ApiError } from "@/components/api";

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

// PIN only: the PIN says who is signing in.
function LoginInner() {
  const params = useSearchParams();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  const submit = useCallback(
    async (fullPin: string) => {
      setBusy(true);
      setError(null);
      try {
        await api("/api/auth/login", { body: { pin: fullPin } });
        window.location.href = safeNext(params.get("next"));
      } catch (e) {
        setPin("");
        setShake((n) => n + 1);
        setError(e instanceof ApiError ? e.message : "Couldn't sign in. Try again.");
        setBusy(false);
      }
    },
    [params],
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
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") del();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(3.5rem,env(safe-area-inset-top))]">
      <span className="grid h-[64px] w-[64px] place-items-center rounded-[16px] bg-gradient-to-b from-bg3 to-bg2 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12)]">
        <ShieldCheck className="h-8 w-8 text-accent" strokeWidth={1.8} aria-hidden />
      </span>
      <h1 className="t-title3 mt-4">Cybertrace Check-in</h1>
      <p className="t-subhead mt-1 text-label2">Enter your PIN</p>

      <div key={shake} className={`mt-7 flex gap-[18px] ${shake ? "shake" : ""}`} aria-label={`${pin.length} of 6 digits entered`} role="status">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className={`h-[13px] w-[13px] rounded-full border-[1.5px] transition-colors duration-100 ${i < pin.length ? "border-label bg-label" : "border-label"}`}
          />
        ))}
      </div>
      <p className="t-footnote mt-4 min-h-[18px] text-center text-sys-red" aria-live="polite">
        {error}
      </p>

      <div className="mt-auto grid w-full max-w-[290px] grid-cols-3 gap-x-6 gap-y-4 pt-6">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Key key={d} onClick={() => press(d)} disabled={busy}>
            {d}
          </Key>
        ))}
        <span aria-hidden />
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
