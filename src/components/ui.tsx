"use client";

import Link from "next/link";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { isOnline, subscribeOnline } from "./api";
import { useApp } from "./AppContext";

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-teal-500 text-slate-950 hover:bg-teal-400 active:bg-teal-600",
  secondary: "bg-slate-800 text-slate-100 hover:bg-slate-700 active:bg-slate-900 border border-slate-700",
  danger: "bg-red-600 text-white hover:bg-red-500 active:bg-red-700",
  ghost: "bg-transparent text-slate-300 hover:bg-slate-800",
};

export function btn(variant: Variant = "primary", big = false): string {
  return `${VARIANTS[variant]} ${big ? "px-5 py-4 text-lg" : "px-3.5 py-2 text-sm"} inline-block rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-50`;
}

export function Button({
  variant = "primary",
  big,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; big?: boolean }) {
  return (
    <button
      {...props}
      className={`${btn(variant, big)} ${className}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-800 bg-slate-900/70 p-4 ${className}`}>{children}</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-3 text-base text-slate-100 placeholder:text-slate-600 focus:border-teal-400 focus:outline-none";

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "warn" | "error"; children: ReactNode }) {
  const tones = {
    info: "border-slate-700 bg-slate-800/60 text-slate-200",
    ok: "border-emerald-700 bg-emerald-900/40 text-emerald-200",
    warn: "border-amber-700 bg-amber-900/40 text-amber-200",
    error: "border-red-700 bg-red-900/40 text-red-200",
  };
  return <div className={`rounded-xl border px-3.5 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(isOnline());
    return subscribeOnline(setOnline);
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="alert" className="sticky top-0 z-50 bg-red-600 px-4 py-2 text-center text-sm font-bold text-white">
      Connection lost — scans are NOT being saved
    </div>
  );
}

export function Page({ title, children, back = true }: { title: string; children: ReactNode; back?: boolean }) {
  const { event, activeDay, ready } = useApp();
  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-16">
      <OfflineBanner />
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-slate-800 bg-slate-950/90 px-4 py-3 backdrop-blur">
        {back && (
          <Link href="/" className="rounded-lg px-2 py-1 text-xl text-slate-300 hover:bg-slate-800" aria-label="Back">
            ←
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold">{title}</h1>
          {ready && event && (
            <p className="truncate text-xs text-slate-400">
              {event.name} · {activeDay ? (activeDay.label || activeDay.day_date) : "No event day today"}
            </p>
          )}
        </div>
      </header>
      <main className="space-y-4 px-4 py-4">{children}</main>
    </div>
  );
}

/** Shown when a page needs a selected event. */
export function NeedEvent() {
  return (
    <Notice tone="warn">
      No event selected. <Link href="/" className="font-semibold underline">Pick an event</Link> first.
    </Notice>
  );
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tunis", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Tunis",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}
