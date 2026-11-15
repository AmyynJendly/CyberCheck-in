import { json, route } from "@/lib/http";
import { getStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  const staff = await getStaff(req);
  if (!staff) return json({ error: "UNAUTHENTICATED" }, 401);
  return json({ staff });
});
