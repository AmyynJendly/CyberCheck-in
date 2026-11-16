"use client";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// --- connection state (drives the red "connection lost" banner) -----------
type Listener = (online: boolean) => void;
let online = typeof navigator === "undefined" ? true : navigator.onLine;
const listeners = new Set<Listener>();
export function setOnline(v: boolean) {
  if (v === online) return;
  online = v;
  listeners.forEach((l) => l(v));
}
export function isOnline() {
  return online;
}
export function subscribeOnline(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
if (typeof window !== "undefined") {
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
}

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  try {
    return await apiOnce<T>(path, opts);
  } catch (err) {
    // A GET changes nothing, so retry once after a network blip (mobile data at the door).
    if (method === "GET" && err instanceof ApiError && err.code === "NETWORK") {
      await new Promise((r) => setTimeout(r, 600));
      return apiOnce<T>(path, opts);
    }
    throw err;
  }
}

async function apiOnce<T>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: ctrl.signal,
    });
  } catch {
    setOnline(false);
    throw new ApiError(0, "NETWORK", "No connection. Check Wi-Fi / mobile data.");
  } finally {
    clearTimeout(timer);
  }
  setOnline(true);
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  }
  if (!res.ok) {
    throw new ApiError(res.status, String(data.error ?? "ERROR"), String(data.message ?? `Request failed (${res.status})`), data);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
