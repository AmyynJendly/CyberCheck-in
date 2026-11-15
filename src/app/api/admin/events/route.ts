import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { createEvent, listAdminEvents } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  await requireStaff(req, "admin");
  return json({ events: await listAdminEvents() });
});

export const POST = route(async (req) => {
  const admin = await requireStaff(req, "admin");
  return json(await createEvent(admin, await readJson(req)), 201);
});
