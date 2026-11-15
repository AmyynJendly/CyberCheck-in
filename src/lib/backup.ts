import { query } from "./db";
import { dayLabel, getEventDays, type EventRow } from "./events";
import { prettyDate, tunisDateTime } from "./time";

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Printable backup list (SPEC §9). A standalone HTML page with print CSS —
 * open it and use the browser's "Print → Save as PDF".
 */
export async function buildBackupHtml(event: EventRow): Promise<{ html: string; rows: number }> {
  const days = await getEventDays(event.id);
  const r = await query<{ full_name: string; class_year: string | null; team_name: string | null; short_code: string; source: string }>(
    `select full_name, class_year, team_name, short_code, source
       from attendees where event_id = $1 order by lower(full_name), created_at`,
    [event.id],
  );
  const dayHeads = days.map((d) => `<th class="tick">${esc(dayLabel(d))}<br><small>${esc(d.day_date)}</small></th>`).join("");
  const rows = r.rows
    .map(
      (a, i) => `<tr>
  <td class="n">${i + 1}</td>
  <td>${esc(a.full_name)}${a.source === "walk_in" ? ' <span class="wi">walk-in</span>' : ""}</td>
  <td>${esc(a.class_year)}</td>
  <td>${esc(a.team_name)}</td>
  <td class="code">${esc(a.short_code)}</td>
  ${days.map(() => '<td class="tick"><span class="box"></span></td>').join("")}
</tr>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backup list — ${esc(event.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 24px; font-size: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #444; margin: 0 0 12px; }
  .bar { margin: 0 0 16px; display: flex; gap: 8px; }
  .bar button { font-size: 15px; padding: 10px 16px; border-radius: 8px; border: 0; background: #0f766e; color: #fff; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 5px 6px; text-align: left; vertical-align: middle; }
  th { background: #eee; font-size: 11px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  td.n { width: 28px; color: #666; text-align: right; }
  td.code { font-family: "Courier New", monospace; font-weight: bold; letter-spacing: 2px; font-size: 13px; }
  .tick { width: 64px; text-align: center; }
  .box { display: inline-block; width: 16px; height: 16px; border: 1.5px solid #000; }
  .wi { font-size: 10px; color: #555; border: 1px solid #999; border-radius: 3px; padding: 0 3px; }
  @media print {
    body { margin: 0; }
    .bar { display: none; }
    @page { size: A4 portrait; margin: 12mm; }
  }
</style></head>
<body>
<div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div>
<h1>${esc(event.name)} — backup check-in list</h1>
<p class="meta">${days.map((d) => esc(`${dayLabel(d)}: ${prettyDate(d.day_date)}`)).join(" · ")}${event.location ? " · " + esc(event.location) : ""}<br>
${r.rows.length} attendees · generated ${esc(tunisDateTime(new Date()))} (Africa/Tunis)</p>
<table>
<thead><tr><th>#</th><th>Name</th><th>Class</th><th>Team</th><th>Code</th>${dayHeads}</tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>`;
  return { html, rows: r.rows.length };
}
