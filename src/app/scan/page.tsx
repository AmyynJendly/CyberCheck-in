"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, CircleAlert, CircleCheck, CircleX, Keyboard, UserPlus } from "lucide-react";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, ApiError } from "@/components/api";
import { useStats } from "@/components/useStats";
import { DayPicker } from "@/components/DayPicker";
import { NeedEvent, Notice, OfflineBanner, Spinner, btn, fmtTime } from "@/components/ui";
import { parseScannedText } from "@/lib/qr-format";

type Result =
  | { status: "OK"; name: string; team_name: string | null; class_year: string | null; day_label: string }
  | { status: "ALREADY_CHECKED_IN"; name: string; checked_at: string; by_staff_name: string }
  | { status: "WRONG_EVENT"; name: string; other_event_name: string }
  | { status: "INVALID" }
  | { status: "NO_EVENT_DAY" }
  | { status: "ERROR"; message: string };

interface RecentScan {
  id: number;
  tone: "ok" | "warn" | "bad";
  title: string;
  detail: string;
  at: number;
}

const RESULT_MS = 1500;
const DEBOUNCE_MS = 3000;

function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* iOS has no vibration API */
  }
}

function summarize(r: Result): Omit<RecentScan, "id" | "at"> {
  switch (r.status) {
    case "OK":
      return { tone: "ok", title: r.name, detail: "Checked in" };
    case "ALREADY_CHECKED_IN":
      return { tone: "warn", title: r.name, detail: `Already in · ${fmtTime(r.checked_at)}` };
    case "WRONG_EVENT":
      return { tone: "bad", title: r.name, detail: "Wrong event" };
    case "INVALID":
      return { tone: "bad", title: "Unknown code", detail: "Invalid QR" };
    case "NO_EVENT_DAY":
      return { tone: "bad", title: "No event day", detail: "Not saved" };
    case "ERROR":
      return { tone: "bad", title: "Not saved", detail: r.message };
  }
}

export default function ScanPage() {
  const { ready, event, activeDay, me } = useApp();
  const dayParam = useDayParam();
  const { stats, reload } = useStats(event?.id, dayParam.event_day_id, 10_000);
  const [result, setResult] = useState<Result | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);
  const [localCount, setLocalCount] = useState(0);
  const [recent, setRecent] = useState<RecentScan[]>([]);

  // Refs so the scanner callback (registered once) always sees fresh values.
  const busy = useRef(false);
  const last = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const ctx = useRef({ eventId: event?.id, dayParam });
  ctx.current = { eventId: event?.id, dayParam };
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => setLocalCount(0), [stats]);

  const show = useCallback((r: Result) => {
    setResult(r);
    setRecent((cur) => [{ id: ++seq.current, at: Date.now(), ...summarize(r) }, ...cur].slice(0, 3));
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
        last.current = { text: "", at: 0 }; // allow an immediate re-scan after a failure
        show({
          status: "ERROR",
          message: e instanceof ApiError && e.code === "NETWORK" ? "No connection. Scan again." : e instanceof Error ? e.message : "Error",
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
    setCameraOn(false);

    // Scale the video to cover the screen without changing its aspect ratio.
    const fitVideo = () => {
      const video = document.querySelector<HTMLVideoElement>("#reader video");
      const box = document.getElementById("reader");
      if (!video || !box) return;
      if (!video.videoWidth) {
        video.addEventListener("loadedmetadata", fitVideo, { once: true });
        return;
      }
      const scale = Math.max(box.clientWidth / video.videoWidth, box.clientHeight / video.videoHeight);
      video.style.setProperty("width", `${Math.ceil(video.videoWidth * scale)}px`, "important");
      video.style.setProperty("height", `${Math.ceil(video.videoHeight * scale)}px`, "important");
    };
    window.addEventListener("resize", fitVideo);

    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCameraError("The camera only works over HTTPS. Open the app with its https:// address.");
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
          // Decode the whole frame (no qrbox): the video is cropped to fill the
          // screen, and a qrbox would be computed on the stretched element.
          { fps: 12 },
          (text) => void onScanRef.current(text),
          () => {},
        );
        if (cancelled) await scanner.stop().catch(() => {});
        else {
          setCameraOn(true);
          fitVideo();
        }
      } catch (err) {
        if (!cancelled) {
          const msg = String((err as Error)?.message ?? err);
          setCameraError(
            /permission|notallowed/i.test(msg)
              ? "Camera access is off. Allow the camera for this site in your browser settings, then try again."
              : `The camera didn't start: ${msg}`,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("resize", fitVideo);
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

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  if (!ready) return <Spinner />;

  const checkedIn = stats?.today ? stats.today.checked_in + localCount : null;
  const dismiss = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setResult(null);
    busy.current = false;
  };

  // No event / no day: a normal page instead of the camera.
  if (!event || !activeDay) {
    return (
      <div className="mx-auto min-h-dvh max-w-2xl px-4 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <OfflineBanner />
        <Link href="/" className="-ml-2 flex h-11 w-fit items-center text-accent active:opacity-50">
          <ChevronLeft className="h-7 w-7" strokeWidth={2.4} aria-hidden />
          <span className="t-body -ml-0.5">Home</span>
        </Link>
        <h1 className="t-large">Scan</h1>
        <div className="mt-5 space-y-7">
          {!event ? (
            <NeedEvent />
          ) : (
            <>
              <Notice tone="warn">
                <strong>No event day today.</strong> {me?.role === "admin" ? "Pick the day to count check-ins for." : "Ask an admin to pick a day."}
              </Notice>
              <DayPicker />
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <OfflineBanner floating />

      {/* Camera */}
      <div className="absolute inset-0 [container-type:size]">
        <div id="reader" className="absolute inset-0" />
        {!cameraOn && !cameraError && (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner label="Starting camera" />
          </div>
        )}
        {/* Viewfinder: a visual guide only; the whole frame is scanned */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[70cqmin] w-[70cqmin] -translate-x-1/2 -translate-y-1/2" aria-hidden>
          {["left-0 top-0 border-l-[3px] border-t-[3px] rounded-tl-[22px]", "right-0 top-0 border-r-[3px] border-t-[3px] rounded-tr-[22px]", "left-0 bottom-0 border-l-[3px] border-b-[3px] rounded-bl-[22px]", "right-0 bottom-0 border-r-[3px] border-b-[3px] rounded-br-[22px]"].map((c) => (
            <span key={c} className={`absolute h-11 w-11 border-white/90 ${c}`} />
          ))}
        </div>
        {cameraError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black px-8 text-center">
            <p className="t-body text-label2">{cameraError}</p>
            <button type="button" className={btn("filled", "large")} onClick={() => setCameraKey((k) => k + 1)}>
              Try Again
            </button>
          </div>
        )}
      </div>

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/60 to-transparent px-3 pb-8 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3">
          <Link href="/" aria-label="Back to home" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/55 text-white backdrop-blur-xl active:bg-black/70">
            <ChevronLeft className="h-6 w-6" strokeWidth={2.4} />
          </Link>
          <div className="flex min-w-0 flex-1 justify-center">
            <div className="rounded-[18px] bg-black/55 px-4 py-1.5 text-center backdrop-blur-xl">
              <p className="font-rounded text-[26px] font-bold leading-none tabular text-white">
                {checkedIn ?? "–"}
                <span className="text-white/50"> / {stats?.registered ?? "–"}</span>
              </p>
              <p className="t-caption mt-0.5 text-white/70">Checked in today</p>
            </div>
          </div>
          <span className="t-caption max-w-[30%] shrink-0 truncate rounded-full bg-black/55 px-3 py-1.5 font-semibold text-white backdrop-blur-xl">
            {activeDay.label || activeDay.day_date}
          </span>
        </div>
      </div>

      {/* Bottom panel */}
      <div className="absolute inset-x-0 bottom-0 space-y-3 bg-gradient-to-t from-black/85 via-black/60 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-12">
        {recent.length > 0 ? (
          <ul className="overflow-hidden rounded-[14px] bg-black/55 backdrop-blur-xl" aria-label="Last scans">
            {recent.map((r, i) => (
              <li key={r.id} className={`flex items-center gap-3 px-3.5 py-2.5 ${i ? "border-t border-white/10" : ""}`}>
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${r.tone === "ok" ? "bg-sys-green" : r.tone === "warn" ? "bg-sys-orange" : "bg-sys-red"}`} aria-hidden />
                <span className="t-subhead min-w-0 flex-1 truncate font-semibold text-white">{r.title}</span>
                <span className="t-footnote shrink-0 text-white/60">{r.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-subhead mx-auto w-fit rounded-full bg-black/55 px-4 py-1.5 text-center text-white/85 backdrop-blur-xl">Point the camera at a ticket&apos;s QR code</p>
        )}
        <div className="grid grid-cols-2 gap-2.5">
          <Link href="/search" className="flex h-[50px] items-center justify-center gap-2 rounded-[14px] bg-black/55 t-headline text-white backdrop-blur-xl active:bg-black/70">
            <Keyboard className="h-5 w-5" strokeWidth={2.2} aria-hidden />
            Enter Code
          </Link>
          <Link href="/walkin" className="flex h-[50px] items-center justify-center gap-2 rounded-[14px] bg-black/55 t-headline text-white backdrop-blur-xl active:bg-black/70">
            <UserPlus className="h-5 w-5" strokeWidth={2.2} aria-hidden />
            Walk-in
          </Link>
        </div>
      </div>

      {result && <ResultOverlay result={result} onClose={dismiss} />}
    </div>
  );
}

function ResultOverlay({ result, onClose }: { result: Result; onClose: () => void }) {
  let bg = "bg-bad-deep";
  let Icon = CircleX;
  let title = "";
  let name: string | null = null;
  let lines: string[] = [];
  switch (result.status) {
    case "OK":
      bg = "bg-ok-deep";
      Icon = CircleCheck;
      title = "Welcome";
      name = result.name;
      lines = [[result.team_name, result.class_year].filter(Boolean).join(" · "), result.day_label];
      break;
    case "ALREADY_CHECKED_IN":
      bg = "bg-warn-deep";
      Icon = CircleAlert;
      title = "Already Checked In";
      name = result.name;
      lines = [`at ${fmtTime(result.checked_at)} by ${result.by_staff_name}`];
      break;
    case "WRONG_EVENT":
      title = "Wrong Event";
      name = result.name;
      lines = [`Registered for ${result.other_event_name}`];
      break;
    case "INVALID":
      title = "Invalid Code";
      lines = ["This isn't a ticket for this system.", "Use Enter Code with their 6-character code."];
      break;
    case "NO_EVENT_DAY":
      title = "No Event Today";
      lines = ["Ask an admin to pick a day."];
      break;
    case "ERROR":
      title = "Not Saved";
      lines = [result.message];
      break;
  }
  return (
    <button
      type="button"
      onClick={onClose}
      className={`anim-fade fixed inset-0 z-[60] flex flex-col items-center justify-center px-8 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-center text-white ${bg}`}
      aria-live="assertive"
    >
      <Icon className="anim-pop h-[104px] w-[104px]" strokeWidth={1.6} aria-hidden />
      <span className="t-title1 mt-6">{title}</span>
      {name && <span className="mt-2 font-display text-[34px] font-bold leading-tight tracking-tight">{name}</span>}
      {lines.filter(Boolean).map((l, i) => (
        <span key={i} className="t-title3 mt-1.5 font-normal text-white/85">
          {l}
        </span>
      ))}
    </button>
  );
}
