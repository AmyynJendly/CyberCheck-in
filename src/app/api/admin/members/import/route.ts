// POST /api/admin/members/import  { text, valid_until, dry_run? }
// `text` is pasted from Excel / Google Sheets (tab-separated) or a CSV.
import { HttpError, json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { importMembers, parseMemberList } from "@/lib/members";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = route(async (req) => {
  const admin = await requireStaff(req, "admin");
  const body = await readJson(req);
  if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "BAD_REQUEST", "Paste the member list first.");
  if (body.text.length > 1_000_000) throw new HttpError(400, "TOO_LARGE", "That list is too large.");
  const { rows, skipped } = parseMemberList(body.text);
  if (body.dry_run === true) return json({ preview: rows.slice(0, 8), count: rows.length, skipped });
  if (!rows.length) throw new HttpError(400, "NOTHING_TO_IMPORT", "No rows with a name were found.");
  const result = await importMembers(admin, rows, String(body.valid_until ?? ""));
  return json({ ...result, skipped });
});
