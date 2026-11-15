"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, ApiError } from "@/components/api";
import { useStats } from "@/components/useStats";
import { DayPicker } from "@/components/DayPicker";
import { NeedEvent, Notice, OfflineBanner, btn, fmtTime } from "@/components/ui";
import { parseScannedText } from "@/lib/qr-format";

type Result =
  | { status: "OK"; name: string; team_name: string | null; class_year: string | null; day_label: string }
  | { status: "ALREADY_CHECKED_IN"; name: string; checked_at: string; by_staff_name: string }
  | { status: "WRONG_EVENT"; name: string; other_event_name: string }
  | { status: "INVALID" }
  | { status: "NO_EVENT_DAY" }
  | { status: "ERROR"; message: string };

const RESULT_MS = 1500;
const DEBOUNCE_MS = 3000;

function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* iOS has no vibration API */
  }
}

export default function ScanPage() {
  const { ready, event, activeDay, me } = useApp();
  const dayParam = useDayParam();
  const { stats, reload } = useStats(event?.id, dayParam.event_day_id, 10_000);
  const [result, setResult] = useState<Result | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraKey, setCameraKey] = useState(0);
  const [localCount, setLocalCount] = useState(0);

  // Refs so the scanner callback (registered once) always sees fresh values.
  const busy = useRef(false);
  const last = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const ctx = useRef({ eventId: event?.id, dayParam });
  ctx.current = { eventId: event?.id, dayParam };
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setLocalCount(0), [stats]);

  const show = useCallback((r: Result) => {
    setResult(r);
    if (r.status === "OK") vibrate(120);
    else if (r.status === "ALREADY_CHECKED_IN") vibrate([80, 60, 80]);
    else vibrate([300]);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setResult(null);
      busy.current = false;
    }, RESULT_MS);
  }, []);

  const onScan = useCallback(
    async (text: string) => {
      const now = Date.now();
      if (busy.current) return;
      if (text === last.current.text && now - last.current.at < DEBOUNCE_MS) return;
      last.current = { text, at: now };
      busy.current = true;

      const token = parseScannedText(text);
      if (!token) return show({ status: "INVALID" }); // no server call
      const { eventId, dayParam } = ctx.current;
      if (!eventId) return show({ status: "ERROR", message: "No event selected" });
      try {
        const r = await api<Result>("/api/checkin", { body: { event_id: eventId, token, ...dayParam }, timeoutMs: 10_000 });
        show(r);
        if (r.status === "OK") {
          setLocalCount((n) => n + 1);
          void reload();
        }
      } catch (e) {
        // Allow an immediate re-scan of the same code after a failure.
        last.current = { text: "", at: 0 };
        show({
          status: "ERROR",
          message: e instanceof ApiError && e.code === "NETWORK" ? "No connection — NOT checked in. Scan again." : e instanceof Error ? e.message : "Error",
        });
      }
    },
    [show, reload],
  );
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  // Camera lifecycle.
  const canScan = ready && !!event && !!activeDay;
  useEffect(() => {
    if (!canScan) return;
    let cancelled = false;
    let scanner: import("html5-qrcode").Html5Qrcode | null = null;
    setCameraError(null);

    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCameraError("The camera needs HTTPS. Open the app via its https:// address.");
        return;
      }
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
      if (cancelled) return;
      scanner = new Html5Qrcode("reader", {
        verbose: false,
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      });
      try {
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 12,
            qrbox: (w, h) => {
              const s = Math.floor(Math.min(w, h) * 0.7);
              return { width: s, height: s };
            },
          },
          (text) => void onScanRef.current(text),
          () => {},
        );
        if (cancelled) await scanner.stop().catch(() => {});
      } catch (err) {
        if (!cancelled) {
          const msg = String((err as Error)?.message ?? err);
          setCameraError(
            /permission|notallowed/i.test(msg)
              ? "Camera permission denied. Allow camera access for this site in your browser settings, then tap Retry."
              : `Could not start the camera: ${msg}`,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      const s = scanner;
      if (s) {
        try {
          if (s.isScanning) void s.stop().then(() => s.clear()).catch(() => {});
        } catch {
          /* already stopped */
        }
      }
    };
  }, [canScan, cameraKey]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  if (!ready) return <p className="p-6 text-slate-400">Loading…</p>;

  const checkedIn = stats?.today ? stats.today.checked_in + localCount : null;

  return (
    <div className="fixed inset-0 flex flex-col bg-black">
      <OfflineBanner />
      <div className="flex items-center gap-3 bg-slate-950/90 px-4 py-3">
        <Link href="/" className="rounded-lg px-2 py-1 text-xl text-slate-300" aria-label="Back">
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold tabular-nums">
            Checked in today: {checkedIn ?? "—"} / {stats?.registered ?? "—"}
          </p>
          <p className="truncate text-xs text-slate-400">
            {event?.name} · {activeDay ? activeDay.label || activeDay.day_date : "no event day"} · {me?.name}
          </p>
        </div>
      </div>

      {!event ? (
        <div className="p-4">
          <NeedEvent />
        </div>
      ) : !activeDay ? (
        <div className="space-y-4 p-4">
          <Notice tone="warn">
            <strong>No event day today.</strong> {me?.role === "admin" ? "Pick a day below to scan anyway." : "Ask an admin to pick a day."}
          </Notice>
          <DayPicker />
        </div>
      ) : (
        <div className="relative flex-1 overflow-hidden">
          <div id="reader" className="absolute inset-0" />
          {cameraError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-950 p-6 text-center">
              <p className="text-slate-200">{cameraError}</p>
              <button className={btn("primary", true)} onClick={() => setCameraKey((k) => k + 1)}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 bg-slate-950/90 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Link href="/search" className={`${btn("secondary", true)} text-center`}>
          🔎 Search / code
        </Link>
        <Link href="/walkin" className={`${btn("secondary", true)} text-center`}>
          ➕ Walk-in
        </Link>
      </div>

      {result && <ResultOverlay result={result} onClose={() => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setResult(null);
        busy.current = false;
      }} />}
    </div>
  );
}

function ResultOverlay({ result, onClose }: { result: Result; onClose: () => void }) {
  let bg = "bg-red-600";
  let title = "";
  let lines: string[] = [];
  switch (result.status) {
    case "OK":
      bg = "bg-emerald-600";
      title = "✓ Welcome";
      lines = [result.name, [result.team_name, result.class_year].filter(Boolean).join(" · "), result.day_label];
      break;
    case "ALREADY_CHECKED_IN":
      bg = "bg-orange-500";
      title = "Already checked in";
      lines = [result.name, `at ${fmtTime(result.checked_at)} by ${result.by_staff_name}`];
      break;
    case "WRONG_EVENT":
      title = "✗ Wrong event";
      lines = [result.name, `Registered for: ${result.other_event_name}`];
      break;
    case "INVALID":
      title = "✗ Invalid QR";
      lines = ["Not a valid ticket for this system.", "Use Search with their 6-letter code."];
      break;
    case "NO_EVENT_DAY":
      title = "No event day today";
      lines = ["Ask an admin to pick a day."];
      break;
    case "ERROR":
      title = "✗ Not saved";
      lines = [result.message];
      break;
  }
  return (
    <button
      type="button"
      onClick={onClose}
      className={`fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 px-6 text-center text-white ${bg}`}
      aria-live="assertive"
    >
      <span className="text-4xl font-black uppercase tracking-wide">{title}</span>
      {lines.filter(Boolean).map((l, i) => (
        <span key={i} className={i === 0 ? "text-3xl font-bold" : "text-xl opacity-90"}>
          {l}
        </span>
      ))}
    </button>
  );
}
