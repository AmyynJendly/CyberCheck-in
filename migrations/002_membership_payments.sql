-- Membership + paid entry (bootcamp-style events).
--
-- * members: the club's membership list (club-wide, reused across events).
-- * event_days.access: who gets in for free that day.
--     free            everyone
--     members         members only; non-members must join (membership fee)
--     members_or_fee  members free; others pay the day's entry fee (or join)
-- * payments: cash taken at the desk, always tied to the staff member who took it.

create table members (
  id                uuid primary key default gen_random_uuid(),
  full_name         text not null check (length(trim(full_name)) > 0),
  email             text check (email is null or email = lower(trim(email))),
  phone             text,
  -- last 8 digits of the phone (Tunisian numbers), used for matching
  phone_key         text check (phone_key is null or phone_key ~ '^[0-9]{8}$'),
  valid_until       date not null,
  source            text not null default 'import' check (source in ('import', 'desk', 'manual')),
  added_by_staff_id uuid references staff(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index members_email_uniq on members (email) where email is not null;
create index members_phone_key_idx on members (phone_key) where phone_key is not null;
create index members_name_idx on members (lower(full_name));

alter table attendees add column member_id uuid references members(id) on delete set null;

alter table events add column membership_fee numeric(7, 2) not null default 15 check (membership_fee >= 0);

alter table event_days add column access text not null default 'free'
  check (access in ('free', 'members', 'members_or_fee'));
alter table event_days add column entry_fee numeric(7, 2) not null default 5 check (entry_fee >= 0);

create table payments (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references events(id),
  event_day_id       uuid not null references event_days(id),
  attendee_id        uuid not null references attendees(id),
  staff_id           uuid not null references staff(id),
  kind               text not null check (kind in ('membership', 'entry')),
  amount             numeric(7, 2) not null check (amount >= 0),
  member_id          uuid references members(id) on delete set null,
  created_at         timestamptz not null default now(),
  voided_at          timestamptz,
  voided_by_staff_id uuid references staff(id),
  void_reason        text,
  check ((voided_at is null) = (voided_by_staff_id is null))
);
-- Never charge the same person twice for the same thing.
create unique index payments_one_entry_per_day on payments (attendee_id, event_day_id)
  where kind = 'entry' and voided_at is null;
create unique index payments_one_membership on payments (attendee_id)
  where kind = 'membership' and voided_at is null;
create index payments_event_idx on payments (event_id, created_at desc);

alter table members  enable row level security;
alter table payments enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on members, payments from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on members, payments from authenticated';
  end if;
end $$;
