// Vibration feedback for the scanner (Android: the Vibration API).
// iPhone browsers can't vibrate here: Safari only plays a haptic in direct
// response to a real finger tap, and a scan comes from the camera. On iPhone
// the full-screen result colour is the feedback.

export type Haptic = "tick" | "ok" | "warn" | "bad";

// [on, off, on, …] in ms, as for navigator.vibrate.
const PATTERNS: Record<Haptic, number[]> = {
  tick: [25], // code detected, waiting for the server
  ok: [130],
  warn: [80, 70, 80],
  bad: [60, 50, 60, 50, 60],
};

export function haptic(kind: Haptic) {
  try {
    navigator.vibrate?.(PATTERNS[kind]);
  } catch {
    /* no vibration on this device */
  }
}
