import { query, type Queryable } from "./db";

export type AuditAction =
  | "login"
  | "login_failed"
  | "logout"
  | "checkin"
  | "checkin_rejected"
  | "manual_checkin"
  | "walk_in"
  | "undo"
  | "resend"
  | "edit_email"
  | "email_sent"
  | "email_failed"
  | "retry_failed_emails"
  | "form_submit"
  | "form_rejected"
  | "export"
  | "backup_list"
  | "create_event"
  | "update_event"
  | "regenerate_form_secret"
  | "create_day"
  | "update_day"
  | "delete_day"
  | "create_staff"
  | "update_staff"
  | "reset_pin"
  | "deactivate_staff"
  | "activate_staff"
  | "payment"
  | "void_payment"
  | "import_members"
  | "add_member"
  | "delete_member"
  | "link_member"
  | "import_attendees"
  | "update_email_template";

export interface AuditEntry {
  staffId?: string | null;
  action: AuditAction;
  eventId?: string | null;
  attendeeId?: string | null;
  details?: Record<string, unknown> | null;
}

export async function audit(entry: AuditEntry, client?: Queryable): Promise<void> {
  await query(
    `insert into audit_log (staff_id, action, event_id, attendee_id, details)
     values ($1, $2, $3, $4, $5)`,
    [
      entry.staffId ?? null,
      entry.action,
      entry.eventId ?? null,
      entry.attendeeId ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ],
    client,
  );
}

/** Audit without failing the caller (used after the main work already committed). */
export async function auditSafe(entry: AuditEntry): Promise<void> {
  try {
    await audit(entry);
  } catch (err) {
    console.error("[audit] failed to write", entry.action, err);
  }
}
