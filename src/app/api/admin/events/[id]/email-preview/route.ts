// POST /api/admin/events/:id/email-preview  { subject?, body?, tagline?, design? } — render with sample data (unsaved text allowed).
import { json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { previewEmail } from "@/lib/email-admin";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  await requireStaff(req, "admin");
  const body = await readJson(req);
  return json(await previewEmail(requireUuid((await ctx.params).id, "event id"), { subject: body.subject, body: body.body, tagline: body.tagline, design: body.design }));
});
