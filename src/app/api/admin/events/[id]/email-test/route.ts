// POST /api/admin/events/:id/email-test  { to, subject?, body? } — send one sample email.
import { HttpError, json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { sendTestEmail } from "@/lib/email-admin";
import { looksLikeEmail, normalizeEmail, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  await requireStaff(req, "admin");
  const body = await readJson(req);
  const to = normalizeEmail(body.to);
  if (!to || !looksLikeEmail(to)) throw new HttpError(400, "BAD_EMAIL", "Enter the address to send the test to.");
  try {
    await sendTestEmail(requireUuid((await ctx.params).id, "event id"), to, body.subject, body.body);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "SEND_FAILED", `The test email didn't send: ${err instanceof Error ? err.message : String(err)}`);
  }
  return json({ ok: true, to });
});
