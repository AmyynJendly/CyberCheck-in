import { json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { createStaff, listStaff } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  await requireStaff(req, "admin");
  return json({ staff: await listStaff() });
});

// POST { name, pin, role? }
export const POST = route(async (req) => {
  const admin = await requireStaff(req, "admin");
  return json(await createStaff(admin, await readJson(req)), 201);
});
