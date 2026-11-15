"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Button, FieldRow, Notice, Row, SearchField, Section, Sheet, SheetAction, Spinner, TextField } from "../ui";

interface Member {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  valid_until: string;
  source: "import" | "desk" | "manual";
}
interface ListResponse {
  members: Member[];
  counts: { total: number; valid: number };
  default_valid_until: string;
}
interface Preview {
  preview: { full_name: string; email: string | null; phone: string | null }[];
  count: number;
  skipped: number;
}

const SOURCE = { import: "Imported", desk: "Joined at the desk", manual: "Added by hand" } as const;

export function MembersAdmin() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<ListResponse | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [text, setText] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [one, setOne] = useState({ full_name: "", email: "", phone: "" });
  const [removing, setRemoving] = useState<Member | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<ListResponse>(`/api/admin/members?q=${encodeURIComponent(q.trim())}`);
      setData(r);
      setValidUntil((v) => v || r.default_valid_until);
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const doPreview = () =>
    run(async () => {
      const r = await api<Preview>("/api/admin/members/import", { body: { text, dry_run: true } });
      setPreview(r);
      return `Found ${r.count} member${r.count === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} empty row${r.skipped === 1 ? "" : "s"}` : ""}. Check the first rows below, then import.`;
    });

  const doImport = () =>
    run(async () => {
      const r = await api<{ added: number; updated: number }>("/api/admin/members/import", { body: { text, valid_until: validUntil } });
      setText("");
      setPreview(null);
      return `Imported: ${r.added} new, ${r.updated} already on the list (updated).`;
    });

  return (
    <div className="space-y-7">
      {data && (
        <p className="t-subhead px-1 text-label2">
          <span className="font-semibold text-label tabular">{data.counts.valid}</span> active members
          {data.counts.total > data.counts.valid && ` · ${data.counts.total - data.counts.valid} expired`}
        </p>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <Section
        header="Import the member list"
        footer="Copy the rows from Excel or Google Sheets (with the header row: name, email, phone) and paste them here. CSV works too. Have screenshots? Send them to Claude to turn into rows. People already on the list are updated, not duplicated."
      >
        <div className="px-4 py-3">
          <textarea
            aria-label="Pasted member list"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            rows={5}
            placeholder={"Name\tEmail\tPhone\nAmira Trabelsi\tamira@example.com\t98 111 222"}
            className="w-full resize-y rounded-[10px] bg-fill px-3 py-2 font-mono text-[13px] leading-5 text-label placeholder:text-label3 outline-none"
          />
        </div>
        <FieldRow label="Valid until" htmlFor="mem-valid">
          <TextField id="mem-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </FieldRow>
      </Section>

      {preview && preview.preview.length > 0 && (
        <Section header={`Preview · first ${preview.preview.length} of ${preview.count}`}>
          {preview.preview.map((p, i) => (
            <Row key={i} title={p.full_name} subtitle={[p.email ?? "no email", p.phone ?? "no phone"].join(" · ")} />
          ))}
        </Section>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <Button variant="gray" size="large" disabled={busy || !text.trim()} onClick={doPreview}>
          Preview
        </Button>
        <Button size="large" disabled={busy || !preview || !preview.count || !validUntil} onClick={doImport}>
          Import {preview?.count ? preview.count : ""}
        </Button>
      </div>

      {adding ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/api/admin/members", { body: { ...one, valid_until: validUntil } });
              setOne({ full_name: "", email: "", phone: "" });
              setAdding(false);
              return `${one.full_name} added.`;
            });
          }}
        >
          <Section header="Add one member" footer={`Valid until ${validUntil}.`}>
            <FieldRow label="Name" htmlFor="m1-name">
              <TextField id="m1-name" value={one.full_name} required onChange={(e) => setOne((s) => ({ ...s, full_name: e.target.value }))} />
            </FieldRow>
            <FieldRow label="Email" htmlFor="m1-email">
              <TextField id="m1-email" type="email" autoCapitalize="off" value={one.email} onChange={(e) => setOne((s) => ({ ...s, email: e.target.value }))} />
            </FieldRow>
            <FieldRow label="Phone" htmlFor="m1-phone">
              <TextField id="m1-phone" inputMode="tel" value={one.phone} onChange={(e) => setOne((s) => ({ ...s, phone: e.target.value }))} />
            </FieldRow>
          </Section>
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="gray" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !one.full_name.trim()}>
              Add Member
            </Button>
          </div>
        </form>
      ) : (
        <Section>
          <Row title="Add One Member" accent onClick={() => setAdding(true)} />
        </Section>
      )}

      <div className="space-y-3">
        <SearchField value={q} onChange={setQ} placeholder="Search members" />
        {!data && <Spinner />}
        {data?.members.length === 0 && <p className="t-subhead py-4 text-center text-label2">{q ? "No match." : "No members yet. Import your list above."}</p>}
        {data && data.members.length > 0 && (
          <Section footer={data.members.length >= 300 ? "Showing the first 300. Search to find someone." : undefined}>
            {data.members.map((m) => {
              const expired = m.valid_until < new Date().toISOString().slice(0, 10);
              return (
                <Row
                  key={m.id}
                  title={<span className={expired ? "text-label2" : ""}>{m.full_name}</span>}
                  subtitle={[m.email, m.phone, `${expired ? "expired" : "until"} ${m.valid_until}`, SOURCE[m.source]].filter(Boolean).join(" · ")}
                  onClick={() => setRemoving(m)}
                />
              );
            })}
          </Section>
        )}
      </div>

      <Sheet open={!!removing} onClose={() => setRemoving(null)} title={removing?.full_name} message="Removing someone from the list means they'll be asked to pay on member-only days.">
        <SheetAction
          destructive
          onClick={() => {
            const m = removing;
            setRemoving(null);
            if (m)
              void run(async () => {
                await api(`/api/admin/members/${m.id}`, { method: "DELETE" });
                return `${m.full_name} removed from the member list.`;
              });
          }}
        >
          Remove from Member List
        </SheetAction>
      </Sheet>
    </div>
  );
}
