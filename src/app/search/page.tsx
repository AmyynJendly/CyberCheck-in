"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CircleCheck } from "lucide-react";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { Button, NeedEvent, Notice, Page, Row as ListRow, SearchField, Section, Sheet, Spinner, TextField, fmtTime } from "@/components/ui";
import { MemberBadge, PaymentChoices } from "@/components/Payment";
import { fmtDT, type DoorChoice, type PaymentKind, type PaymentOption } from "@/components/types";
import { TeamAsk, TeamPicker, type TeamPerson } from "@/components/Teams";

interface Row {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  class_year: string | null;
  team_name: string | null;
  short_code: string;
  source: "form" | "walk_in";
  email_status: "none" | "pending" | "sent" | "failed";
  email_error: string | null;
  checkin_id: string | null;
  checked_at: string | null;
  checked_by: string | null;
  member_id: string | null;
  member_valid_until: string | null;
}

interface MemberHit {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  valid_until: string;
}

type Msg = { tone: "ok" | "warn" | "error"; text: string };

const EMAIL_STATUS: Record<Row["email_status"], { label: string; cls: string } | null> = {
  sent: { label: "Sent", cls: "text-sys-green" },
  failed: { label: "Failed", cls: "text-sys-red" },
  pending: { label: "Sending", cls: "text-sys-orange" },
  none: null,
};

function SearchInner() {
  const { event, activeDay } = useApp();
  const dayParam = useDayParam();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [msgs, setMsgs] = useState<Record<string, Msg>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<Record<string, PaymentOption[]>>({});
  const [linking, setLinking] = useState<Row | null>(null);
  const [teamAsk, setTeamAsk] = useState<TeamPerson | null>(null);
  const [picking, setPicking] = useState<{ person: TeamPerson; move: boolean } | null>(null);
  // Team buttons on the CTF day (or whenever the admin turned the team question on).
  const teamsOn = !!event && (event.team_prompt || activeDay?.access === "members_or_fee");
  const seq = useRef(0);
  const paidEvent = !!event?.days.some((d) => d.access !== "free");

  const runSearch = useCallback(
    async (term: string) => {
      if (!event || term.trim().length < 2) {
        setRows(null);
        return;
      }
      const my = ++seq.current;
      setLoading(true);
      try {
        const qs = new URLSearchParams({ event_id: event.id, q: term.trim() });
        if (dayParam.event_day_id) qs.set("day_id", dayParam.event_day_id);
        const r = await api<{ results: Row[] }>(`/api/attendees/search?${qs}`);
        if (my === seq.current) setRows(r.results);
      } catch {
        /* offline banner */
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [event, dayParam.event_day_id],
  );

  useEffect(() => {
    const t = setTimeout(() => void runSearch(q), 250);
    return () => clearTimeout(t);
  }, [q, runSearch]);

  const setMsg = (id: string, m: Msg) => setMsgs((s) => ({ ...s, [id]: m }));

  const checkIn = async (row: Row) => {
    if (!event) return;
    setBusyId(row.id);
    try {
      const r = await api<{ status: string; checked_at?: string; by_staff_name?: string; day_label?: string; options?: PaymentOption[]; ask_team?: boolean }>("/api/checkin/manual", {
        body: { attendee_id: row.id, event_id: event.id, ...dayParam },
      });
      if (r.status === "PAYMENT_REQUIRED" && r.options) {
        setPayFor((p) => ({ ...p, [row.id]: r.options! }));
        setMsgs((m) => {
          const { [row.id]: _, ...rest } = m;
          return rest;
        });
        return;
      }
      if (r.ask_team) setTeamAsk({ attendee_id: row.id, name: row.full_name });
      if (r.status === "OK") setMsg(row.id, { tone: "ok", text: `Checked in for ${r.day_label}.` });
      else if (r.status === "ALREADY_CHECKED_IN") setMsg(row.id, { tone: "warn", text: `Already checked in at ${fmtTime(r.checked_at)} by ${r.by_staff_name}.` });
      else if (r.status === "NO_EVENT_DAY") setMsg(row.id, { tone: "error", text: "No event day today." });
      else if (r.status === "FULL") setMsg(row.id, { tone: "error", text: "Session full: no seats left. Not checked in." });
      else setMsg(row.id, { tone: "error", text: r.status });
      await runSearch(q);
    } catch (e) {
      setMsg(row.id, { tone: "error", text: errorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  const pay = async (row: Row, kind: DoorChoice) => {
    if (!event) return;
    setBusyId(row.id);
    try {
      const r = await api<{ status: string; day_label?: string; payment?: { kind: PaymentKind; amount: number } | null; claimed?: boolean; checked_at?: string; by_staff_name?: string; ask_team?: boolean }>(
        "/api/checkin/pay",
        { body: { attendee_id: row.id, event_id: event.id, kind, method: "manual", ...dayParam } },
      );
      setPayFor(({ [row.id]: _, ...rest }) => rest);
      if (r.ask_team) setTeamAsk({ attendee_id: row.id, name: row.full_name });
      if (r.status === "OK")
        setMsg(row.id, {
          tone: "ok",
          text: r.payment
            ? `Paid ${fmtDT(r.payment.amount)}${r.payment.kind === "membership" ? ", now a member" : ""}. Checked in.`
            : r.claimed
              ? "Checked in as a member. An admin will check the member list."
              : `Checked in for ${r.day_label}.`,
        });
      else if (r.status === "ALREADY_CHECKED_IN") setMsg(row.id, { tone: "warn", text: `Already checked in at ${fmtTime(r.checked_at)} by ${r.by_staff_name}. No payment recorded.` });
      else if (r.status === "FULL") setMsg(row.id, { tone: "error", text: "Session full: no seats left. Nothing was charged." });
      else setMsg(row.id, { tone: "error", text: r.status });
      await runSearch(q);
    } catch (e) {
      setMsg(row.id, { tone: "error", text: errorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  const resend = async (row: Row, email?: string) => {
    setBusyId(row.id);
    try {
      const r = await api<{ ok: boolean; error?: string; email: string }>(`/api/attendees/${row.id}/resend`, {
        body: email ? { email } : {},
        timeoutMs: 30_000,
      });
      setMsg(row.id, r.ok ? { tone: "ok", text: `QR code sent to ${r.email}.` } : { tone: "error", text: `The email didn't send: ${r.error}` });
      setEditing(null);
      await runSearch(q);
    } catch (e) {
      setMsg(row.id, { tone: "error", text: errorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  if (!event) return <NeedEvent />;

  return (
    <>
      <div className="-mt-3 space-y-3">
        <SearchField value={q} onChange={setQ} placeholder="Name, email, phone or code" autoFocus />
        {!activeDay && <Notice tone="warn">No event day today. You can search, but not check in.</Notice>}
      </div>

      {loading && !rows && <Spinner label="Searching" />}
      {rows && rows.length === 0 && !loading && (
        <div className="py-10 text-center">
          <p className="t-title3">No Results</p>
          <p className="t-subhead mt-1 text-label2">Check the spelling, or add them as a walk-in.</p>
        </div>
      )}
      {!rows && !loading && (
        <p className="t-subhead px-1 text-label2">Type at least two characters. Codes work in lowercase too.</p>
      )}

      <div className="space-y-3">
        {rows?.map((r) => {
          const status = EMAIL_STATUS[r.email_status];
          return (
            <article key={r.id} className="rounded-[14px] bg-bg2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="t-headline">
                    {r.full_name} {r.member_id && <MemberBadge small />}
                  </h2>
                  <p className="t-subhead text-label2">{[r.team_name, r.class_year, r.source === "walk_in" ? "Walk-in" : null].filter(Boolean).join(" · ") || "No team or class"}</p>
                </div>
                <span className="shrink-0 rounded-[8px] bg-bg3 px-2 py-1 font-mono text-[15px] font-semibold tracking-[0.14em]">{r.short_code}</span>
              </div>

              <dl className="t-footnote mt-3 space-y-1 text-label2">
                <div className="flex gap-2">
                  <dt className="w-12 shrink-0">Email</dt>
                  <dd className="min-w-0 break-all">
                    {r.email ?? "None"}
                    {status && <span className={`ml-1.5 font-semibold ${status.cls}`}>{status.label}</span>}
                  </dd>
                </div>
                {r.phone && (
                  <div className="flex gap-2">
                    <dt className="w-12 shrink-0">Phone</dt>
                    <dd>{r.phone}</dd>
                  </div>
                )}
                {r.email_status === "failed" && r.email_error && <p className="text-sys-red">{r.email_error}</p>}
              </dl>

              {r.checkin_id && (
                <p className="t-subhead mt-3 flex items-center gap-1.5 font-semibold text-sys-green">
                  <CircleCheck className="h-[18px] w-[18px]" strokeWidth={2.4} aria-hidden />
                  Checked in at {fmtTime(r.checked_at)} by {r.checked_by}
                </p>
              )}

              {payFor[r.id] && !r.checkin_id && (
                <div className="mt-4 space-y-2">
                  <p className="t-subhead font-semibold text-sys-blue">Payment needed: not a club member.</p>
                  <PaymentChoices options={payFor[r.id]} busy={busyId === r.id} onPay={(kind) => pay(r, kind)} onCancel={() => setPayFor(({ [r.id]: _, ...rest }) => rest)} />
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                {!r.checkin_id && activeDay && !payFor[r.id] && (
                  <Button onClick={() => checkIn(r)} disabled={busyId === r.id} className="min-w-[120px] flex-1">
                    Check In
                  </Button>
                )}
                {r.email && (
                  <Button variant="gray" onClick={() => resend(r)} disabled={busyId === r.id}>
                    Resend QR
                  </Button>
                )}
                <Button
                  variant="gray"
                  onClick={() => {
                    setEditing(editing === r.id ? null : r.id);
                    setEmailDraft(r.email ?? "");
                  }}
                >
                  {r.email ? "Fix Email" : "Add Email"}
                </Button>
                {teamsOn && (
                  <Button variant="gray" onClick={() => setPicking({ person: { attendee_id: r.id, name: r.full_name }, move: !!r.team_name })}>
                    {r.team_name ? "Change Team" : "Add to Team"}
                  </Button>
                )}
                {paidEvent && !r.member_id && (
                  <Button variant="gray" onClick={() => setLinking(r)}>
                    Member? Find on List
                  </Button>
                )}
              </div>

              {editing === r.id && (
                <form
                  className="mt-3 flex items-center gap-2 rounded-[10px] bg-bg3 pl-3 pr-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void resend(r, emailDraft);
                  }}
                >
                  <TextField
                    type="email"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    placeholder="name@example.com"
                    autoCapitalize="off"
                    autoFocus
                    aria-label="Corrected email"
                  />
                  <Button type="submit" size="small" disabled={busyId === r.id || !emailDraft.trim()}>
                    Save & Send
                  </Button>
                </form>
              )}
              {msgs[r.id] && (
                <div className="mt-3">
                  <Notice tone={msgs[r.id].tone}>{msgs[r.id].text}</Notice>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <TeamAsk
        eventId={event.id}
        person={teamAsk}
        onFinished={(m) => {
          if (m && teamAsk) setMsg(teamAsk.attendee_id, { tone: "ok", text: m });
          setTeamAsk(null);
          void runSearch(q);
        }}
      />
      {picking && (
        <TeamPicker
          eventId={event.id}
          person={picking.person}
          move={picking.move}
          onClose={(m) => {
            if (m) setMsg(picking.person.attendee_id, { tone: "ok", text: m });
            setPicking(null);
            void runSearch(q);
          }}
        />
      )}
      <LinkMemberSheet
        row={linking}
        onClose={() => setLinking(null)}
        onLinked={() => {
          if (linking) {
            setMsg(linking.id, { tone: "ok", text: "Linked to the member list. Check them in for free." });
            setPayFor(({ [linking.id]: _, ...rest }) => rest);
          }
          setLinking(null);
          void runSearch(q);
        }}
      />
    </>
  );
}

function LinkMemberSheet({ row, onClose, onLinked }: { row: Row | null; onClose: () => void; onLinked: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<MemberHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (row) {
      setQ(row.full_name);
      setError(null);
    }
  }, [row]);
  useEffect(() => {
    if (!row || q.trim().length < 2) return setHits(null);
    const t = setTimeout(async () => {
      try {
        setHits((await api<{ members: MemberHit[] }>(`/api/members/search?q=${encodeURIComponent(q.trim())}`)).members);
      } catch (e) {
        setError(errorMessage(e));
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, row]);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Sheet open={!!row} onClose={onClose} title={`Find ${row?.full_name ?? ""} on the member list`} message="Only link someone you've confirmed is a member.">
      <div className="space-y-3 border-t border-sep/60 px-3 py-3 text-left">
        <SearchField value={q} onChange={setQ} placeholder="Name, email or phone" />
        {error && <Notice tone="error">{error}</Notice>}
        {hits?.length === 0 && <p className="t-subhead px-1 text-label2">Not on the list. They can join at the desk.</p>}
        {hits && hits.length > 0 && (
          <div className="max-h-[40vh] overflow-y-auto">
            <Section>
              {hits.map((m) => {
                const valid = m.valid_until >= today;
                return (
                  <ListRow
                    key={m.id}
                    title={m.full_name}
                    subtitle={[m.email, m.phone, valid ? `until ${m.valid_until}` : `expired ${m.valid_until}`].filter(Boolean).join(" · ")}
                    disabled={!valid}
                    onClick={async () => {
                      if (!row) return;
                      try {
                        await api(`/api/attendees/${row.id}/member`, { body: { member_id: m.id } });
                        onLinked();
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }}
                  />
                );
              })}
            </Section>
          </div>
        )}
      </div>
    </Sheet>
  );
}

export default function SearchPage() {
  return (
    <Page title="Search" showContext={false}>
      <Suspense>
        <SearchInner />
      </Suspense>
    </Page>
  );
}
