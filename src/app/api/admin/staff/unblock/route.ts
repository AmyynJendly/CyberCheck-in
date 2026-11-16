import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { clearLoginBlocks } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST — clear every "too many wrong PINs" block, so people can sign in again now.
export const POST = route(async (req) => {
  const admin = await requireStaff(req, "admin");
  return json(await clearLoginBlocks(admin));
});
