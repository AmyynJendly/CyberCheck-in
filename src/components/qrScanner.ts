// Camera + QR decoding for the Scan page.
//
// Decoder: zxing-cpp compiled to WebAssembly (zxing-wasm), served from
// /zxing/zxing_reader.wasm. Same fast, damage-tolerant decoder on iPhone and
// Android (the old html5-qrcode fell back to a slow JS decoder on iPhone).
//
// Each camera frame, one decode runs on one of these, in turn:
//   1. the centre of the frame (where the viewfinder is), at up to 720 px
//   2. the same, with denoising (cracked or dirty screens)
//   3. the whole frame, at up to 960 px (a ticket held off-centre)
// zxing also tries inverted colours, rotation and downscaling, and its local
// threshold copes with dim or low-contrast screens.
import type { ReaderOptions } from "zxing-wasm/reader";

const WASM_URL = "/zxing/zxing_reader.wasm";

export interface QrScanner {
  stop(): void;
  /** Skip decoding (e.g. while a result is on screen). */
  setPaused(paused: boolean): void;
  torchSupported: boolean;
  setTorch(on: boolean): Promise<boolean>;
}

type Caps = MediaTrackCapabilities & { focusMode?: string[]; exposureMode?: string[]; whiteBalanceMode?: string[]; torch?: boolean };

const OPTIONS: ReaderOptions = {
  formats: ["QRCode"],
  tryHarder: true,
  tryInvert: true,
  tryRotate: true,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
};
const DENOISE: ReaderOptions = { ...OPTIONS, tryDenoise: true };

export async function startQrScanner(
  video: HTMLVideoElement,
  onText: (text: string) => void,
  onCameraLost: () => void,
): Promise<QrScanner> {
  const zxing = await import("zxing-wasm/reader");
  const ready = zxing.prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? WASM_URL : prefix + path) },
    fireImmediately: true,
  });

  // Full HD when the phone offers it: small or distant codes still have enough pixels.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  const track = stream.getVideoTracks()[0];
  const stopStream = () => stream.getTracks().forEach((t) => t.stop());
  try {
    await ready;
  } catch {
    stopStream();
    throw new Error("The scanner didn't load. Check the connection and try again.");
  }

  const caps: Caps = (track.getCapabilities?.() as Caps | undefined) ?? {};
  const advanced: Record<string, string>[] = [];
  if (caps.focusMode?.includes("continuous")) advanced.push({ focusMode: "continuous" });
  if (caps.exposureMode?.includes("continuous")) advanced.push({ exposureMode: "continuous" });
  if (caps.whiteBalanceMode?.includes("continuous")) advanced.push({ whiteBalanceMode: "continuous" });
  if (advanced.length) await track.applyConstraints({ advanced } as MediaTrackConstraints).catch(() => {});

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  let stopped = false;
  let paused = false;
  let pass = 0;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const onEnded = () => {
    if (!stopped) onCameraLost();
  };
  track.addEventListener("ended", onEnded);

  const schedule = () => {
    if (stopped) return;
    if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(() => void tick());
    else requestAnimationFrame(() => void tick());
  };

  const tick = async () => {
    if (stopped) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!paused && vw && vh && video.readyState >= 2) {
      const kind = pass++ % 3;
      let sx = 0, sy = 0, sw = vw, sh = vh, max = 960;
      if (kind < 2) {
        const side = Math.round(Math.min(vw, vh) * 0.8);
        sx = Math.round((vw - side) / 2);
        sy = Math.round((vh - side) / 2);
        sw = sh = side;
        max = 720;
      }
      const scale = Math.min(1, max / Math.max(sw, sh));
      const w = Math.round(sw * scale);
      const h = Math.round(sh * scale);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      try {
        const results = await zxing.readBarcodes(ctx.getImageData(0, 0, w, h), kind === 1 ? DENOISE : OPTIONS);
        const hit = results.find((r) => r.isValid && r.text);
        if (hit && !stopped && !paused) onText(hit.text);
      } catch {
        /* a bad frame: try the next one */
      }
    }
    schedule();
  };
  schedule();

  return {
    stop() {
      stopped = true;
      track.removeEventListener("ended", onEnded);
      stopStream();
      video.srcObject = null;
    },
    setPaused(p) {
      paused = p;
    },
    torchSupported: !!caps.torch,
    setTorch: (on) =>
      track
        .applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
        .then(() => true)
        .catch(() => false),
  };
}
