import { json, route } from "@/lib/http";
import { clearSessionCookie, getStaff } from "@/lib/auth";
import { auditSafe } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await getStaff(req).catch(() => null);
  if (staff) await auditSafe({ staffId: staff.id, action: "logout" });
  const res = json({ ok: true });
  clearSessionCookie(res);
  return res;
});
