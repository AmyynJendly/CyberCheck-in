"use client";

import { Banknote, CircleX } from "lucide-react";
import { fmtDT, type PaymentKind, type PaymentOption } from "./types";

const DETAIL: Record<PaymentKind, string> = {
  membership: "Becomes a club member: free for every day this year",
  entry: "Today only, no membership",
};

/**
 * "Payment needed" choices. HR takes the cash first, then taps what was paid.
 * `onDark` renders it for the full-screen scanner overlay.
 */
export function PaymentChoices({
  options,
  onPay,
  onCancel,
  busy,
  onDark,
}: {
  options: PaymentOption[];
  onPay: (kind: PaymentKind) => void;
  onCancel: () => void;
  busy?: boolean;
  onDark?: boolean;
}) {
  const primary = onDark ? "bg-white text-black active:bg-white/80" : "bg-accent text-on-accent active:opacity-80";
  const secondary = onDark ? "bg-white/20 text-white active:bg-white/30" : "bg-fill text-label active:bg-fill2";
  // Entry-only first when offered (the common case on competition day), membership second.
  return (
    <div className="w-full space-y-2.5">
      {options.map((o, i) => (
        <button
          key={o.kind}
          type="button"
          disabled={busy}
          onClick={() => onPay(o.kind)}
          className={`flex w-full items-center gap-3 rounded-[14px] px-4 py-3 text-left transition disabled:opacity-40 ${i === 0 ? primary : secondary}`}
        >
          <Banknote className="h-6 w-6 shrink-0" strokeWidth={2} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block t-headline">
              Paid {fmtDT(o.amount)} · {o.kind === "membership" ? "Join the club" : "Entry only"}
            </span>
            <span className={`block t-footnote ${onDark ? "opacity-75" : "text-label2"}`}>{DETAIL[o.kind]}</span>
          </span>
        </button>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className={`flex h-[50px] w-full items-center justify-center gap-2 rounded-[14px] t-headline disabled:opacity-40 ${onDark ? "text-white/85 active:bg-white/10" : "text-sys-red active:bg-sys-red/10"}`}
      >
        <CircleX className="h-5 w-5" strokeWidth={2.2} aria-hidden />
        Didn&apos;t pay · don&apos;t check in
      </button>
    </div>
  );
}

export function MemberBadge({ small }: { small?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-full bg-accent/15 font-semibold text-accent ${small ? "px-2 py-0.5 t-caption" : "px-2.5 py-1 t-footnote"}`}>
      Member
    </span>
  );
}
