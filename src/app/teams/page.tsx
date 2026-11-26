"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { Button, NeedEvent, Notice, Page, SearchField, Sheet, SheetAction, Spinner, TextField, fmtTime } from "@/components/ui";
import { ClosedTag, TeamPicker, addPerson, teamLine, useBoard, type Board, type BoardMember, type BoardTeam, type TeamPerson } from "@/components/Teams";

type Msg = { tone: "ok" | "warn" | "error"; text: string };

function statusOf(t: BoardTeam, s: Board["settings"]): { label: string; cls: string } {
  if (t.count >= s.team_max) return { label: "Full", cls: "bg-sys-green/15 text-sys-green" };
  return s.team_small_ok
    ? { label: `${s.team_max - t.count} free`, cls: "bg-sys-orange/15 text-sys-orange" }
    : { label: `Needs ${s.team_max - t.count}`, cls: "bg-sys-red/15 text-sys-red" };
}

export default function TeamsPage() {
  const { event, activeDay } = useApp();
  const { board, error, reload } = useBoard(event?.id, 10_000);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [picking, setPicking] = useState<{ person: TeamPerson; move: boolean } | null>(null);
  const [adding, setAdding] = useState<{ team: BoardTeam; reserved?: BoardMember } | null>(null);
  const [removing, setRemoving] = useState<{ team: BoardTeam; member: BoardMember } | null>(null);
  const [renaming, setRenaming] = useState<BoardTeam | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const term = q.trim().toLowerCase();
  const max = board?.settings.team_max ?? 4;
  const teams = useMemo(
    () => (board?.teams ?? []).filter((t) => !term || t.name.toLowerCase().includes(term) || t.members.some((m) => m.name.toLowerCase().includes(term))),
    [board, term],
  );
  const notFull = teams.filter((t) => t.count < max && !t.closed);
  const closed = teams.filter((t) => t.count < max && t.closed);
  const full = teams.filter((t) => t.count >= max);
  const teamless = useMemo(() => (board?.here ?? []).filter((p) => !p.team_id && (!term || p.name.toLowerCase().includes(term))), [board, term]);

  const done = async (m: string | null) => {
    if (m) setMsg({ tone: "ok", text: m });
    await reload();
  };

  const toggleClosed = async (t: BoardTeam) => {
    setBusy(true);
    try {
      await api("/api/teams/closed", { body: { team_id: t.id, closed: !t.closed } });
      setMsg({ tone: "ok", text: t.closed ? `${t.name} is open: others can join.` : `${t.name} is closed: only their friends join.` });
      await reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api("/api/teams/remove", { body: { member_id: removing.member.member_id } });
      const { member, team } = removing;
      setMsg({ tone: "ok", text: member.attendee_id && member.reserved_name ? `${member.name} left ${team.name}; the spot is reserved for “${member.reserved_name}” again.` : `${member.name} removed from ${team.name}.` });
      setRemoving(null);
      await reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!event)
    return (
      <Page title="Teams">
        <NeedEvent />
      </Page>
    );

  return (
    <Page title="Teams">
      <div className="-mt-3 space-y-3">
        <SearchField value={q} onChange={setQ} placeholder="Team or member name" />
        {board && (
          <p className="t-footnote px-1 text-label2">
            {board.teams.length} teams · {board.teams.filter((t) => t.count >= max).length} full · {board.teams.filter((t) => t.closed && t.count < max).length} closed · max {max} per team
            {board.settings.team_small_ok ? " · smaller teams can play" : " · teams must be full to play"}
          </p>
        )}
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!board && !error && <Spinner />}
      {board && !activeDay && <Notice tone="warn">No session today: nobody counts as “here”.</Notice>}

      {board && (
        <>
          <section>
            <h2 className="t-footnote mb-1.5 px-4 uppercase text-label2">Here without a team ({teamless.length})</h2>
            <div className="overflow-hidden rounded-[12px] bg-bg2">
              {teamless.length === 0 && <p className="px-4 py-3 t-subhead text-label2">{term ? "Nobody with that name." : "Everyone checked in today has a team."}</p>}
              {teamless.map((p, i) => (
                <button
                  key={p.attendee_id}
                  type="button"
                  onClick={() => setPicking({ person: p, move: false })}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-bg4 ${i ? "border-t border-sep/60" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block t-body">{p.name}</span>
                    <span className="block t-footnote text-label2">Checked in at {fmtTime(p.checked_at)}</span>
                  </span>
                  <span className="t-subhead font-semibold text-accent">Add to Team</span>
                </button>
              ))}
            </div>
          </section>

          <TeamList title={`Teams with free spots (${notFull.length})`} teams={notFull} board={board} open={open} setOpen={setOpen}
            onAdd={(team) => setAdding({ team })} onClaim={(team, reserved) => setAdding({ team, reserved })}
            onMove={(m) => setPicking({ person: { attendee_id: m.attendee_id!, name: m.name }, move: true })}
            onRemove={(team, member) => setRemoving({ team, member })} onRename={setRenaming} onToggle={(t) => void toggleClosed(t)} busy={busy} empty={term ? "No team matches." : "No open team has a free spot."} />
          {closed.length > 0 && (
            <TeamList title={`Closed teams (${closed.length})`} teams={closed} board={board} open={open} setOpen={setOpen}
              onAdd={(team) => setAdding({ team })} onClaim={(team, reserved) => setAdding({ team, reserved })}
              onMove={(m) => setPicking({ person: { attendee_id: m.attendee_id!, name: m.name }, move: true })}
              onRemove={(team, member) => setRemoving({ team, member })} onRename={setRenaming} onToggle={(t) => void toggleClosed(t)} busy={busy} empty="" />
          )}
          <TeamList title={`Full teams (${full.length})`} teams={full} board={board} open={open} setOpen={setOpen}
            onAdd={(team) => setAdding({ team })} onClaim={(team, reserved) => setAdding({ team, reserved })}
            onMove={(m) => setPicking({ person: { attendee_id: m.attendee_id!, name: m.name }, move: true })}
            onRemove={(team, member) => setRemoving({ team, member })} onRename={setRenaming} onToggle={(t) => void toggleClosed(t)} busy={busy} empty={term ? "No team matches." : "No full team yet."} />
        </>
      )}

      {picking && (
        <TeamPicker
          eventId={event.id}
          person={picking.person}
          move={picking.move}
          onClose={(m) => {
            setPicking(null);
            void done(m);
          }}
        />
      )}
      {adding && board && (
        <AddMembers
          eventId={event.id}
          board={board}
          team={adding.team}
          reserved={adding.reserved}
          onClose={(m) => {
            setAdding(null);
            void done(m);
          }}
        />
      )}
      <Sheet
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.member.name} from ${removing.team.name}?` : undefined}
        message={removing?.member.attendee_id && removing.member.reserved_name ? `The spot goes back to “${removing.member.reserved_name}” (reserved).` : removing && !removing.member.attendee_id ? "This frees the reserved spot for someone else." : "Their spot becomes free."}
      >
        <SheetAction destructive disabled={busy} onClick={() => void remove()}>
          Remove
        </SheetAction>
      </Sheet>
      {renaming && <RenameSheet team={renaming} onClose={(m) => { setRenaming(null); void done(m); }} />}
    </Page>
  );
}

function TeamList(props: {
  title: string;
  teams: BoardTeam[];
  board: Board;
  open: string | null;
  setOpen: (id: string | null) => void;
  onAdd: (t: BoardTeam) => void;
  onClaim: (t: BoardTeam, m: BoardMember) => void;
  onMove: (m: BoardMember) => void;
  onRemove: (t: BoardTeam, m: BoardMember) => void;
  onRename: (t: BoardTeam) => void;
  onToggle: (t: BoardTeam) => void;
  busy: boolean;
  empty: string;
}) {
  const { teams, board, open, setOpen } = props;
  const s = board.settings;
  return (
    <section>
      <h2 className="t-footnote mb-1.5 px-4 uppercase text-label2">{props.title}</h2>
      <div className="space-y-2.5">
        {teams.length === 0 && <p className="rounded-[12px] bg-bg2 px-4 py-3 t-subhead text-label2">{props.empty}</p>}
        {teams.map((t) => {
          const st = statusOf(t, s);
          const isOpen = open === t.id;
          return (
            <article key={t.id} className="overflow-hidden rounded-[12px] bg-bg2">
              <button type="button" onClick={() => setOpen(isOpen ? null : t.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-bg4" aria-expanded={isOpen}>
                <span className="min-w-0 flex-1">
                  <span className="block t-headline">{t.name}</span>
                  <span className="block t-footnote text-label2">
                    {t.closed && <ClosedTag />}
                    {teamLine(t, s.team_max)}
                  </span>
                </span>
                <span className={`rounded-full px-2.5 py-0.5 t-footnote font-semibold ${st.cls}`}>{st.label}</span>
                {isOpen ? <ChevronUp className="h-5 w-5 text-label3" aria-hidden /> : <ChevronDown className="h-5 w-5 text-label3" aria-hidden />}
              </button>
              {!isOpen && (
                <p className="-mt-1.5 px-4 pb-3 t-footnote text-label2">
                  {t.members.map((m) => (m.attendee_id ? m.name : `${m.name} (reserved)`)).join(", ")}
                </p>
              )}
              {isOpen && (
                <div className="border-t border-sep/60">
                  {t.members.map((m) => (
                    <div key={m.member_id} className="flex items-center gap-2.5 border-b border-sep/40 px-4 py-2.5 last:border-b-0">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${m.here ? "bg-sys-green" : m.attendee_id ? "bg-label3" : "border border-dashed border-label2"}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block t-subhead">{m.name}</span>
                        <span className="block t-caption text-label2">
                          {!m.attendee_id ? "Reserved · not registered yet" : m.here ? "Here today" : "Not here"}
                          {m.attendee_id && m.reserved_name && m.reserved_name !== m.name ? ` · sheet: ${m.reserved_name}` : ""}
                        </span>
                      </span>
                      {m.attendee_id ? (
                        <Button size="small" variant="gray" onClick={() => props.onMove(m)}>
                          Move
                        </Button>
                      ) : (
                        <Button size="small" variant="tinted" onClick={() => props.onClaim(t, m)}>
                          This is them
                        </Button>
                      )}
                      <Button size="small" variant="destructive" onClick={() => props.onRemove(t, m)}>
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2 px-4 py-3">
                    {t.count < s.team_max && (
                      <Button className="basis-full" onClick={() => props.onAdd(t)}>
                        Add Members
                      </Button>
                    )}
                    <Button className="flex-1" variant="gray" onClick={() => props.onRename(t)}>
                      Rename
                    </Button>
                    <Button className="flex-1" variant="gray" disabled={props.busy} onClick={() => props.onToggle(t)}>
                      {t.closed ? "Open Team" : "Close Team"}
                    </Button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Add Members to a team (or give a reserved spot): people here without a team first; search finds people in other teams (Move). */
function AddMembers({ eventId, board, team, reserved, onClose }: { eventId: string; board: Board; team: BoardTeam; reserved?: BoardMember; onClose: (m: string | null) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [count, setCount] = useState(team.count);
  const [added, setAdded] = useState<string[]>([]);
  const max = board.settings.team_max;
  const term = q.trim().toLowerCase();
  const teamName = (id: string | null) => board.teams.find((t) => t.id === id)?.name ?? "";
  const people = board.here.filter((p) => p.team_id !== team.id && !added.includes(p.attendee_id) && (!term || p.name.toLowerCase().includes(term)));
  const free = people.filter((p) => !p.team_id);
  const others = term ? people.filter((p) => p.team_id) : [];

  const add = async (p: { attendee_id: string; name: string; team_id: string | null }) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await addPerson({ event_id: eventId, attendee_id: p.attendee_id, team_id: team.id, reserved_id: reserved?.member_id, move: !!p.team_id });
      if (r.status === "OK") {
        if (reserved) return onClose(`${p.name} took the spot of “${reserved.reserved_name}” in ${team.name}.`);
        setAdded((a) => [...a, p.attendee_id]);
        setCount(r.team.count);
        if (r.team.count >= r.team.max) return onClose(`${team.name} is now full (${r.team.count}/${r.team.max}).`);
        setMsg(`${p.name} added (${r.team.count}/${r.team.max}).`);
      } else if (r.status === "FULL") return onClose(`${team.name} is full (${r.team.count}/${r.team.max}).`);
      else if (r.status === "ALREADY_IN_TEAM") setMsg(`${p.name} is already in ${team.name}.`);
      else if (r.status === "IN_OTHER_TEAM") setMsg(`${p.name} is in ${r.team.name}. Use Move.`);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const row = (p: { attendee_id: string; name: string; team_id: string | null }, i: number) => (
    <li key={p.attendee_id} className={`flex items-center gap-3 px-4 py-3 ${i ? "border-t border-sep/60" : ""}`}>
      <span className="min-w-0 flex-1">
        <span className="block t-body">{p.name}</span>
        <span className="block t-footnote text-label2">{p.team_id ? `In ${teamName(p.team_id)}` : "Here, no team"}</span>
      </span>
      <Button size="small" variant={p.team_id ? "gray" : "filled"} disabled={busy} onClick={() => void add(p)}>
        {p.team_id ? "Move here" : "Add"}
      </Button>
    </li>
  );

  return (
    <div className="anim-fade fixed inset-0 z-[80] flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label={`Add members to ${team.name}`}>
      <div className="flex items-center gap-3 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1">
          <p className="t-footnote uppercase text-label2">{reserved ? `Spot reserved for “${reserved.reserved_name}”` : `Add members · ${count} of ${max}`}</p>
          <p className="t-title2 truncate">{team.name}</p>
        </div>
        <Button variant="gray" onClick={() => onClose(added.length ? `${added.length} added to ${team.name}.` : null)}>
          Done
        </Button>
      </div>
      <div className="px-4 pb-3">
        <SearchField value={q} onChange={setQ} placeholder="Search by name" autoFocus />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {msg && <Notice tone="info">{msg}</Notice>}
        {team.closed && <Notice tone="warn">{team.name} is closed: add only their friends.</Notice>}
        <section>
          <h2 className="t-footnote mb-1.5 px-4 uppercase text-label2">Here without a team</h2>
          <ul className="overflow-hidden rounded-[12px] bg-bg2">
            {free.length === 0 && <li className="px-4 py-3 t-subhead text-label2">{term ? "Nobody here without a team has that name." : "Everyone here already has a team."}</li>}
            {free.map(row)}
          </ul>
        </section>
        {others.length > 0 && (
          <section>
            <h2 className="t-footnote mb-1.5 px-4 uppercase text-label2">Here, in another team</h2>
            <ul className="overflow-hidden rounded-[12px] bg-bg2">{others.map(row)}</ul>
          </section>
        )}
        <p className="px-1 t-footnote text-label2">Only people checked in today are listed. Not registered? Use Add Person first.</p>
      </div>
    </div>
  );
}

function RenameSheet({ team, onClose }: { team: BoardTeam; onClose: (m: string | null) => void }) {
  const [name, setName] = useState(team.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/teams/rename", { body: { team_id: team.id, name } });
      onClose(`Renamed to ${name.trim()}.`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={() => onClose(null)} title={`Rename ${team.name}`}>
      <div className="space-y-2 border-t border-sep/60 p-3">
        <div className="rounded-[10px] bg-bg4 px-3">
          <TextField value={name} onChange={(e) => setName(e.target.value)} aria-label="Team name" autoFocus />
        </div>
        {err && <Notice tone="error">{err}</Notice>}
      </div>
      <SheetAction disabled={busy || !name.trim() || name.trim() === team.name} onClick={() => void save()}>
        Save
      </SheetAction>
    </Sheet>
  );
}
