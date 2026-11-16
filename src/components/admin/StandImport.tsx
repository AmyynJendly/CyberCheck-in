"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, MenuSelect, Notice, Row, Section } from "../ui";

type Col = "name" | "email" | "phone" | "enrollment" | "paid";
type Meaning = "sessions" | "main" | "both" | "none";

interface Analysis {
  headers: string[];
  mapping: Partial<Record<Col, number>>;
  enrollment_values: { value: string; count: number; meaning: Meaning }[];
  count: number;
  skipped: number;
  summary: { paid_membership: number; paid_entry: number; unclear: number; not_paid: number };
  has_entry_day: boolean;
  preview: { line: number; full_name: string; email: string | null; enrollment: string | null; paid_raw: string; paid: "membership" | "entry" | null; unclear: boolean }[];
  unclear_rows: { line: number; full_name: string; paid_raw: string }[];
}

const COLS: { key: Col; label: string }[] = [
  { key: "name", label: "Full name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "enrollment", label: "Enrolled in" },
  { key: "paid", label: "Paid" },
];
const MEANINGS: { value: Meaning; label: string }[] = [
  { value: "sessions", label: "The sessions" },
  { value: "main", label: "The main event" },
  { value: "both", label: "Both" },
  { value: "none", label: "Ignore" },
];
const PAID_LABEL = { membership: "Membership 15 DT", entry: "Main event 5 DT" } as const;

/**
 * Paste the registration-stand sheet (or any list of registrations), check how
 * it's read, then import. Re-importing the same sheet changes nothing.
 */
export function StandImport({ eventId, onDone }: { eventId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [mapping, setMapping] = useState<Partial<Record<Col, number>> | null>(null);
  const [meanings, setMeanings] = useState<Record<string, Meaning>>({});
  const [a, setA] = useState<Analysis | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    if (!text.trim()) return setA(null);
    try {
      const r = await api<Analysis>(`/api/admin/events/${eventId}/import`, {
        body: { text, dry_run: true, ...(mapping ? { mapping: Object.fromEntries(COLS.map((c) => [c.key, mapping[c.key] ?? -1])) } : {}), meanings },
      });
      setA(r);
      if (!mapping) setMapping(r.mapping);
      setMsg(null);
    } catch (e) {
      setA(null);
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  }, [eventId, text, mapping, meanings]);

  useEffect(() => {
    const t = setTimeout(read, 400);
    return () => clearTimeout(t);
  }, [read]);

  const doImport = async () => {
    if (!a) return;
    setBusy(true);
    try {
      const r = await api<{
        created: number;
        updated: number;
        unchanged: number;
        emails_queued: number;
        memberships: number;
        entries: number;
        already_member: number;
        unclear: string[];
      }>(`/api/admin/events/${eventId}/import`, {
        body: { text, mapping: Object.fromEntries(COLS.map((c) => [c.key, mapping?.[c.key] ?? -1])), meanings },
        timeoutMs: 90_000,
      });
      setText("");
      setA(null);
      setMapping(null);
      setMeanings({});
      setMsg({
        tone: r.unclear.length ? "warn" : "ok",
        text:
          `Imported: ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged. ` +
          `Paid at the stand: ${r.memberships} membership${r.memberships === 1 ? "" : "s"}, ${r.entries} main-event entr${r.entries === 1 ? "y" : "ies"}` +
          `${r.already_member ? ` (${r.already_member} already members)` : ""}. ` +
          `${r.emails_queued} QR email${r.emails_queued === 1 ? "" : "s"} queued for people who didn't have one.` +
          (r.unclear.length ? ` Check by hand (paid, but for what?): ${r.unclear.join(", ")}.` : ""),
      });
      onDone();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const headerOptions = [{ value: "-1", label: "— none —" }, ...(a?.headers ?? []).map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))];

  return (
    <div className="space-y-5 rounded-[16px] bg-bg2/50 p-4">
      <Section
        header="Import the stand sheet"
        footer="Copy the whole sheet (with its header row) from Excel or Google Sheets and paste it here. Nothing is saved until you press Import. Paid + the sessions = membership (15 DT, free for everything). Paid + the main event only = main-event entry (5 DT). A number in the Paid column decides directly. Stand money is kept apart from the cash HR takes at the door."
      >
        <div className="px-4 py-3">
          <textarea
            aria-label="Pasted sheet"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setMapping(null);
              setMeanings({});
            }}
            rows={5}
            placeholder={"Nom et prénom\tEmail\tTéléphone\tVous participez à\tPayé\nLina Ayari\tlina@example.com\t20 111 222\tSessions, Compétition\tOui"}
            className="w-full resize-y rounded-[10px] bg-fill px-3 py-2 font-mono text-[13px] leading-5 text-label placeholder:text-label3 outline-none"
          />
        </div>
      </Section>

      {a && (
        <>
          <Section header="Columns" footer="Check that each column was recognised. Change it if not.">
            {COLS.map((c) => (
              <Row
                key={c.key}
                title={c.label}
                trailing={
                  <MenuSelect
                    label={c.label}
                    value={String(mapping?.[c.key] ?? -1)}
                    onChange={(v) => setMapping((m) => ({ ...(m ?? {}), [c.key]: Number(v) < 0 ? undefined : Number(v) }))}
                    options={headerOptions}
                  />
                }
              />
            ))}
          </Section>

          {a.enrollment_values.length > 0 && (
            <Section header="Checkbox answers" footer="What each answer of the “enrolled in” question means.">
              {a.enrollment_values.map((v) => (
                <Row
                  key={v.value}
                  title={v.value}
                  subtitle={`${v.count} people`}
                  trailing={
                    <MenuSelect label={`Meaning of ${v.value}`} value={meanings[v.value] ?? v.meaning} onChange={(m) => setMeanings((s) => ({ ...s, [v.value]: m as Meaning }))} options={MEANINGS} />
                  }
                />
              ))}
            </Section>
          )}

          <Section header={`${a.count} people`}>
            <Row title="Paid the membership (15 DT)" value={a.summary.paid_membership} />
            <Row title="Paid the main event only (5 DT)" value={a.summary.paid_entry} />
            <Row title="Not paid yet" value={a.summary.not_paid} />
            {a.summary.unclear > 0 && <Row title={<span className="text-sys-orange">Paid, but for what? (not recorded)</span>} value={a.summary.unclear} />}
          </Section>
          {a.unclear_rows.length > 0 && (
            <Notice tone="warn">
              These say paid but have no clear “enrolled in” answer, so no payment is recorded for them:{" "}
              {a.unclear_rows.map((r) => `${r.full_name} (line ${r.line})`).join(", ")}. Fix the sheet, or record their payment in People afterwards.
            </Notice>
          )}
          {a.summary.paid_entry > 0 && !a.has_entry_day && (
            <Notice tone="error">Some people paid the main-event fee, but no day of this event is set to “Members free, others pay”. Fix the days in Events first.</Notice>
          )}

          <div className="overflow-x-auto rounded-[12px] bg-bg2">
            <table className="w-full min-w-[560px] text-left t-footnote">
              <thead className="text-label2">
                <tr className="border-b border-sep/60">
                  <th className="px-3 py-2 font-medium">Line</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Enrolled in</th>
                  <th className="px-3 py-2 font-medium">Paid column</th>
                  <th className="px-3 py-2 font-medium">Recorded as</th>
                </tr>
              </thead>
              <tbody>
                {a.preview.map((r) => (
                  <tr key={r.line} className="border-b border-sep/40 last:border-0">
                    <td className="px-3 py-2 text-label2">{r.line}</td>
                    <td className="px-3 py-2">{r.full_name}</td>
                    <td className="px-3 py-2 text-label2">{r.enrollment ?? "—"}</td>
                    <td className="px-3 py-2 text-label2">{r.paid_raw || "—"}</td>
                    <td className={`px-3 py-2 font-semibold ${r.unclear ? "text-sys-orange" : r.paid ? "text-sys-green" : "text-label2"}`}>
                      {r.unclear ? "Unclear" : r.paid ? PAID_LABEL[r.paid] : "Not paid"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {a.count > a.preview.length && <p className="px-3 py-2 t-footnote text-label2">First {a.preview.length} of {a.count} shown.</p>}
          </div>

          <Button size="large" className="w-full" disabled={busy || mapping?.name === undefined} onClick={doImport}>
            {busy ? "Importing…" : `Import ${a.count} People`}
          </Button>
        </>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}
