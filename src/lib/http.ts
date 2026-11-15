import { NextRequest, NextResponse } from "next/server";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export function json(data: unknown, init?: number | ResponseInit): NextResponse {
  const res = NextResponse.json(data, typeof init === "number" ? { status: init } : init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/** Wrap a route handler: HttpError → JSON error, anything else → logged 500. */
export function route<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.code, message: err.message, ...err.extra }, err.status);
      }
      console.error(`[api] ${req.method} ${req.nextUrl.pathname} failed:`, err);
      return json({ error: "SERVER_ERROR", message: "Something went wrong. Try again." }, 500);
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON (Content-Type: application/json).");
  }
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as T;
  } catch {
    throw new HttpError(400, "BAD_JSON", "Request body must be a JSON object.");
  }
}

/** Block cross-site state-changing requests (defence in depth on top of SameSite=Lax). */
export function assertSameOrigin(req: NextRequest): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "BAD_ORIGIN", "Cross-site request blocked.");
  }
  if (!host || originHost !== host) throw new HttpError(403, "BAD_ORIGIN", "Cross-site request blocked.");
}

export type RouteCtx<P extends Record<string, string>> = { params: Promise<P> };
