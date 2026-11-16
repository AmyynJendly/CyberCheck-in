// Which sessions a person ticked on the form's checkbox question. Pure (no DB):
// used by the CSV export and by the admin People page.

/** Split a checkbox cell ("Sessions, Main event") into its answers. */
export function enrollParts(cell: string | null | undefined): string[] {
  return (cell ?? "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Did the form's checkbox answer tick this day? A day is ticked when one of the
 * answers starts with the day's label: label "Offensive Web 101" matches the
 * option "Offensive Web 101(from interception to exploitation)".
 */
export function tickedDay(enrollment: string | null, label: string): boolean {
  const l = norm(label);
  return !!l && enrollParts(enrollment).some((p) => norm(p).startsWith(l));
}

/** Days that at least one registration ticked: only these are compared with attendance. */
export function tickableDays<D extends { id: string; label: string | null; day_date: string }>(days: D[], enrollments: (string | null)[]): Set<string> {
  const filled = enrollments.filter((e): e is string => !!e);
  return new Set(days.filter((d) => filled.some((e) => tickedDay(e, d.label?.trim() || d.day_date))).map((d) => d.id));
}
