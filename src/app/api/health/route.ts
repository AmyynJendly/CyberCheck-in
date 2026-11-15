// GET /api/health — public, tells nothing sensitive.
// Also called once a day by the Vercel cron job in vercel.json, so the
// database sees regular activity and the Supabase free tier does not pause
// the project between events.
import { query } from "@/lib/db";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const started = Date.now();
  try {
    // A real read on an app table (not just `select 1`) so it counts as usage.
    await query("select count(*) from events");
    return json({ ok: true, db: "up", ms: Date.now() - started, at: new Date().toISOString() });
  } catch (err) {
    console.error("[health] database check failed:", err);
    return json({ ok: false, db: "down", at: new Date().toISOString() }, 503);
  }
}
