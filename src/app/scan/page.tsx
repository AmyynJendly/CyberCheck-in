"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Banknote, ChevronLeft, CircleAlert, CircleCheck, CircleX, Flashlight, FlashlightOff, Keyboard, UserPlus } from "lucide-react";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, ApiError } from "@/components/api";
import { useStats } from "@/components/useStats";
import { DayPicker } from "@/components/DayPicker";
import { NeedEvent, Notice, OfflineBanner, Spinner, btn, fmtTime } from "@/components/ui";
import { parseScannedText } from "@/lib/qr-format";
import { PaymentChoices } from "@/components/Payment";
import { accessLabel, fmtDT, type DoorChoice, type PaymentKind, type PaymentOption } from "@/components/types";
import { haptic } from "@/components/haptics";
import { startQrScanner, type QrScanner } from "@/components/qrScanner";

type Result =
  | {
      status: "OK";
      name: string;
      team_name: string | null;
      class_year: string | null;
      day_label: string;
      is_member?: boolean;
      payment?: { kind: PaymentKind; amount: number } | null;
      claimed?: boolean;
    }
  | {
      status: "PAYMENT_REQUIRED";
      attendee_id: string;
      name: string;
      team_name: string | null;
      class_year: string | null;
      day_label: string;
      options: PaymentOption[];
    }
  | { status: "ALREADY_CHECKED_IN"; name: string; checked_at: string; by_staff_name: string }
  | { status: "WRONG_EVENT"; name: string; other_event_name: string }
  | { status: "FULL"; name: string; day_label: string; capacity: number; checked_in: number }
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

function summarize(r: Result): Omit<RecentScan, "id" | "at"> {
  switch (r.status) {
    case "OK":
      return { tone: "ok", title: r.name, detail: r.payment ? `Paid ${fmtDT(r.payment.amount)}` : r.claimed ? "Member (to check)" : r.is_member ? "Member" : "Checked in" };
    case "PAYMENT_REQUIRED":
      return { tone: "bad", title: r.name, detail: "Not paid" };
    case "ALREADY_CHECKED_IN":
      return { tone: "warn", title: r.name, detail: `Already in · ${fmtTime(r.checked_at)}` };
    case "WRONG_EVENT":
      return { tone: "bad", title: r.name, detail: "Wrong event" };
    case "FULL":
      return { tone: "bad", title: r.name, detail: "Session full" };
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
  const [paying, setPaying] = useState(false);
  const dayParam = useDayParam();
  const { stats, reload } = useStats(event?.id, dayParam.event_day_id, 10_000);
  const [result, setResult] = useState<Result | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);
  const [localCount, setLocalCount] = useState(0);
  const [recent, setRecent] = useState<RecentScan[]>([]);
  const [checking, setChecking] = useState(false); // code read, waiting for the server
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);

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
    setChecking(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (r.status === "PAYMENT_REQUIRED") {
      // Stays up (scanning paused) until HR records the payment or taps "Didn't pay".
      haptic("bad");
      return;
    }
    setRecent((cur) => [{ id: ++seq.current, at: Date.now(), ...summarize(r) }, ...cur].slice(0, 3));
    haptic(r.status === "OK" ? "ok" : r.status === "ALREADY_CHECKED_IN" ? "warn" : "bad");
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
      // Instant feedback: the code is read; the result follows from the server.
      haptic("tick");
      setChecking(true);
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
  const pay = useCallback(
    async (attendeeId: string, kind: DoorChoice) => {
      const { eventId, dayParam } = ctx.current;
      setPaying(true);
      try {
        const r = await api<Result>("/api/checkin/pay", { body: { event_id: eventId, attendee_id: attendeeId, kind, method: "qr", ...dayParam }, timeoutMs: 15_000 });
        show(r);
        if (r.status === "OK") {
          setLocalCount((n) => n + 1);
          void reload();
        }
      } catch (e) {
        show({ status: "ERROR", message: e instanceof ApiError && e.code === "NETWORK" ? "No connection. Nothing was saved; try again." : e instanceof Error ? e.message : "Error" });
      } finally {
        setPaying(false);
      }
    },
    [show, reload],
  );

  const notPaid = useCallback((r: Extract<Result, { status: "PAYMENT_REQUIRED" }>) => {
    setRecent((cur) => [{ id: ++seq.current, at: Date.now(), ...summarize(r) }, ...cur].slice(0, 3));
    setResult(null);
    last.current = { text: "", at: 0 }; // they may come back after getting cash
    busy.current = false;
  }, []);

  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  // Camera lifecycle.
  const canScan = ready && !!event && !!activeDay;
  useEffect(() => {
    if (!canScan) return;
    let cancelled = false;
    let scanner: QrScanner | null = null;
    setCameraError(null);
    setCameraOn(false);
    setTorch({ supported: false, on: false });
    // The camera can be cut off (phone locked, app in background): restart it.
    const restart = () => setCameraKey((k) => k + 1);

    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCameraError("The camera only works over HTTPS. Open the app with its https:// address.");
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      try {
        scanner = await startQrScanner(video, (text) => void onScanRef.current(text), restart);
        if (cancelled) return scanner.stop();
        scannerRef.current = scanner;
        setTorch({ supported: scanner.torchSupported, on: false });
        setCameraOn(true);
      } catch (err) {
        if (!cancelled) {
          const e = err as Error;
          const msg = String(e?.message ?? err);
          setCameraError(
            e?.name === "NotAllowedError" || /permission|notallowed/i.test(msg)
              ? "Camera access is off. Allow the camera for this site in your browser settings, then try again."
              : `The camera didn't start: ${msg}`,
          );
        }
      }
    })();

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const v = videoRef.current;
      const stream = v?.srcObject as MediaStream | null;
      if (stream && stream.getVideoTracks().some((t) => t.readyState === "ended")) restart();
      else void v?.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      scanner?.stop();
      if (scannerRef.current === scanner) scannerRef.current = null;
    };
  }, [canScan, cameraKey]);

  // No decoding while a result is on screen.
  useEffect(() => scannerRef.current?.setPaused(!!result), [result, cameraOn]);

  const toggleTorch = async () => {
    const on = !torch.on;
    if (await scannerRef.current?.setTorch(on)) setTorch((t) => ({ ...t, on }));
  };

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  if (!ready) return <Spinner />;

  const checkedIn = stats?.today ? stats.today.checked_in + localCount : null;
  const seatCap = stats?.today?.capacity ?? activeDay?.capacity ?? null;
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
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay aria-label="Camera" />
        {!cameraOn && !cameraError && (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner label="Starting camera" />
          </div>
        )}
        {/* Viewfinder: the centre is scanned first, but the whole frame is scanned too. Green = code read. */}
        <div
          className={`pointer-events-none absolute left-1/2 top-1/2 h-[70cqmin] w-[70cqmin] -translate-x-1/2 -translate-y-1/2 transition-transform duration-150 ${checking ? "scale-95" : ""}`}
          aria-hidden
        >
          {["left-0 top-0 border-l-[3px] border-t-[3px] rounded-tl-[22px]", "right-0 top-0 border-r-[3px] border-t-[3px] rounded-tr-[22px]", "left-0 bottom-0 border-l-[3px] border-b-[3px] rounded-bl-[22px]", "right-0 bottom-0 border-r-[3px] border-b-[3px] rounded-br-[22px]"].map((c) => (
            <span key={c} className={`absolute h-11 w-11 ${checking ? "border-sys-green" : "border-white/90"} ${c}`} />
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
          {torch.supported && (
            <button
              type="button"
              onClick={() => void toggleTorch()}
              aria-label={torch.on ? "Turn the flashlight off" : "Turn the flashlight on"}
              aria-pressed={torch.on}
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-full backdrop-blur-xl ${torch.on ? "bg-white text-black" : "bg-black/55 text-white active:bg-black/70"}`}
            >
              {torch.on ? <Flashlight className="h-5 w-5" strokeWidth={2.2} /> : <FlashlightOff className="h-5 w-5" strokeWidth={2.2} />}
            </button>
          )}
          <div className="flex min-w-0 flex-1 justify-center">
            <div className="rounded-[18px] bg-black/55 px-4 py-1.5 text-center backdrop-blur-xl">
              <p className="font-rounded text-[26px] font-bold leading-none tabular text-white">
                {checkedIn ?? "–"}
                <span className="text-white/50"> / {seatCap ?? stats?.registered ?? "–"}</span>
              </p>
              <p className="t-caption mt-0.5 text-white/70">
                {seatCap !== null && checkedIn !== null ? (checkedIn >= seatCap ? "Full" : `${seatCap - checkedIn} seats left`) : "Checked in today"}
              </p>
            </div>
          </div>
          <span
            className="t-caption max-w-[30%] shrink-0 truncate rounded-full bg-black/55 px-3 py-1.5 font-semibold text-white backdrop-blur-xl"
            title={event ? accessLabel(activeDay, event.membership_fee) : undefined}
          >
            {activeDay.label || activeDay.day_date}
            {activeDay.access !== "free" && <span className="block font-normal text-white/70">{activeDay.access === "members" ? "Members" : "Paid entry"}</span>}
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
          <p className="t-subhead mx-auto w-fit rounded-full bg-black/55 px-4 py-1.5 text-center text-white/85 backdrop-blur-xl">Hold the QR code 20–30 cm from the camera</p>
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

      {result?.status === "PAYMENT_REQUIRED" ? (
        <div className="anim-fade fixed inset-0 z-[60] flex flex-col items-center justify-center overflow-y-auto bg-[#0040dd] px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] text-center text-white" role="alertdialog" aria-label="Payment needed">
          <Banknote className="anim-pop h-[84px] w-[84px]" strokeWidth={1.6} aria-hidden />
          <span className="t-title1 mt-4">Payment Needed</span>
          <span className="mt-2 font-display text-[30px] font-bold leading-tight tracking-tight">{result.name}</span>
          <span className="t-body mt-1 text-white/85">Not a club member · {result.day_label}</span>
          <div className="mt-7 w-full max-w-sm">
            <PaymentChoices onDark options={result.options} busy={paying} onPay={(kind) => pay(result.attendee_id, kind)} onCancel={() => notPaid(result)} />
          </div>
          <p className="t-footnote mt-4 max-w-sm text-white/70">Take the cash first, then tap what they paid. It&apos;s saved under your name.</p>
        </div>
      ) : (
        result && <ResultOverlay result={result} onClose={dismiss} />
      )}
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
      lines = [
        [result.team_name, result.class_year].filter(Boolean).join(" · "),
        result.payment
          ? `Paid ${fmtDT(result.payment.amount)} · ${result.payment.kind === "membership" ? "now a member" : "entry only"}`
          : result.claimed
            ? "Member · an admin will check the list"
            : result.is_member
            ? `Member · ${result.day_label}`
            : result.day_label,
      ];
      break;
    case "ALREADY_CHECKED_IN":
      bg = "bg-warn-deep";
      Icon = CircleAlert;
      title = "Already Checked In";
      name = result.name;
      lines = [`at ${fmtTime(result.checked_at)} by ${result.by_staff_name}`];
      break;
    case "FULL":
      title = "Session Full";
      name = result.name;
      lines = [`${result.checked_in} / ${result.capacity} seats taken`, "Not checked in. Nothing charged."];
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
    case "PAYMENT_REQUIRED":
      return null;
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
