-- Teams for the CTF day. A team belongs to an event; each person is in at most
-- one team (unique attendee_id). A spot can also be reserved for a name from the
-- team sheet who isn't registered yet (reserved_name), until that person is added.
-- The size limit is enforced in code under a row lock on the team (see teams.ts).
create table teams (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references events(id) on delete cascade,
  name               text not null check (length(trim(name)) between 1 and 60),
  name_key           text not null,  -- lowercase letters/digits only: "Null Pointers" → "nullpointers"
  created_by_staff_id uuid references staff(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (event_id, name_key)
);

create table team_members (
  id                 uuid primary key default gen_random_uuid(),
  team_id            uuid not null references teams(id) on delete cascade,
  attendee_id        uuid references attendees(id) on delete cascade,
  reserved_name      text,           -- the name on the team sheet; kept after the spot is claimed
  source             text not null check (source in ('sheet', 'door')),
  added_by_staff_id  uuid references staff(id),
  added_at           timestamptz not null default now(),
  claimed_at         timestamptz,    -- when a reserved spot was given to a person at the door
  check (attendee_id is not null or reserved_name is not null)
);
create unique index team_members_one_team on team_members (attendee_id) where attendee_id is not null;
create index team_members_team_idx on team_members (team_id);

-- Admin settings (Admin → Overview → Teams).
alter table events add column team_max int not null default 4 check (team_max between 1 and 20);
alter table events add column team_small_ok boolean not null default true;   -- teams of 1..max-1 can play
alter table events add column team_prompt boolean not null default false;    -- ask for a team after check-in

alter table teams enable row level security;
alter table team_members enable row level security;
