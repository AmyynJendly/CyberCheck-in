// QR email designs. The content (text, name, QR, code, sessions, notes) is the
// same; only the look differs. Every style is inline and the layout is tables,
// so Gmail and Outlook show it as designed. Admin → Emails picks the design.
//
// - borderland: the pass as a playing card (Alice in Borderland): ivory card,
//   crimson frame, black "game screen" header, card-suit QR frame, each session
//   a card, the final day the Joker.
// - classic: the first design (navy header, yellow accents). Kept so the club
//   can switch back; also tagged in git as `email-design-classic`.

export type EmailDesign = "borderland" | "classic";
export const EMAIL_DESIGNS: EmailDesign[] = ["borderland", "classic"];
export const DEFAULT_DESIGN: EmailDesign = "borderland";

export interface Block {
  headline: boolean;
  html: string; // already escaped
}

export interface Checkpoint {
  index: number; // 0-based
  suit: "♠" | "♦" | "♣" | "♥";
  label: string;
  date: string; // "Mon 23 Nov"
  rule: string; // "Members only", or "" when every day is free
  stage: string; // "Stage 1" / "Final Stage"
  final: boolean;
}

export interface EmailModel {
  eventName: string;
  tagline: string;
  fullName: string;
  shortCode: string;
  location: string | null;
  top: Block[]; // the admin's text, above the pass
  notes: Block[]; // the admin's text after a "---" line, below the sessions
  checkpoints: Checkpoint[];
  heading: string; // "4 sessions + CyberDay CTF"
  joinFee: string | null; // "15 DT" when some day isn't free for everyone
  logo: boolean;
  keepPrivate: string;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "Consolas,'Courier New','SF Mono',Monaco,monospace";
const SERIF = "Georgia,'Times New Roman',Times,serif";
const RED_SUITS = new Set(["♥", "♦"]);

export function renderEmail(design: EmailDesign, m: EmailModel): string {
  return design === "classic" ? renderClassic(m) : renderBorderland(m);
}

// ---------------------------------------------------------------------------
// Borderland
// ---------------------------------------------------------------------------

const B = {
  page: "#0b0b0f",
  card: "#fbf7ee",
  ink: "#17161c",
  muted: "#6b6672",
  line: "#e7dfcf",
  red: "#c8102e",
  neon: "#ff2e4d",
  gold: "#c9a227",
  goldLight: "#e9c86a",
  screen: "#121117",
};

function renderBorderland(m: EmailModel): string {
  const joker = (align: "left" | "right") =>
    `<td style="width:30px;vertical-align:${align === "left" ? "top" : "bottom"};text-align:center;font-family:${SERIF};font-size:11px;font-weight:700;line-height:1.1;color:${B.red};padding:${align === "left" ? "14px 0 0 10px" : "0 10px 14px 0"}">J<br>O<br>K<br>E<br>R<br><span style="font-size:13px">★</span></td>`;
  const block = (b: Block) =>
    b.headline
      ? `<h2 style="font-family:${SERIF};font-size:22px;font-weight:700;color:${B.ink};margin:0 0 10px;line-height:1.3">${b.html}</h2>`
      : `<p style="font-family:${SANS};font-size:14px;line-height:1.65;color:${B.muted};margin:0 auto 12px;max-width:430px">${b.html}</p>`;
  const miniCard = (c: Checkpoint) =>
    c.final
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:36px;height:48px;background:${B.ink};border:1.5px solid ${B.gold};border-radius:6px"><tr><td align="center" style="font-family:${SERIF};font-size:9px;font-weight:700;color:${B.goldLight};letter-spacing:0.5px;line-height:1.15;padding:4px 0"><span style="font-size:17px">★</span><br>JKR</td></tr></table>`
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:36px;height:48px;background:#ffffff;border:1.5px solid ${B.ink};border-radius:6px"><tr><td align="center" style="font-family:${SERIF};font-size:15px;font-weight:700;line-height:1.05;padding:5px 0;color:${RED_SUITS.has(c.suit) ? B.red : B.ink}">${c.index + 1}<br><span style="font-size:17px">${c.suit}</span></td></tr></table>`;
  const games = m.checkpoints
    .map((c, i) => {
      const bottom = i === m.checkpoints.length - 1 ? "" : `border-bottom:1px solid ${c.final ? B.ink : B.line};`;
      const bg = c.final ? `background:${B.ink};` : "";
      return `<tr${c.final ? ` style="background:${B.ink}"` : ""}>
<td style="${bg}${bottom}padding:10px 0 10px 14px;width:40px;vertical-align:middle">${miniCard(c)}</td>
<td style="${bg}${bottom}padding:10px 12px;vertical-align:middle;font-family:${SANS}">
<div style="font-size:14px;font-weight:700;color:${c.final ? B.goldLight : B.ink};line-height:1.3">${esc(c.label)}</div>
<div style="font-size:12px;color:${c.final ? "#b9b4c2" : B.muted};margin-top:2px">${esc(c.date)}${c.rule ? ` · ${esc(c.rule)}` : ""}</div>
</td>
<td style="${bg}${bottom}padding:10px 14px 10px 0;text-align:right;vertical-align:middle;font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;white-space:nowrap;color:${c.final ? B.neon : B.muted}">${esc(c.stage)}</td>
</tr>`;
    })
    .join("\n");
  const days = m.checkpoints.length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(m.eventName)}</title></head>
<body style="margin:0;padding:0;background:${B.page}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${B.page};padding:28px 10px">
<tr><td align="center">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;background:${B.card};border:2px solid ${B.red};border-radius:20px;border-collapse:separate">
<tr><td style="padding:6px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${B.red};border-radius:15px;border-collapse:separate">

<tr>${joker("left")}<td style="padding:14px 4px 0">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${B.screen};border-radius:12px;border-top:3px solid ${B.neon};border-collapse:separate">
<tr><td align="center" style="padding:24px 16px 20px">
${m.logo ? `<img src="cid:logo" width="72" alt="Cyber Trace" style="display:block;width:72px;height:auto;margin:0 auto 12px;border:0">` : ""}
<div style="font-family:${SANS};font-size:10px;font-weight:700;color:${B.goldLight};letter-spacing:3px;text-transform:uppercase;margin:0 0 6px">Cyber Trace Club</div>
<div style="font-family:${SERIF};font-size:30px;font-weight:700;color:#ffffff;letter-spacing:1px;line-height:1.15;margin:0">${esc(m.eventName)}</div>
${m.tagline ? `<div style="font-family:${SANS};font-size:12px;color:#b9b4c2;letter-spacing:1.5px;margin-top:8px">${esc(m.tagline)}</div>` : ""}
<div style="font-family:${SERIF};font-size:16px;letter-spacing:10px;margin-top:12px;line-height:1"><span style="color:#ffffff">♠</span><span style="color:${B.neon}">♥</span><span style="color:${B.neon}">♦</span><span style="color:#ffffff">♣</span></div>
</td></tr>
</table>

</td><td style="width:30px"></td></tr>

<tr><td colspan="3" align="center" style="padding:22px 26px 6px;text-align:center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 16px"><tr>
<td style="font-family:${SANS};background:${B.ink};color:${B.goldLight};font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:6px 12px;border:1px solid ${B.gold};border-radius:20px 0 0 20px">Official Access Pass</td>
${days ? `<td style="font-family:${SANS};background:${B.red};color:#ffffff;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:6px 12px;border:1px solid ${B.red};border-radius:0 20px 20px 0">Visa · ${days} day${days === 1 ? "" : "s"}</td>` : ""}
</tr></table>
${m.top.map(block).join("\n")}
</td></tr>

<tr><td colspan="3" style="padding:8px 26px 0"><div style="border-top:2px dashed ${B.line};height:0;line-height:0;font-size:0">&nbsp;</div></td></tr>

<tr><td colspan="3" align="center" style="padding:20px 26px 0;text-align:center">
<div style="font-family:${SANS};font-size:10px;font-weight:700;color:${B.red};letter-spacing:3px;text-transform:uppercase;margin:0 0 4px">Player</div>
<div style="font-family:${MONO};font-size:20px;font-weight:800;color:${B.ink};letter-spacing:0.8px;line-height:1.3;margin:0 0 14px">${esc(m.fullName)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;background:#ffffff;border:2px solid ${B.ink};border-radius:14px;border-collapse:separate">
<tr><td style="padding:8px 0 0 10px;font-family:${SERIF};font-size:16px;color:${B.ink};text-align:left">♠</td><td></td><td style="padding:8px 10px 0 0;font-family:${SERIF};font-size:16px;color:${B.red};text-align:right">♥</td></tr>
<tr><td colspan="3" align="center" style="padding:2px 22px"><img src="cid:qr" width="260" height="260" alt="Your QR access pass" style="display:block;width:260px;height:260px;border:0"></td></tr>
<tr><td style="padding:0 0 8px 10px;font-family:${SERIF};font-size:16px;color:${B.red};text-align:left">♦</td><td></td><td style="padding:0 10px 8px 0;font-family:${SERIF};font-size:16px;color:${B.ink};text-align:right">♣</td></tr>
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:14px auto 0;border:1px dashed ${B.red};border-radius:8px;border-collapse:separate"><tr>
<td style="font-family:${SANS};font-size:10px;font-weight:700;color:${B.muted};letter-spacing:2px;text-transform:uppercase;padding:7px 4px 7px 12px">Backup code</td>
<td style="font-family:${MONO};font-size:16px;font-weight:800;color:${B.red};letter-spacing:4px;padding:7px 12px 7px 6px">${esc(m.shortCode)}</td>
</tr></table>
</td></tr>

${
  days
    ? `<tr><td colspan="3" style="padding:24px 18px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1.5px solid ${B.ink};border-radius:12px;border-collapse:separate">
<tr><td colspan="3" style="background:${B.ink};border-radius:10px 10px 0 0;padding:11px 14px;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${B.goldLight}">♠ The games <span style="color:#8d8798;font-weight:400;letter-spacing:1px">· ${esc(m.heading)}</span></td></tr>
${games}
</table>
${m.joinFee ? `<div style="font-family:${SANS};font-size:12px;line-height:1.55;color:${B.muted};text-align:center;margin:10px 6px 0">Not a member? Join at the desk for <b style="color:${B.ink}">${esc(m.joinFee)}</b>: valid for the whole academic year, and every game is free.</div>` : ""}
</td></tr>`
    : ""
}

${
  m.notes.length
    ? `<tr><td colspan="3" style="padding:18px 18px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff8f4;border:1.5px dashed ${B.red};border-radius:12px;border-collapse:separate">
<tr><td style="padding:14px 16px;font-family:${SANS};font-size:14px;line-height:1.7;color:${B.ink}">${m.notes
        .map((b) => (b.headline ? `<div style="font-family:${SERIF};font-size:16px;font-weight:700;margin:0 0 4px">${b.html}</div>` : `<div style="margin:0 0 6px">${b.html}</div>`))
        .join("")}</td></tr>
</table>
</td></tr>`
    : ""
}

<tr><td colspan="2" style="padding:20px 0 14px 18px;font-family:${SANS};font-size:12px;color:${B.muted};vertical-align:bottom">${esc(m.keepPrivate)}</td>${joker("right")}</tr>

</table>
</td></tr>
</table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px">
<tr><td align="center" style="padding:18px 16px 4px;font-family:${SANS};font-size:12px;line-height:1.7;color:#9a95a3">
Please present this QR code at each session entrance.${m.location ? ` · ${esc(m.location)}` : ""}<br>
<span style="font-family:${SERIF};color:${B.goldLight};letter-spacing:1px">Clear every stage. Survive the Borderland.</span><br>
Organized by <b style="color:#ffffff">Cyber Trace Club</b>
</td></tr>
</table>

</td></tr></table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Classic (the first design)
// ---------------------------------------------------------------------------

const CLASSIC_SUIT_COLOR: Record<Checkpoint["suit"], string> = { "♠": "#0284c7", "♦": "#d97706", "♣": "#16a34a", "♥": "#dc2626" };

function renderClassic(m: EmailModel): string {
  const cell = "padding:9px 14px;border-bottom:1px solid #edf2f7;color:#334155;font-size:13px";
  const rows = m.checkpoints
    .map((c, i) => {
      const last = i === m.checkpoints.length - 1 ? ";border-bottom:none" : "";
      const icon = c.final ? "🃏" : c.suit;
      const color = c.final ? "#92400e" : CLASSIC_SUIT_COLOR[c.suit];
      return `<tr${c.final ? ' style="background:#fffbeb"' : ""}>
<td style="${cell}${last}${c.final ? ";font-weight:700;color:#92400e" : ""}"><span style="font-weight:700;margin-right:6px;color:${color}">${icon}</span>${esc(c.label)}<br><span style="font-size:12px;font-weight:400;color:#64748b">${esc(c.date)}${c.rule ? ` · ${esc(c.rule)}` : ""}</span></td>
<td style="${cell}${last};text-align:right;font-size:12px;${c.final ? "font-weight:700;color:#b45309" : "color:#64748b"}">${esc(c.stage)}</td>
</tr>`;
    })
    .join("\n");
  const block = (b: Block) =>
    b.headline
      ? `<h2 style="font-size:20px;font-weight:700;color:#0f172a;margin:0 0 10px;line-height:1.35">${b.html}</h2>`
      : `<p style="font-size:14px;line-height:1.6;color:#475569;margin:0 auto 12px;max-width:440px">${b.html}</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(m.eventName)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:24px 12px;font-family:${SANS};color:#1e293b">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;border-collapse:separate">

<tr><td style="background:#0f172a;padding:30px 20px 22px;text-align:center;border-radius:16px 16px 0 0">
${m.logo ? `<img src="cid:logo" width="76" alt="Cyber Trace" style="display:block;width:76px;height:auto;margin:0 auto 12px;border:0">` : ""}
<div style="font-size:11px;font-weight:700;color:#eab308;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 4px">Cyber Trace Club</div>
<h1 style="font-size:22px;font-weight:800;letter-spacing:0.5px;margin:0;color:#ffffff;line-height:1.3">${esc(m.eventName)}</h1>
${m.tagline ? `<div style="font-size:12px;color:#94a3b8;margin-top:6px;letter-spacing:1px">${esc(m.tagline)}</div>` : ""}
</td></tr>

<tr><td style="padding:26px 24px 16px;text-align:center">
<div style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;letter-spacing:1px;text-transform:uppercase;margin:0 0 14px;border:1px solid #fde68a">Official Access Pass</div>
${m.top.map(block).join("\n")}
<div style="border-top:2px dashed #cbd5e1;margin:22px 0 20px;height:0;line-height:0;font-size:0">&nbsp;</div>
<div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px">Pass holder</div>
<div style="font-family:${MONO};font-size:19px;font-weight:800;color:#1e3a8a;letter-spacing:0.8px;margin:0 0 14px;line-height:1.3">${esc(m.fullName)}</div>
<div style="display:inline-block;padding:12px;background:#ffffff;border:2px solid #e2e8f0;border-radius:14px;margin:0 0 12px"><img src="cid:qr" width="290" height="290" alt="Your QR access pass" style="display:block;width:290px;height:290px;border:0"></div>
<div style="font-family:${MONO};font-size:12px;color:#64748b;margin:0 0 22px;letter-spacing:1px">BACKUP CODE: <b style="font-size:15px;color:#0f172a;letter-spacing:3px">${esc(m.shortCode)}</b></div>
${
  m.checkpoints.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:left;margin:6px 0 12px">
<tr><td colspan="2" style="background:#f1f5f9;padding:10px 14px;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0;border-radius:10px 10px 0 0">Event checkpoints (${esc(m.heading)})</td></tr>
${rows}
</table>`
    : ""
}
${m.joinFee ? `<div style="font-size:12px;line-height:1.55;color:#64748b;margin:0 0 6px;padding:0 4px">Not a member? Join at the desk for <b style="color:#334155">${esc(m.joinFee)}</b>: valid for the whole academic year, and every day is free.</div>` : ""}
${
  m.notes.length
    ? `<div style="text-align:left;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin:14px 0 4px;font-size:13px;line-height:1.7;color:#334155">${m.notes
        .map((b) => (b.headline ? `<div style="font-weight:700;font-size:14px;margin:0 0 4px">${b.html}</div>` : `<div style="margin:0 0 6px">${b.html}</div>`))
        .join("")}</div>`
    : ""
}
</td></tr>

<tr><td style="background:#0f172a;color:#94a3b8;padding:22px 20px;text-align:center;font-size:12px;line-height:1.6;border-radius:0 0 16px 16px">
<p style="margin:0 0 6px">Please present this QR code at each session entrance.${m.location ? ` · ${esc(m.location)}` : ""}</p>
<p style="margin:0 0 6px">${esc(m.keepPrivate)}</p>
<p style="margin:0">Organized by <b style="color:#f8fafc">Cyber Trace Club</b></p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}
