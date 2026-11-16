// Vibration feedback for the scanner.
// Android: the Vibration API. iPhone (no Vibration API): Safari 18+ plays a
// system haptic when a "switch" checkbox is toggled, so we toggle a hidden one,
// once per pulse. Older iPhones get no vibration (the screen colour still shows it).

export type Haptic = "tick" | "ok" | "warn" | "bad";

// [on, off, on, …] in ms, as for navigator.vibrate.
const PATTERNS: Record<Haptic, number[]> = {
  tick: [25], // code detected, waiting for the server
  ok: [130],
  warn: [80, 70, 80],
  bad: [60, 50, 60, 50, 60],
};

let iosSwitch: HTMLLabelElement | null = null;

function iosPulse() {
  if (!iosSwitch) {
    const label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = label;
  }
  iosSwitch.click();
}

export function haptic(kind: Haptic) {
  const pattern = PATTERNS[kind];
  try {
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
      return;
    }
    // One switch haptic per "on" segment, spaced like the pattern.
    let at = 0;
    pattern.forEach((ms, i) => {
      if (i % 2 === 0) setTimeout(iosPulse, at);
      at += ms;
    });
  } catch {
    /* no haptics on this device */
  }
}
