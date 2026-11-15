// POST /api/attendees/:id/resend  { email? }  — optionally fix a typo first, then resend the same QR.
import { json, readJson, route, type RouteCtx } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { updateAttendeeEmail } from "@/lib/attendees";
import { sendAttendeeEmail } from "@/lib/email";
import { audit } from "@/lib/audit";
import { query } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export const POST = route<RouteCtx<{ id: string }>>(async (req, ctx) => {
  const staff = await requireStaff(req);
  const attendeeId = requireUuid((await ctx.params).id, "attendee id");
  const body = req.headers.get("content-length") === "0" ? {} : await readJson(req).catch(() => ({}) as Record<string, unknown>);

  const cur = await query<{ event_id: string; email: string | null }>("select event_id, email from attendees where id = $1", [attendeeId]);
  if (!cur.rows[0]) throw new HttpError(404, "ATTENDEE_NOT_FOUND", "Attendee not found.");

  let email = cur.rows[0].email;
  if (body.email !== undefined && body.email !== null && body.email !== "") {
    email = await updateAttendeeEmail(attendeeId, body.email, staff);
  }
  if (!email) throw new HttpError(400, "NO_EMAIL", "This attendee has no email. Add one first.");

  await audit({ staffId: staff.id, action: "resend", eventId: cur.rows[0].event_id, attendeeId, details: { to: email } });
  const outcome = await sendAttendeeEmail(attendeeId, { reason: "resend", staffId: staff.id });
  return json({ ...outcome, email });
});
