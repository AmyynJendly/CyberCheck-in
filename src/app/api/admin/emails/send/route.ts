// POST /api/admin/emails/send — send the queued emails now (one at a time).
import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { drainEmailQueue } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = route(async (req) => {
  await requireStaff(req, "admin");
  return json(await drainEmailQueue({ budgetMs: 40_000 }));
});
