export type Role = "hr" | "admin";
export interface Me {
  id: string;
  name: string;
  role: Role;
}
export type DayAccess = "free" | "members" | "members_or_fee";
export interface DayInfo {
  id: string;
  day_date: string;
  label: string | null;
  access: DayAccess;
  entry_fee: number;
  capacity: number | null;
}
export interface EventInfo {
  id: string;
  slug: string;
  name: string;
  location: string | null;
  membership_fee: number;
  days: DayInfo[];
  today_day_id: string | null;
}
export interface Stats {
  registered: number;
  from_form: number;
  walk_ins: number;
  emails: { sent: number; failed: number; pending: number; none: number };
  today: { day_id: string; label: string; day_date: string; checked_in: number; capacity: number | null } | null;
  today_date: string;
  days: { day_id: string; label: string; day_date: string; checked_in: number; walk_ins: number; capacity: number | null }[];
  my_cash_today: number;
}
export function dayName(d: Pick<DayInfo, "label" | "day_date">): string {
  return d.label?.trim() || d.day_date;
}

export type PaymentKind = "membership" | "entry";
export interface PaymentOption {
  kind: PaymentKind;
  amount: number;
  label: string;
}

export const fmtDT = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)} DT`;

/** Short description of a day's entry rule. */
export function accessLabel(d: Pick<DayInfo, "access" | "entry_fee">, membershipFee: number): string {
  if (d.access === "members") return `Members only · join ${fmtDT(membershipFee)}`;
  if (d.access === "members_or_fee") return `Members free · others ${fmtDT(d.entry_fee)}`;
  return "Free for everyone";
}
