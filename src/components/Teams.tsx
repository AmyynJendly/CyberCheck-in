"use client";

// Teams (CTF day): the "Not in a team" popup, the team picker, and the board data hook.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, UsersRound, X } from "lucide-react";
import { api, errorMessage } from "./api";
import { useDayParam } from "./AppContext";
import { Button, Notice, SearchField, Sheet, SheetAction, Spinner } from "./ui";
import { similarPerson, similarTeam, teamKey } from "@/lib/team-names";

export interface BoardMember {
  member_id: string;
  attendee_id: string | null;
  name: string;
  reserved_name: string | null;
  here: boolean;
  source: "sheet" | "door";
}
export interface BoardTeam {
  id: string;
  name: string;
  count: number;
  here: number;
  members: BoardMember[];
}
export interface HerePerson {
  attendee_id: string;
  name: string;
  team_id: string | null;
  checked_at: string;
}
export interface Board {
  settings: { team_max: number; team_small_ok: boolean; team_prompt: boolean };
  day_id: string | null;
  teams: BoardTeam[];
  here: HerePerson[];
}
export interface TeamPerson {
  attendee_id: string;
  name: string;
}
type AddResponse =
  | { status: "OK"; team: { id: string; name: string; count: number; max: number }; moved_from?: string | null }
  | { status: "ALREADY_IN_TEAM"; team: { id: string; name: string } }
  | { status: "IN_OTHER_TEAM"; team: { id: string; name: string } }
  | { status: "FULL"; team: { id: string; name: string; count: number; max: number } }
  | { status: "SIMILAR"; name: string; suggestions: { id: string; name: string; count: number }[] };

/** Teams + who is here, reloaded on demand (and every `pollMs` when given). */
export function useBoard(eventId: string | undefined, pollMs = 0) {
  const dayParam = useDayParam();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const qs = dayParam.event_day_id ? `?day_id=${dayParam.event_day_id}` : "";
      setBoard(await api<Board>(`/api/events/${eventId}/teams${qs}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [eventId, dayParam.event_day_id]);
  useEffect(() => {
    void load();
    if (!pollMs) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);
  return { board, error, reload: load };
}

/** "2 of 4 · 1 here" and whether the team can take one more. */
export function teamLine(t: Pick<BoardTeam, "count" | "here">, max: number) {
  return `${t.count} of ${max}${t.here ? ` · ${t.here} here` : ""}`;
}

/** Calls /api/teams/add and turns every answer into a next step for the screen. */
export async function addPerson(body: Record<string, unknown>): Promise<AddResponse> {
  return api<AddResponse>("/api/teams/add", { body, timeoutMs: 15_000 });
}

/**
 * After a check-in: "Not in a team" with Add to Team / Later. Opens the picker.
 * `onFinished(message)` runs when the popup closes (message = what happened, or null for Later).
 */
export function TeamAsk({ eventId, person, onFinished }: { eventId: string; person: TeamPerson | null; onFinished: (message: string | null) => void }) {
  const [picking, setPicking] = useState(false);
  useEffect(() => setPicking(false), [person?.attendee_id]);
  if (!person) return null;
  if (picking) return <TeamPicker eventId={eventId} person={person} onClose={(msg) => onFinished(msg)} />;
  return (
    <Sheet open onClose={() => onFinished(null)} title={person.name} message="Not in a team yet.">
      <SheetAction onClick={() => setPicking(true)}>Add to Team</SheetAction>
      <SheetAction onClick={() => onFinished(null)}>Later</SheetAction>
    </Sheet>
  );
}

/**
 * Full-screen team picker for one person: search a team or a teammate, add, or create.
 * `move` = they're already in a team and HR chose "Move" (no extra question).
 */
export function TeamPicker({ eventId, person, move = false, onClose }: { eventId: string; person: TeamPerson; move?: boolean; onClose: (message: string | null) => void }) {
  const { board, error: loadError, reload } = useBoard(eventId);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "warn"; text: string } | null>(null);
  const [ask, setAsk] = useState<
    | { kind: "similar"; name: string; suggestions: { id: string; name: string; count: number }[] }
    | { kind: "other"; target: { team_id?: string; new_name?: string; force?: boolean; reserved_id?: string; label: string }; current: string }
    | null
  >(null);
  const max = board?.settings.team_max ?? 4;

  const current = useMemo(() => board?.teams.find((t) => t.members.some((m) => m.attendee_id === person.attendee_id)) ?? null, [board, person.attendee_id]);
  // Reserved spots from the team sheet that look like this person's name.
  const reservedMatches = useMemo(
    () =>
      (board?.teams ?? []).flatMap((t) =>
        t.members.filter((m) => !m.attendee_id && m.reserved_name && similarPerson(m.reserved_name, person.name)).map((m) => ({ team: t, member: m })),
      ),
    [board, person.name],
  );
  const term = q.trim();
  const key = teamKey(term);
  const teams = useMemo(() => {
    const all = board?.teams ?? [];
    const hits = term
      ? all.filter((t) => t.name.toLowerCase().includes(term.toLowerCase()) || similarTeam(t.name, term) || t.members.some((m) => m.name.toLowerCase().includes(term.toLowerCase())))
      : all;
    return [...hits].sort((a, b) => Number(a.count >= max) - Number(b.count >= max) || a.name.localeCompare(b.name));
  }, [board, term, max]);
  const exact = !!key && (board?.teams ?? []).some((t) => teamKey(t.name) === key);

  const send = async (target: { team_id?: string; new_name?: string; force?: boolean; reserved_id?: string; label: string }, moveNow = move) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await addPerson({ event_id: eventId, attendee_id: person.attendee_id, team_id: target.team_id, new_name: target.new_name, force: target.force, reserved_id: target.reserved_id, move: moveNow });
      if (r.status === "OK") return onClose(`${person.name} → ${r.team.name} (${r.team.count}/${r.team.max})${r.moved_from ? `, moved from ${r.moved_from}` : ""}`);
      if (r.status === "ALREADY_IN_TEAM") return onClose(`${person.name} is already in ${r.team.name}`);
      if (r.status === "IN_OTHER_TEAM") return setAsk({ kind: "other", target, current: r.team.name });
      if (r.status === "SIMILAR") return setAsk({ kind: "similar", name: r.name, suggestions: r.suggestions });
      setMsg({ tone: "error", text: `${r.team.name} is full (${r.team.count}/${r.team.max}). Pick another team.` });
      await reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="anim-fade fixed inset-0 z-[80] flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label={`Team for ${person.name}`}>
      <div className="flex items-center gap-3 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1">
          <p className="t-footnote uppercase text-label2">{move ? "Move to another team" : "Add to a team"}</p>
          <p className="t-title2 truncate">{person.name}</p>
          {current && <p className="t-subhead text-label2">Now in {current.name}</p>}
        </div>
        <button type="button" onClick={() => onClose(null)} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fill text-label2 active:bg-fill2">
          <X className="h-5 w-5" strokeWidth={2.4} />
        </button>
      </div>
      <div className="px-4 pb-3">
        <SearchField value={q} onChange={setQ} placeholder="Team name or a teammate's name" autoFocus />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {loadError && <Notice tone="error">{loadError}</Notice>}
        {!board && !loadError && <Spinner />}

        {reservedMatches.map(({ team, member }) => (
          <div key={member.member_id} className="rounded-[14px] bg-accent/15 p-4">
            <p className="t-subhead">
              The team sheet has a spot for <strong>{member.reserved_name}</strong> in <strong>{team.name}</strong>. Is this them?
            </p>
            <Button className="mt-3 w-full" disabled={busy} onClick={() => send({ team_id: team.id, reserved_id: member.member_id, label: team.name })}>
              Yes, give them this spot
            </Button>
          </div>
        ))}

        {term && !exact && (
          <button
            type="button"
            disabled={busy}
            onClick={() => send({ new_name: term, label: term })}
            className="flex w-full items-center gap-3 rounded-[14px] border border-dashed border-accent/60 px-4 py-3.5 text-left active:bg-accent/10 disabled:opacity-40"
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-on-accent">
              <Plus className="h-5 w-5" strokeWidth={2.6} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block t-headline text-accent">Create team “{term}”</span>
              <span className="block t-footnote text-label2">New team, {person.name} is the first member</span>
            </span>
          </button>
        )}

        {board && (
          <ul className="overflow-hidden rounded-[14px] bg-bg2" aria-label="Teams">
            {teams.length === 0 && <li className="px-4 py-6 text-center t-subhead text-label2">{term ? "No team with that name or member." : "No teams yet. Type a name to create one."}</li>}
            {teams.map((t, i) => {
              const full = t.count >= max;
              const mine = current?.id === t.id;
              return (
                <li key={t.id} className={`flex items-center gap-3 px-4 py-3 ${i ? "border-t border-sep/60" : ""} ${full && !mine ? "opacity-50" : ""}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block t-headline">{t.name}</span>
                    <span className="block t-footnote text-label2">
                      {teamLine(t, max)}
                      {t.members.length > 0 && ` · ${t.members.map((m) => (m.attendee_id ? m.name : `${m.name} (reserved)`)).join(", ")}`}
                    </span>
                  </span>
                  {mine ? (
                    <span className="t-footnote font-semibold text-sys-green">Their team</span>
                  ) : full ? (
                    <span className="t-footnote font-semibold text-label2">Full</span>
                  ) : (
                    <Button size="small" disabled={busy} onClick={() => send({ team_id: t.id, label: t.name })}>
                      Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Sheet
        open={ask?.kind === "similar"}
        onClose={() => setAsk(null)}
        title={ask?.kind === "similar" ? `“${ask.name}” looks like an existing team` : undefined}
        message="Same team? Use it instead of making a second one."
      >
        {ask?.kind === "similar" &&
          ask.suggestions.map((s) => (
            <SheetAction key={s.id} disabled={busy} onClick={() => { setAsk(null); void send({ team_id: s.id, label: s.name }); }}>
              Add to {s.name} ({s.count}/{max})
            </SheetAction>
          ))}
        {ask?.kind === "similar" && (
          <SheetAction disabled={busy} onClick={() => { const name = ask.name; setAsk(null); void send({ new_name: name, force: true, label: name }); }}>
            No, create “{ask.name}”
          </SheetAction>
        )}
      </Sheet>
      <Sheet open={ask?.kind === "other"} onClose={() => setAsk(null)} title={ask?.kind === "other" ? `${person.name} is already in ${ask.current}` : undefined} message="Move them? They leave their current team.">
        {ask?.kind === "other" && (
          <SheetAction disabled={busy} onClick={() => { const t = ask.target; setAsk(null); void send(t, true); }}>
            Move to {ask.target.label}
          </SheetAction>
        )}
      </Sheet>
    </div>
  );
}

/** Small "team" line for check-in results: "Team Null Pointers · 3 of 4 here". */
export function TeamBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <UsersRound className="h-[1em] w-[1em]" strokeWidth={2.4} aria-hidden />
      {name}
    </span>
  );
}
