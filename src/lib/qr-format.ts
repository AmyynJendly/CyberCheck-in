// Shared by the browser scanner and the server. No Node imports here.
export const QR_PREFIX = "CT1:";
// 26 base32 chars (current), or 43 base64url chars (tickets issued before the switch).
const TOKEN_RE = /^(?:[A-Z2-7]{26}|[A-Za-z0-9_-]{43})$/;

export function qrContent(token: string): string {
  return QR_PREFIX + token;
}

/** Scanner side: anything without the CT1: prefix (or malformed) is INVALID. */
export function parseScannedText(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith(QR_PREFIX)) return null;
  const token = t.slice(QR_PREFIX.length);
  return TOKEN_RE.test(token) ? token : null;
}

/** Server side: accept "CT1:<token>" or a bare token. */
export function normalizeToken(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim();
  const token = t.startsWith(QR_PREFIX) ? t.slice(QR_PREFIX.length) : t;
  return TOKEN_RE.test(token) ? token : null;
}
