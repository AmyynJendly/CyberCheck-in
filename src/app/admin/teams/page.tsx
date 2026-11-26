"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { AdminTitle } from "@/components/admin/AdminShell";
import { useBoard } from "@/components/Teams";
import { MenuSelect, NeedEvent, Notice, Row, Section, Spinner, Toggle, btn } from "@/components/ui";

type Msg = { tone: "ok" | "error"; text: string } | null;

export default function AdminTeamsPage() {
  const { event, refresh } = useApp();
  const { board, reload } = useBoard(event?.id, 10_000);
  const [max, setMax] = useState(4);
  const [smallOk, setSmallOk] = useState(true);
  const [prompt, setPrompt] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  useEffect(() => {
    if (!event) return;
    setMax(event.team_max);
    setSmallOk(event.team_small_ok);
    setPrompt(event.team_prompt);
  }, [event]);

  const save = async (patch: Record<string, unknown>, ok: string, undo: () => void) => {
    if (!event) return;
    setMsg(null);
    try {
      await api(`/api/admin/events/${event.id}`, { method: "PATCH", body: patch });
      setMsg({ tone: "ok", text: ok });
      await Promise.all([refresh(), reload()]);
    } catch (e) {
      undo();
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  };

  if (!event)
    return (
      <>
        <AdminTitle title="Teams" />
        <NeedEvent />
      </>
    );

  const teams = board?.teams ?? [];
  const fullTeams = teams.filter((t) => t.count >= max).length;
  const teamless = (board?.here ?? []).filter((p) => !p.team_id).length;
  const reserved = teams.reduce((n, t) => n + t.members.filter((m) => !m.attendee_id).length, 0);
  const over = teams.filter((t) => t.count > max);

  return (
    <>
      <AdminTitle
        title="Teams"
        subtitle="CTF teams: size rules, the team question after check-in, and the team list download."
        actions={
          <a className={btn("filled")} href={`/api/events/${event.id}/teams.csv`}>
            <Download className="h-4 w-4" aria-hidden /> Download Teams
          </a>
        }
      />
      <div className="max-w-2xl space-y-8">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {over.length > 0 && (
          <Notice tone="error">
            {over.length} team{over.length === 1 ? " has" : "s have"} more than {max} members ({over.map((t) => t.name).join(", ")}). Remove someone in <Link href="/teams">Teams</Link>.
          </Notice>
        )}
        {!board ? (
          <Spinner />
        ) : (
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["Teams", teams.length],
              ["Full", `${fullTeams} / ${teams.length}`],
              ["Here, no team", teamless],
              ["Reserved spots", reserved],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[14px] bg-bg2 p-4">
                <p className="t-footnote text-label2">{label}</p>
                <p className="t-title2 tabular mt-1">{value}</p>
              </div>
            ))}
          </section>
        )}

        <Section
          header="Rules"
          footer={`A team can never have more than ${max} people (reserved spots count). With “smaller teams can play” off, teams under ${max} are marked “needs N” on the Teams screen and in the download.`}
        >
          <Row
            title="Max team size"
            trailing={
              <MenuSelect
                label="Max team size"
                value={String(max)}
                onChange={(v) => {
                  const prev = max;
                  setMax(Number(v));
                  void save({ team_max: Number(v) }, `Max team size: ${v}.`, () => setMax(prev));
                }}
                options={[2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} people` }))}
              />
            }
          />
          <Row
            title={`Teams of 1–${max - 1} can play`}
            trailing={
              <Toggle
                label="Smaller teams can play"
                checked={smallOk}
                onChange={(v) => {
                  setSmallOk(v);
                  void save({ team_small_ok: v }, v ? "Smaller teams can play." : `Teams need ${max} people to play.`, () => setSmallOk(!v));
                }}
              />
            }
          />
        </Section>

        <Section
          header="At the door"
          footer="On: after the green check-in screen, HR is asked to put people without a team in one (Add to Team / Later). Off: scanning works exactly as before; teams are still managed from the Teams screen. Turn it off if the door gets too slow."
        >
          <Row
            title="Ask for a team after check-in"
            trailing={
              <Toggle
                label="Ask for a team after check-in"
                checked={prompt}
                onChange={(v) => {
                  setPrompt(v);
                  void save({ team_prompt: v }, v ? "HR is asked for a team after each check-in (people without one)." : "The team question is off.", () => setPrompt(!v));
                }}
              />
            }
          />
          <Row title="Open the Teams screen" subtitle="The same screen HR uses: free spots, people without a team, move, remove, rename." href="/teams" chevron />
        </Section>
      </div>
    </>
  );
}
