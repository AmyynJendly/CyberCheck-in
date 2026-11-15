import { json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { addDay } from "@/lib/admin";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { day_date: "YYYY-MM-DD", label? }
export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const admin = await requireStaff(req, "admin");
  const id = requireUuid((await ctx.params).id, "event id");
  return json(await addDay(admin, id, await readJson(req)), 201);
});
