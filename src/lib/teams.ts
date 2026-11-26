// Teams (CTF day). A person is in at most one team (unique index); a team has at
// most `events.team_max` spots, counted under a row lock on the team, so two
// phones can never both take the last spot. A spot can be reserved for a name
// from the team sheet (reserved_name) until that person is given it ("claimed").
// attendees.team_name is kept in sync so the check-in screen, CSV and report
// show the real team.
import type { PoolClient } from "pg";
import { query, withTransaction, isUniqueViolation } from "./db";
import { HttpError } from "./http";
import { audit } from "./audit";
import { cleanText } from "./validate";
import { tunisDate } from "./time";
import type { Staff } from "./auth";

export { teamKey, similarTeam } from "./team-names";
import { teamKey, similarTeam } from "./team-names";

export interface TeamSettings {
  team_max: number;
  team_small_ok: boolean;
  team_prompt: boolean;
}

async function settings(eventId: string, c?: PoolClient): Promise<TeamSettings> {
  const r = await query<TeamSettings>("select team_max, team_small_ok, team_prompt from events where id = $1", [eventId], c);
  if (!r.rows[0]) throw new HttpError(404, "EVENT_NOT_FOUND", "Event not found.");
  return r.rows[0];
}

/** The day "here" means: the given day, else today's event day, else (for exports after the event) the last day. */
async function boardDay(eventId: string, dayId: string | null, fallbackToLast = false): Promise<string | null> {
  if (dayId) return dayId;
  const r = await query<{ id: string }>(
    `select id from event_days where event_id = $1 and (day_date = $2 or ($3 and day_date <= $2)) order by day_date desc limit 1`,
    [eventId, tunisDate(), fallbackToLast],
  );
  return r.rows[0]?.id ?? null;
}

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

/** Everything the Teams screen and the team picker need, in one call (a few dozen teams). */
export async function teamBoard(eventId: string, dayId: string | null) {
  const s = await settings(eventId);
  const day = await boardDay(eventId, dayId);
  const teams = await query<BoardTeam>(
    `select t.id, t.name,
            count(m.id)::int as count,
            count(ci.id)::int as here,
            coalesce(json_agg(json_build_object(
                'member_id', m.id, 'attendee_id', m.attendee_id,
                'name', coalesce(a.full_name, m.reserved_name), 'reserved_name', m.reserved_name,
                'here', ci.id is not null, 'source', m.source)
              order by (ci.id is null), coalesce(a.full_name, m.reserved_name)) filter (where m.id is not null), '[]') as members
       from teams t
       left join team_members m on m.team_id = t.id
       left join attendees a on a.id = m.attendee_id
       left join checkins ci on ci.attendee_id = m.attendee_id and ci.event_day_id = $2 and ci.undone_at is null
      where t.event_id = $1
      group by t.id
      order by lower(t.name)`,
    [eventId, day],
  );
  const here = day
    ? await query<HerePerson>(
        `select a.id as attendee_id, a.full_name as name, m.team_id, ci.checked_at
           from checkins ci
           join attendees a on a.id = ci.attendee_id
           left join team_members m on m.attendee_id = a.id
          where ci.event_day_id = $1 and ci.undone_at is null and a.event_id = $2
          order by ci.checked_at desc`,
        [day, eventId],
      )
    : { rows: [] as HerePerson[] };
  return { settings: s, day_id: day, teams: teams.rows, here: here.rows };
}

type AddResult =
  | { status: "OK"; team: { id: string; name: string; count: number; max: number }; moved_from?: string | null; created?: boolean }
  | { status: "ALREADY_IN_TEAM"; team: { id: string; name: string } }
  | { status: "IN_OTHER_TEAM"; team: { id: string; name: string } }
  | { status: "FULL"; team: { id: string; name: string; count: number; max: number } }
  | { status: "SIMILAR"; name: string; suggestions: { id: string; name: string; count: number }[] };

/** Lock the given teams in a fixed order (no deadlocks when two phones move people both ways). */
async function lockTeams(c: PoolClient, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  if (unique.length) await c.query("select id from teams where id = any($1::uuid[]) order by id for update", [unique]);
}

const memberCount = async (c: PoolClient, teamId: string) =>
  (await c.query<{ n: number }>("select count(*)::int as n from team_members where team_id = $1", [teamId])).rows[0].n;

/** Delete teams left without any member or reserved spot. */
async function dropEmptyTeams(c: PoolClient, ids: (string | null | undefined)[], staff: Staff | null, eventId: string) {
  const list = ids.filter(Boolean) as string[];
  if (!list.length) return;
  const gone = await c.query<{ id: string; name: string }>(
    "delete from teams t where t.id = any($1::uuid[]) and not exists (select 1 from team_members m where m.team_id = t.id) returning id, name",
    [list],
  );
  for (const t of gone.rows) await audit({ staffId: staff?.id ?? null, action: "team_delete", eventId, details: { team_id: t.id, name: t.name, reason: "empty" } }, c);
}

/**
 * Put a person in a team: an existing one (team_id), a new or existing one by name
 * (new_name; similar names ask first unless force), or a reserved spot (reserved_id).
 * move=true takes them out of their current team first.
 */
export async function addToTeam(
  staff: Staff,
  p: { eventId: string; attendeeId: string; teamId?: string | null; newName?: unknown; force?: boolean; move?: boolean; reservedId?: string | null },
): Promise<AddResult> {
  try {
    return await withTransaction(async (c) => {
      const a = (await c.query<{ id: string; full_name: string }>("select id, full_name from attendees where id = $1 and event_id = $2", [p.attendeeId, p.eventId])).rows[0];
      if (!a) throw new HttpError(404, "ATTENDEE_NOT_FOUND", "That person isn't registered for this event.");
      const s = await settings(p.eventId, c);

      // Which team?
      let teamId = p.teamId ?? null;
      let created = false;
      if (!teamId) {
        const name = cleanText(p.newName, 60);
        if (!name) throw new HttpError(400, "BAD_REQUEST", "Type a team name.");
        const key = teamKey(name);
        if (!key) throw new HttpError(400, "BAD_TEAM_NAME", "A team name needs letters or numbers.");
        const all = (await c.query<{ id: string; name: string; name_key: string; count: number }>(
          "select t.id, t.name, t.name_key, (select count(*)::int from team_members m where m.team_id = t.id) as count from teams t where t.event_id = $1",
          [p.eventId],
        )).rows;
        const exact = all.find((t) => t.name_key === key);
        if (exact) teamId = exact.id;
        else {
          const similar = all.filter((t) => similarTeam(t.name, name));
          if (similar.length && !p.force) return { status: "SIMILAR", name, suggestions: similar.map(({ id, name: n, count }) => ({ id, name: n, count })) };
          const ins = await c.query<{ id: string }>(
            "insert into teams (event_id, name, name_key, created_by_staff_id) values ($1, $2, $3, $4) on conflict (event_id, name_key) do nothing returning id",
            [p.eventId, name, key, staff.id],
          );
          if (ins.rows[0]) {
            teamId = ins.rows[0].id;
            created = true;
            await audit({ staffId: staff.id, action: "team_create", eventId: p.eventId, details: { team_id: teamId, name } }, c);
          } else {
            teamId = (await c.query<{ id: string }>("select id from teams where event_id = $1 and name_key = $2", [p.eventId, key])).rows[0].id; // created by another phone just now
          }
        }
      }

      const current = (await c.query<{ id: string; team_id: string; reserved_name: string | null }>("select id, team_id, reserved_name from team_members where attendee_id = $1", [a.id])).rows[0];
      await lockTeams(c, [teamId, current?.team_id].filter(Boolean) as string[]);
      const team = (await c.query<{ id: string; name: string }>("select id, name from teams where id = $1 and event_id = $2", [teamId, p.eventId])).rows[0];
      if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "That team doesn't exist any more.");

      if (current?.team_id === team.id) return { status: "ALREADY_IN_TEAM", team };
      if (current && !p.move) {
        const other = (await c.query<{ id: string; name: string }>("select id, name from teams where id = $1", [current.team_id])).rows[0];
        return { status: "IN_OTHER_TEAM", team: other };
      }

      // Is there a spot? (A reserved spot is already counted.)
      let count = await memberCount(c, team.id);
      if (p.reservedId) {
        const spot = await c.query("select 1 from team_members where id = $1 and team_id = $2 and attendee_id is null", [p.reservedId, team.id]);
        if (!spot.rowCount) throw new HttpError(409, "SPOT_TAKEN", "That reserved spot was just given to someone else.");
      } else if (count >= s.team_max) return { status: "FULL", team: { ...team, count, max: s.team_max } };

      // Leaving the old team first (move), so the one-team rule holds at every step.
      // A claimed reserved spot goes back to reserved. All of this is one transaction.
      let movedFrom: string | null = null;
      if (current) {
        if (current.reserved_name) await c.query("update team_members set attendee_id = null, claimed_at = null where id = $1", [current.id]);
        else await c.query("delete from team_members where id = $1", [current.id]);
        movedFrom = (await c.query<{ name: string }>("select name from teams where id = $1", [current.team_id])).rows[0]?.name ?? null;
      }

      // Take the spot.
      if (p.reservedId) {
        await c.query("update team_members set attendee_id = $2, claimed_at = now(), added_by_staff_id = $3 where id = $1", [p.reservedId, a.id, staff.id]);
      } else {
        await c.query("insert into team_members (team_id, attendee_id, source, added_by_staff_id) values ($1, $2, 'door', $3)", [team.id, a.id, staff.id]);
        count++;
      }
      if (current) await dropEmptyTeams(c, [current.team_id], staff, p.eventId);
      await c.query("update attendees set team_name = $2, updated_at = now() where id = $1", [a.id, team.name]);
      await audit(
        {
          staffId: staff.id,
          action: current ? "team_move" : "team_add",
          eventId: p.eventId,
          attendeeId: a.id,
          details: { team_id: team.id, team: team.name, ...(p.reservedId ? { reserved_spot: true } : {}), ...(movedFrom ? { from: movedFrom } : {}) },
        },
        c,
      );
      return { status: "OK", team: { ...team, count, max: s.team_max }, moved_from: movedFrom, created };
    });
  } catch (err) {
    // Two phones put the same person in two teams at the same moment: one wins.
    if (isUniqueViolation(err, "team_members_one_team")) {
      const t = (await query<{ id: string; name: string }>("select t.id, t.name from team_members m join teams t on t.id = m.team_id where m.attendee_id = $1", [p.attendeeId])).rows[0];
      if (t) return { status: "IN_OTHER_TEAM", team: t };
    }
    throw err;
  }
}

/**
 * Two people trade places (e.g. both teams are full). One transaction: each takes
 * the other's spot; a reserved/sheet spot stays with its team.
 */
export async function swapMembers(staff: Staff, p: { eventId: string; attendeeA: string; attendeeB: string }) {
  if (p.attendeeA === p.attendeeB) throw new HttpError(400, "BAD_REQUEST", "Pick two different people.");
  return withTransaction(async (c) => {
    type M = { id: string; team_id: string; team: string; attendee_id: string; full_name: string };
    const load = async () =>
      (await c.query<M>(
        `select m.id, m.team_id, t.name as team, m.attendee_id, a.full_name
           from team_members m join teams t on t.id = m.team_id join attendees a on a.id = m.attendee_id
          where m.attendee_id = any($1::uuid[]) and t.event_id = $2`,
        [[p.attendeeA, p.attendeeB], p.eventId],
      )).rows;
    let rows = await load();
    if (rows.length !== 2) throw new HttpError(409, "NOT_BOTH_IN_TEAMS", "Both people must be in a team to swap.");
    await lockTeams(c, rows.map((r) => r.team_id));
    rows = await load(); // again, under the locks
    const a = rows.find((r) => r.attendee_id === p.attendeeA);
    const b = rows.find((r) => r.attendee_id === p.attendeeB);
    if (!a || !b) throw new HttpError(409, "CHANGED", "Someone just changed teams. Try again.");
    if (a.team_id === b.team_id) throw new HttpError(409, "SAME_TEAM", "They're already in the same team.");
    // Swap the people on the two spots (park B for a moment: one team per person holds at every step).
    const parked = (await c.query<{ reserved_name: string | null }>("select reserved_name from team_members where id = $1", [b.id])).rows[0];
    await c.query("delete from team_members where id = $1", [b.id]);
    await c.query(
      "update team_members set attendee_id = $2, source = 'door', added_at = now(), claimed_at = case when reserved_name is null then null else now() end, added_by_staff_id = $3 where id = $1",
      [a.id, p.attendeeB, staff.id],
    );
    await c.query(
      "insert into team_members (id, team_id, attendee_id, reserved_name, source, added_by_staff_id, claimed_at) values ($1, $2, $3, $4, 'door', $5, case when $4::text is null then null else now() end)",
      [b.id, b.team_id, p.attendeeA, parked.reserved_name, staff.id],
    );
    await c.query("update attendees set team_name = $2, updated_at = now() where id = $1", [p.attendeeA, b.team]);
    await c.query("update attendees set team_name = $2, updated_at = now() where id = $1", [p.attendeeB, a.team]);
    for (const [who, from, to] of [[a, a.team, b.team], [b, b.team, a.team]] as const)
      await audit({ staffId: staff.id, action: "team_move", eventId: p.eventId, attendeeId: who.attendee_id, details: { from, team: to, swap: true } }, c);
    return { ok: true, message: `${a.full_name} → ${b.team}, ${b.full_name} → ${a.team}` };
  });
}

/** Remove a member. A claimed reserved spot goes back to "reserved"; removing a reserved spot frees it. */
export async function removeFromTeam(staff: Staff, memberId: string) {
  return withTransaction(async (c) => {
    const m = (await c.query<{ id: string; team_id: string; attendee_id: string | null; reserved_name: string | null; event_id: string; team: string }>(
      "select m.id, m.team_id, m.attendee_id, m.reserved_name, t.event_id, t.name as team from team_members m join teams t on t.id = m.team_id where m.id = $1",
      [memberId],
    )).rows[0];
    if (!m) throw new HttpError(404, "MEMBER_NOT_FOUND", "Already removed.");
    await lockTeams(c, [m.team_id]);
    let freed: "person" | "reserved_spot";
    if (m.attendee_id && m.reserved_name) {
      await c.query("update team_members set attendee_id = null, claimed_at = null where id = $1", [m.id]);
      freed = "person";
    } else {
      await c.query("delete from team_members where id = $1", [m.id]);
      freed = m.attendee_id ? "person" : "reserved_spot";
    }
    if (m.attendee_id) await c.query("update attendees set team_name = null, updated_at = now() where id = $1", [m.attendee_id]);
    await audit({ staffId: staff.id, action: "team_remove", eventId: m.event_id, attendeeId: m.attendee_id, details: { team_id: m.team_id, team: m.team, removed: freed, reserved_name: m.reserved_name } }, c);
    await dropEmptyTeams(c, [m.team_id], staff, m.event_id);
    return { ok: true };
  });
}

export async function renameTeam(staff: Staff, teamId: string, rawName: unknown) {
  const name = cleanText(rawName, 60);
  if (!name || !teamKey(name)) throw new HttpError(400, "BAD_TEAM_NAME", "Type a team name with letters or numbers.");
  try {
    return await withTransaction(async (c) => {
      const t = (await c.query<{ event_id: string; name: string }>("select event_id, name from teams where id = $1 for update", [teamId])).rows[0];
      if (!t) throw new HttpError(404, "TEAM_NOT_FOUND", "That team doesn't exist any more.");
      await c.query("update teams set name = $2, name_key = $3, updated_at = now() where id = $1", [teamId, name, teamKey(name)]);
      await c.query("update attendees set team_name = $2, updated_at = now() where id in (select attendee_id from team_members where team_id = $1 and attendee_id is not null)", [teamId, name]);
      await audit({ staffId: staff.id, action: "team_rename", eventId: t.event_id, details: { team_id: teamId, from: t.name, to: name } }, c);
      return { ok: true, name };
    });
  } catch (err) {
    if (isUniqueViolation(err, "teams_event_id_name_key_key")) throw new HttpError(409, "TEAM_NAME_TAKEN", "Another team already has this name.");
    throw err;
  }
}

/**
 * Check-in results: add the person's team (and whether to ask for one).
 * Never breaks a check-in: on any error the result goes back unchanged.
 */
export async function withTeam<T extends { status: string; attendee_id?: string; team_name?: string | null }>(eventId: string, result: T) {
  if ((result.status !== "OK" && result.status !== "ALREADY_CHECKED_IN") || !result.attendee_id) return result;
  try {
    const r = await query<{ team_prompt: boolean; team_max: number; in_use: boolean; id: string | null; name: string | null; count: number | null; here: number | null }>(
      `select e.team_prompt, e.team_max,
              exists (select 1 from teams x where x.event_id = e.id) as in_use,
              t.id, t.name,
              (select count(*)::int from team_members y where y.team_id = t.id) as count,
              (select count(*)::int from team_members y
                 join checkins ci on ci.attendee_id = y.attendee_id and ci.undone_at is null
                 join event_days d on d.id = ci.event_day_id and d.day_date = $3
                where y.team_id = t.id) as here
         from events e
         left join team_members m on m.attendee_id = $2
         left join teams t on t.id = m.team_id
        where e.id = $1`,
      [eventId, result.attendee_id, tunisDate()],
    );
    const row = r.rows[0];
    if (!row) return result;
    const team = row.id ? { id: row.id, name: row.name!, count: row.count ?? 0, here: row.here ?? 0, max: row.team_max } : null;
    return {
      ...result,
      ...(row.in_use ? { team_name: team?.name ?? null } : {}),
      team,
      ask_team: row.team_prompt && !team,
    };
  } catch (err) {
    console.error("[teams] withTeam failed", err);
    return result;
  }
}

/** Undo of a check-in: someone put in a team at the door after it (and not here any other day) leaves the team. */
export async function teamsOnUndo(c: PoolClient, checkinId: string, staff: Staff, eventId: string) {
  const cond = `ci.id = $1 and m.attendee_id = ci.attendee_id
                and not exists (select 1 from checkins x where x.attendee_id = ci.attendee_id and x.undone_at is null)`;
  const added = await c.query<{ team_id: string; attendee_id: string }>(
    `delete from team_members m using checkins ci where ${cond} and m.source = 'door' and m.added_at >= ci.checked_at returning m.team_id, m.attendee_id`,
    [checkinId],
  );
  const claimed = await c.query<{ team_id: string; attendee_id: string }>(
    `update team_members m set attendee_id = null, claimed_at = null from checkins ci
      where ${cond} and m.reserved_name is not null and m.claimed_at >= ci.checked_at
      returning m.team_id, ci.attendee_id`,
    [checkinId],
  );
  const left = [...added.rows, ...claimed.rows];
  for (const l of left) {
    await c.query("update attendees set team_name = null, updated_at = now() where id = $1", [l.attendee_id]);
    await audit({ staffId: staff.id, action: "team_remove", eventId, attendeeId: l.attendee_id, details: { team_id: l.team_id, reason: "check-in undone" } }, c);
  }
  await dropEmptyTeams(c, left.map((l) => l.team_id), staff, eventId);
  // A walk-in about to be removed: give back any reserved spot they had claimed earlier.
  return left.length > 0;
}

/** Admin download: one row per member, teams in name order, then people here without a team. */
export async function teamsCsvRows(eventId: string) {
  const day = await boardDay(eventId, null, true);
  const s = await settings(eventId);
  const r = await query<{
    team: string;
    count: number;
    here_count: number;
    name: string;
    reserved: boolean;
    here: boolean;
    email: string | null;
    phone: string | null;
    member: boolean;
    paid: string | null;
    source: string;
  }>(
    `with tm as (
       select t.id, t.name, m.id as mid, m.attendee_id, m.reserved_name, m.source,
              count(*) over (partition by t.id)::int as count,
              count(ci.id) over (partition by t.id)::int as here_count,
              ci.id is not null as here
         from teams t join team_members m on m.team_id = t.id
         left join checkins ci on ci.attendee_id = m.attendee_id and ci.event_day_id = $2 and ci.undone_at is null
        where t.event_id = $1)
     select tm.name as team, tm.count, tm.here_count,
            coalesce(a.full_name, tm.reserved_name) as name, a.id is null as reserved, tm.here,
            a.email, a.phone, a.member_id is not null as member,
            (select string_agg(p.kind || ' ' || p.amount::text || ' DT', ', ') from payments p
              where p.attendee_id = a.id and p.event_day_id = $2 and p.voided_at is null) as paid,
            tm.source
       from tm left join attendees a on a.id = tm.attendee_id
      order by lower(tm.name), tm.here desc, 4`,
    [eventId, day],
  );
  const teamless = day
    ? (await query<{ name: string; email: string | null; phone: string | null; member: boolean }>(
        `select a.full_name as name, a.email, a.phone, a.member_id is not null as member
           from checkins ci join attendees a on a.id = ci.attendee_id
          where ci.event_day_id = $1 and ci.undone_at is null and a.event_id = $2
            and not exists (select 1 from team_members m where m.attendee_id = a.id)
          order by a.full_name`,
        [day, eventId],
      )).rows
    : [];
  return { settings: s, rows: r.rows, teamless };
}

export function teamStatus(count: number, s: Pick<TeamSettings, "team_max" | "team_small_ok">): string {
  if (count >= s.team_max) return count > s.team_max ? `Over the limit (${count}/${s.team_max})` : "Complete";
  return s.team_small_ok ? `Can play (${count}/${s.team_max})` : `Needs ${s.team_max - count} more`;
}
