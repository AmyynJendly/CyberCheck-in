// Teams (CTF day): size limit under races, one team per person, moves, similar names,
// reserved spots from the team sheet, Undo rules, and the team info on check-in answers.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { POST as walkinPOST } from "@/app/api/walkin/route";
import { GET as csvGET } from "@/app/api/events/[id]/teams.csv/route";
import { GET as boardGET } from "@/app/api/events/[id]/teams/route";
import { checkInAttendee, undoCheckin } from "@/lib/checkin";
import { cleanAttendeeFields, ingestFormSubmission } from "@/lib/attendees";
import { addToTeam, removeFromTeam, renameTeam, similarTeam, swapMembers, teamBoard } from "@/lib/teams";
import { closePool, query } from "@/lib/db";
import { body, cookieFor, makeEvent, makeStaff, params, req, tokenOf, uniq } from "./helpers";
import type { Staff } from "@/lib/auth";

let hr: Staff;
let hr2: Staff;
let admin: Staff;

beforeAll(async () => {
  hr = await makeStaff("hr", "Sara");
  hr2 = await makeStaff("hr", "Nour");
  admin = await makeStaff("admin", "Youssef");
});
afterAll(() => closePool());

async function person(eventId: string, name: string) {
  const r = await ingestFormSubmission(eventId, uniq("r"), cleanAttendeeFields({ full_name: name, email: `${uniq("t")}@example.com` }), { resendExisting: false });
  return { id: r.attendeeId, name, token: await tokenOf(r.attendeeId) };
}
const people = (eventId: string, n: number, prefix = "Player") => Promise.all(Array.from({ length: n }, (_, i) => person(eventId, `${prefix} ${i + 1} ${uniq("n")}`)));
const teamOf = async (attendeeId: string) =>
  (await query<{ name: string; team_name: string | null }>("select t.name, a.team_name from attendees a left join team_members m on m.attendee_id = a.id left join teams t on t.id = m.team_id where a.id = $1", [attendeeId])).rows[0];
async function newTeam(eventId: string, attendeeId: string, name: string) {
  const r = await addToTeam(hr, { eventId, attendeeId, newName: name, force: true });
  if (r.status !== "OK") throw new Error(r.status);
  return r.team.id;
}

describe("team names", () => {
  it("spots near-duplicates, not different teams", () => {
    expect(similarTeam("Null Pointers", "null pointer")).toBe(true);
    expect(similarTeam("Null Pointers", "NullPointers")).toBe(true);
    expect(similarTeam("Root Rats", "Root Rat")).toBe(true);
    expect(similarTeam("Root Rats", "Byte Bandits")).toBe(false);
    expect(similarTeam("A1", "A2")).toBe(false);
  });
});

describe("adding people to teams", () => {
  it("create by name, then the same name (any spelling) is the same team; a similar name asks first", async () => {
    const ev = await makeEvent();
    const [a, b, c] = await people(ev.id, 3);
    const first = await addToTeam(hr, { eventId: ev.id, attendeeId: a.id, newName: "Null Pointers" });
    expect(first).toMatchObject({ status: "OK", created: true, team: { name: "Null Pointers", count: 1, max: 4 } });
    const same = await addToTeam(hr, { eventId: ev.id, attendeeId: b.id, newName: "  null   POINTERS " });
    expect(same).toMatchObject({ status: "OK", team: { name: "Null Pointers", count: 2 } });
    const similar = await addToTeam(hr, { eventId: ev.id, attendeeId: c.id, newName: "Null Pointer" });
    expect(similar).toMatchObject({ status: "SIMILAR", suggestions: [{ name: "Null Pointers", count: 2 }] });
    expect((await teamOf(c.id)).name).toBeNull(); // nothing saved
    const forced = await addToTeam(hr, { eventId: ev.id, attendeeId: c.id, newName: "Null Pointer", force: true });
    expect(forced).toMatchObject({ status: "OK", created: true });
    expect(await teamOf(a.id)).toEqual({ name: "Null Pointers", team_name: "Null Pointers" }); // check-in screen / CSV see it
  });

  it("never more than the max: 8 phones fighting for the last spot → exactly 1 gets it", async () => {
    const ev = await makeEvent();
    const [a, b, c, ...rest] = await people(ev.id, 11);
    const team = await newTeam(ev.id, a.id, "Last Spot");
    await addToTeam(hr, { eventId: ev.id, attendeeId: b.id, teamId: team });
    await addToTeam(hr, { eventId: ev.id, attendeeId: c.id, teamId: team });
    const results = await Promise.all(rest.map((p, i) => addToTeam(i % 2 ? hr : hr2, { eventId: ev.id, attendeeId: p.id, teamId: team })));
    expect(results.filter((r) => r.status === "OK")).toHaveLength(1);
    expect(results.filter((r) => r.status === "FULL")).toHaveLength(7);
    expect((await query<{ n: number }>("select count(*)::int n from team_members where team_id = $1", [team])).rows[0].n).toBe(4);
  });

  it("the max follows the admin setting", async () => {
    const ev = await makeEvent();
    await query("update events set team_max = 2 where id = $1", [ev.id]);
    const [a, b, c] = await people(ev.id, 3);
    const team = await newTeam(ev.id, a.id, "Duo");
    expect((await addToTeam(hr, { eventId: ev.id, attendeeId: b.id, teamId: team })).status).toBe("OK");
    expect(await addToTeam(hr, { eventId: ev.id, attendeeId: c.id, teamId: team })).toMatchObject({ status: "FULL", team: { count: 2, max: 2 } });
  });

  it("one team per person: asked to move; moving frees the old spot and drops an empty team", async () => {
    const ev = await makeEvent();
    const [a, b] = await people(ev.id, 2);
    const t1 = await newTeam(ev.id, a.id, "Alpha Team");
    const t2 = await newTeam(ev.id, b.id, "Beta Squad");
    expect(await addToTeam(hr, { eventId: ev.id, attendeeId: a.id, teamId: t1 })).toMatchObject({ status: "ALREADY_IN_TEAM" });
    expect(await addToTeam(hr, { eventId: ev.id, attendeeId: a.id, teamId: t2 })).toMatchObject({ status: "IN_OTHER_TEAM", team: { name: "Alpha Team" } });
    expect(await addToTeam(hr, { eventId: ev.id, attendeeId: a.id, teamId: t2, move: true })).toMatchObject({ status: "OK", moved_from: "Alpha Team", team: { count: 2 } });
    expect((await teamOf(a.id)).name).toBe("Beta Squad");
    expect((await query("select 1 from teams where id = $1", [t1])).rowCount).toBe(0); // Alpha was empty → gone
  });

  it("two phones put the same person in two different teams at once → one wins, never two teams", async () => {
    const ev = await makeEvent();
    const [a, b, c] = await people(ev.id, 3);
    const t1 = await newTeam(ev.id, b.id, "Gamma");
    const t2 = await newTeam(ev.id, c.id, "Delta");
    const rs = await Promise.all([addToTeam(hr, { eventId: ev.id, attendeeId: a.id, teamId: t1 }), addToTeam(hr2, { eventId: ev.id, attendeeId: a.id, teamId: t2 })]);
    expect(rs.map((r) => r.status).sort()).toEqual(["IN_OTHER_TEAM", "OK"]);
    expect((await query<{ n: number }>("select count(*)::int n from team_members where attendee_id = $1", [a.id])).rows[0].n).toBe(1);
  });

  it("two teams swap members at the same time (both ways) without a deadlock", async () => {
    const ev = await makeEvent();
    const [a, b, c, d] = await people(ev.id, 4);
    const t1 = await newTeam(ev.id, a.id, "Swap One");
    await addToTeam(hr, { eventId: ev.id, attendeeId: b.id, teamId: t1 });
    const t2 = await newTeam(ev.id, c.id, "Swap Two");
    await addToTeam(hr, { eventId: ev.id, attendeeId: d.id, teamId: t2 });
    const rs = await Promise.all([
      addToTeam(hr, { eventId: ev.id, attendeeId: a.id, teamId: t2, move: true }),
      addToTeam(hr2, { eventId: ev.id, attendeeId: c.id, teamId: t1, move: true }),
    ]);
    expect(rs.map((r) => r.status)).toEqual(["OK", "OK"]);
    expect((await teamOf(a.id)).name).toBe("Swap Two");
    expect((await teamOf(c.id)).name).toBe("Swap One");
  });

  it("swap between two FULL teams in one step; a reserved spot stays with its team; parallel swaps don't deadlock", async () => {
    const ev = await makeEvent();
    const ps = await people(ev.id, 8);
    const t1 = await newTeam(ev.id, ps[0].id, "Full One");
    for (const p of ps.slice(1, 3)) await addToTeam(hr, { eventId: ev.id, attendeeId: p.id, teamId: t1 });
    const spot = (await query<{ id: string }>("insert into team_members (team_id, reserved_name, source) values ($1, 'Reserved Name', 'sheet') returning id", [t1])).rows[0].id;
    await addToTeam(hr, { eventId: ev.id, attendeeId: ps[3].id, teamId: t1, reservedId: spot }); // ps[3] holds the reserved spot
    const t2 = await newTeam(ev.id, ps[4].id, "Full Two");
    for (const p of ps.slice(5, 8)) await addToTeam(hr, { eventId: ev.id, attendeeId: p.id, teamId: t2 });
    expect(await addToTeam(hr, { eventId: ev.id, attendeeId: ps[0].id, teamId: t2, move: true })).toMatchObject({ status: "FULL" });

    await swapMembers(hr, { eventId: ev.id, attendeeA: ps[3].id, attendeeB: ps[4].id });
    expect(await teamOf(ps[3].id)).toEqual({ name: "Full Two", team_name: "Full Two" });
    expect(await teamOf(ps[4].id)).toEqual({ name: "Full One", team_name: "Full One" });
    // The reserved spot stayed in Full One (now held by ps[4]).
    expect((await query<{ team_id: string; attendee_id: string }>("select team_id, attendee_id from team_members where reserved_name = 'Reserved Name'", [])).rows[0]).toEqual({ team_id: t1, attendee_id: ps[4].id });

    const rs = await Promise.allSettled([
      swapMembers(hr, { eventId: ev.id, attendeeA: ps[0].id, attendeeB: ps[5].id }),
      swapMembers(hr2, { eventId: ev.id, attendeeA: ps[6].id, attendeeB: ps[1].id }),
    ]);
    expect(rs.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const sizes = (await query<{ n: number }>("select count(*)::int n from team_members where team_id = any($1::uuid[]) group by team_id", [[t1, t2]])).rows.map((r) => r.n);
    expect(sizes).toEqual([4, 4]);
    expect((await query("select attendee_id from team_members where attendee_id is not null group by 1 having count(*) > 1")).rowCount).toBe(0);
  });

  it("rename: everyone's team name follows; a name already taken is refused", async () => {
    const ev = await makeEvent();
    const [a, b] = await people(ev.id, 2);
    const t1 = await newTeam(ev.id, a.id, "Old Name");
    await newTeam(ev.id, b.id, "Taken Name");
    await renameTeam(hr, t1, "Shiny New Name");
    expect(await teamOf(a.id)).toEqual({ name: "Shiny New Name", team_name: "Shiny New Name" });
    await expect(renameTeam(hr, t1, "taken name")).rejects.toMatchObject({ code: "TEAM_NAME_TAKEN" });
  });
});

describe("reserved spots from the team sheet", () => {
  it("a reserved spot counts toward the max; claiming it fills it; removing the person gives it back", async () => {
    const ev = await makeEvent();
    const [a, b, c, sami, other] = await people(ev.id, 5);
    const team = await newTeam(ev.id, a.id, "Root Rats");
    await addToTeam(hr, { eventId: ev.id, attendeeId: b.id, teamId: team });
    await addToTeam(hr, { eventId: ev.id, attendeeId: c.id, teamId: team });
    const spot = (await query<{ id: string }>("insert into team_members (team_id, reserved_name, source) values ($1, 'Sami Ben Ali', 'sheet') returning id", [team])).rows[0].id;
    expect(await addToTeam(hr, { eventId: ev.id, attendeeId: other.id, teamId: team })).toMatchObject({ status: "FULL" }); // Sami's spot is kept
    expect(await addToTeam(hr, { eventId: ev.id, attendeeId: sami.id, teamId: team, reservedId: spot })).toMatchObject({ status: "OK", team: { count: 4 } });
    expect((await teamOf(sami.id)).name).toBe("Root Rats");
    await removeFromTeam(hr, spot);
    expect((await teamOf(sami.id)).name).toBeNull();
    expect((await query<{ attendee_id: string | null; reserved_name: string }>("select attendee_id, reserved_name from team_members where id = $1", [spot])).rows[0]).toEqual({ attendee_id: null, reserved_name: "Sami Ben Ali" });
    await removeFromTeam(hr, spot); // now free the spot itself
    expect((await addToTeam(hr, { eventId: ev.id, attendeeId: other.id, teamId: team })).status).toBe("OK");
  });
});

describe("check-in and Undo", () => {
  it("check-in answers carry the team, and ask for one only when the admin switch is on", async () => {
    const ev = await makeEvent();
    const cookie = await cookieFor(hr);
    const [a, b] = await people(ev.id, 2);
    const scan = async (token: string) => body<Record<string, unknown>>(await checkinPOST(req("POST", "/api/checkin", { cookie, body: { event_id: ev.id, token } }), undefined));
    const r1 = await scan(a.token);
    expect(r1).toMatchObject({ status: "OK", team: null, ask_team: false });
    await query("update events set team_prompt = true where id = $1", [ev.id]);
    const again = await scan(a.token);
    expect(again).toMatchObject({ status: "ALREADY_CHECKED_IN", ask_team: true }); // a re-scan can still assign a team
    await newTeam(ev.id, b.id, "Scanners");
    const r2 = await scan(b.token);
    expect(r2).toMatchObject({ status: "OK", ask_team: false, team: { name: "Scanners", count: 1, here: 1, max: 4 }, team_name: "Scanners" });
  });

  it("walk-ins get the question too", async () => {
    const ev = await makeEvent();
    await query("update events set team_prompt = true where id = $1", [ev.id]);
    const w = await body<Record<string, unknown>>(await walkinPOST(req("POST", "/api/walkin", { cookie: await cookieFor(hr), body: { event_id: ev.id, full_name: "Walk Team" } }), undefined));
    expect(w).toMatchObject({ status: "OK", ask_team: true, team: null });
  });

  it("Undo: put in a team at the door after the check-in → out of the team; from the sheet → keeps the spot", async () => {
    const ev = await makeEvent();
    const [door, sheet, claimer, anchor] = await people(ev.id, 4);
    const team = await newTeam(ev.id, anchor.id, "Undo Team");
    // From the sheet (before the check-in).
    await query("insert into team_members (team_id, attendee_id, source) values ($1, $2, 'sheet')", [team, sheet.id]);
    const spot = (await query<{ id: string }>("insert into team_members (team_id, reserved_name, source) values ($1, 'Claimer Name', 'sheet') returning id", [team])).rows[0].id;
    const ci = async (p: { id: string }) => (await checkInAttendee({ staff: hr, eventId: ev.id, attendeeId: p.id })) as { checkin_id: string };
    const dc = await ci(door);
    await addToTeam(hr, { eventId: ev.id, attendeeId: door.id, teamId: team });
    const sc = await ci(sheet);
    const cc = await ci(claimer);
    await addToTeam(hr, { eventId: ev.id, attendeeId: claimer.id, teamId: team, reservedId: spot });

    expect(await undoCheckin({ staff: hr, checkinId: dc.checkin_id })).toMatchObject({ team_left: true });
    expect(await teamOf(door.id)).toEqual({ name: null, team_name: null });
    expect(await undoCheckin({ staff: hr, checkinId: sc.checkin_id })).toMatchObject({ team_left: false });
    expect((await teamOf(sheet.id)).name).toBe("Undo Team");
    await undoCheckin({ staff: hr, checkinId: cc.checkin_id });
    expect((await teamOf(claimer.id)).name).toBeNull();
    expect((await query<{ attendee_id: string | null }>("select attendee_id from team_members where id = $1", [spot])).rows[0].attendee_id).toBeNull(); // reserved again
  });

  it("Undo of a mistaken Add Person also clears their team, and an emptied team disappears", async () => {
    const ev = await makeEvent();
    const w = await body<{ status: string; attendee_id: string; checkin_id: string }>(
      // No email: in tests emails go out instantly, and someone whose QR email went out is kept on Undo.
      await walkinPOST(req("POST", "/api/walkin", { cookie: await cookieFor(hr), body: { event_id: ev.id, full_name: "Oops Person" } }), undefined),
    );
    const r = await addToTeam(hr, { eventId: ev.id, attendeeId: w.attendee_id, newName: "Solo Mistake", force: true });
    expect(r.status).toBe("OK");
    expect(await undoCheckin({ staff: hr, checkinId: w.checkin_id })).toMatchObject({ person_removed: true, team_left: true });
    expect((await query("select 1 from teams where event_id = $1", [ev.id])).rowCount).toBe(0);
  });
});

describe("board and download", () => {
  it("board: who is here, teams with counts; CSV is admin-only", async () => {
    const ev = await makeEvent();
    const [a, b, c] = await people(ev.id, 3);
    const team = await newTeam(ev.id, a.id, "Board Team");
    await addToTeam(hr, { eventId: ev.id, attendeeId: b.id, teamId: team });
    await checkInAttendee({ staff: hr, eventId: ev.id, attendeeId: a.id });
    await checkInAttendee({ staff: hr, eventId: ev.id, attendeeId: c.id });
    const board = await teamBoard(ev.id, null);
    expect(board.teams).toMatchObject([{ name: "Board Team", count: 2, here: 1 }]);
    expect(board.here.map((p) => [p.name, p.team_id]).sort()).toEqual([[a.name, team], [c.name, null]].sort());
    const http = await boardGET(req("GET", `/api/events/${ev.id}/teams`, { cookie: await cookieFor(hr) }), params({ id: ev.id }));
    expect(http.status).toBe(200);
    expect((await csvGET(req("GET", `/api/events/${ev.id}/teams.csv`, { cookie: await cookieFor(hr) }), params({ id: ev.id }))).status).toBe(403);
    const csv = await (await csvGET(req("GET", `/api/events/${ev.id}/teams.csv`, { cookie: await cookieFor(admin) }), params({ id: ev.id }))).text();
    expect(csv).toContain("Board Team,Can play (2/4),2/4,1");
    expect(csv).toContain(`(no team),,,,${c.name},yes`);
  });
});
