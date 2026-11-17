// Default QR email texts. Shared by the email builder (server) and the
// Admin → Emails editor (browser), so keep this file free of server imports.

export const DEFAULT_SUBJECT = "Your official access pass — {{event}}";

/**
 * The text at the top of the email. A paragraph starting with "# " is a headline.
 * The pass holder's name, QR, backup code, session list and entry rules are always added by the layout.
 */
export const DEFAULT_BODY = `# Welcoming you to attend, Tracers-Camp

We wait for you **CyberTracer**! Here is your official access pass. Please present this QR code at each session checkpoint to register your attendance and clear each stage.`;

/** Placeholders the body and subject can use ({{qr}} is accepted but the layout always shows the QR). */
export const PLACEHOLDERS = ["name", "event", "code", "dates", "location", "entry"] as const;
