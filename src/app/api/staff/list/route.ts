// GET /api/staff/list — public: names + ids of active staff for the login screen.
import { query } from "@/lib/db";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async () => {
  const r = await query<{ id: string; name: string }>("select id, name from staff where is_active order by lower(name)");
  return json({ staff: r.rows });
});
