// POST /api/checkin/pay  { event_id, attendee_id, kind: "membership" | "entry", method?: "qr" | "manual", event_day_id? }
// After PAYMENT_REQUIRED: the staff member took the cash. Payment + check-in in one transaction.
import { HttpError, json, readJson, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { payAndCheckIn } from "@/lib/checkin";
import { optionalUuid, requireUuid } from "@/lib/validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req) => {
  const staff = await requireStaff(req);
  const body = await readJson(req);
  if (body.kind !== "membership" && body.kind !== "entry") throw new HttpError(400, "BAD_REQUEST", "kind must be membership or entry.");
  const result = await payAndCheckIn({
    staff,
    eventId: requireUuid(body.event_id, "event_id"),
    attendeeId: requireUuid(body.attendee_id, "attendee_id"),
    kind: body.kind,
    method: body.method === "manual" ? "manual" : "qr",
    overrideDayId: optionalUuid(body.event_day_id, "event_day_id"),
  });
  return json(result);
});
