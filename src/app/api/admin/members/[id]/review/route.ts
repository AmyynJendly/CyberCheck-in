// POST /api/admin/members/:id/review  { decision: "confirm" | "reject" }
import { HttpError, json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { reviewMember } from "@/lib/members";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const body = await readJson(req);
  if (body.decision !== "confirm" && body.decision !== "reject") throw new HttpError(400, "BAD_REQUEST", "decision must be confirm or reject.");
  return json(await reviewMember(admin, requireUuid((await ctx.params).id, "member id"), body.decision));
});
