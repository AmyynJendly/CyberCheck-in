export type Role = "hr" | "admin";
export interface Me {
  id: string;
  name: string;
  role: Role;
}
export interface DayInfo {
  id: string;
  day_date: string;
  label: string | null;
}
export interface EventInfo {
  id: string;
  slug: string;
  name: string;
  location: string | null;
  days: DayInfo[];
  today_day_id: string | null;
}
export interface Stats {
  registered: number;
  from_form: number;
  walk_ins: number;
  emails: { sent: number; failed: number; pending: number; none: number };
  today: { day_id: string; label: string; day_date: string; checked_in: number } | null;
  today_date: string;
  days: { day_id: string; label: string; day_date: string; checked_in: number; walk_ins: number }[];
}
export function dayName(d: Pick<DayInfo, "label" | "day_date">): string {
  return d.label?.trim() || d.day_date;
}
