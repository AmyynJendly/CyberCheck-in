// Default QR email texts. Shared by the email builder (server) and the
// Admin → Emails editor (browser), so keep this file free of server imports.

export const DEFAULT_SUBJECT = "Your official access pass — {{event}}";

/**
 * The text at the top of the email. A paragraph starting with "# " is a headline. Text after a
 * "---" line goes below the session list (notes, e.g. what to bring).
 * The player's name, QR, backup code, session list and entry rules are always added by the layout.
 */
export const DEFAULT_BODY = `# Welcoming you to attend, TracersCamp

We wait for you **CyberTracer**! Here is your official access pass. Please present this QR code at each session checkpoint to register your attendance and clear each stage.

---

# Don't forget to bring
1. Your PC
2. Your internet (mobile data or a hotspot)
3. Your power strip (optional)`;

/** Placeholders the body and subject can use ({{qr}} is accepted but the layout always shows the QR). */
export const PLACEHOLDERS = ["name", "event", "code", "dates", "location", "entry"] as const;
