-- Cybertrace Check-in — initial schema (SPEC.md section 4)
-- Works on plain Postgres 16 (local docker) and on Supabase.

create table events (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null check (length(trim(name)) > 0),
  location    text,
  form_secret text not null check (length(form_secret) >= 24),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table event_days (
  id        uuid primary key default gen_random_uuid(),
  event_id  uuid not null references events(id) on delete cascade,
  day_date  date not null,
  label     text,
  unique (event_id, day_date)
);

create table staff (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  pin_hash        text not null,
  role            text not null default 'hr' check (role in ('hr', 'admin')),
  is_active       boolean not null default true,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

create table attendees (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events(id),
  full_name         text not null check (length(trim(full_name)) > 0),
  email             text check (email is null or email = lower(trim(email))),
  phone             text,
  class_year        text,
  team_name         text,
  source            text not null check (source in ('form', 'walk_in')),
  added_by_staff_id uuid references staff(id),
  form_response_id  text,
  qr_token          text not null unique,
  short_code        text not null check (short_code ~ '^[A-Z0-9]{6}$'),
  email_status      text not null default 'pending'
                    check (email_status in ('none', 'pending', 'sent', 'failed')),
  email_error       text,
  email_sent_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (event_id, form_response_id),
  unique (event_id, short_code)
);

-- one attendee per email per event
create unique index attendees_event_email_uniq
  on attendees (event_id, email) where email is not null;
create index attendees_event_name_idx on attendees (event_id, lower(full_name));
create index attendees_email_status_idx on attendees (email_status) where email_status in ('failed', 'pending');

-- Every Google Form response id we have processed (idempotency for repeat
-- posts / syncAll, including responses that were merged into an existing
-- attendee by email). attendees.form_response_id keeps the first one.
create table form_submissions (
  event_id    uuid not null references events(id) on delete cascade,
  response_id text not null,
  attendee_id uuid references attendees(id),
  received_at timestamptz not null default now(),
  primary key (event_id, response_id)
);

create table checkins (
  id                 uuid primary key default gen_random_uuid(),
  attendee_id        uuid not null references attendees(id),
  event_day_id       uuid not null references event_days(id),
  staff_id           uuid not null references staff(id),
  method             text not null check (method in ('qr', 'manual', 'walk_in')),
  checked_at         timestamptz not null default now(),
  undone_at          timestamptz,
  undone_by_staff_id uuid references staff(id),
  check ((undone_at is null) = (undone_by_staff_id is null))
);

-- THE key rule: one active check-in per person per day.
create unique index one_checkin_per_day
  on checkins (attendee_id, event_day_id) where undone_at is null;
create index checkins_day_idx on checkins (event_day_id) where undone_at is null;
create index checkins_staff_idx on checkins (staff_id, checked_at desc);

create table audit_log (
  id          bigserial primary key,
  staff_id    uuid,
  action      text not null,
  event_id    uuid,
  attendee_id uuid,
  details     jsonb,
  at          timestamptz not null default now()
);
create index audit_log_at_idx on audit_log (at desc);
create index audit_log_event_idx on audit_log (event_id, at desc);

-- Row Level Security on, with NO policies: Supabase's anon/authenticated
-- roles (PostgREST) can read nothing. The app connects as the table owner
-- through DATABASE_URL, which RLS does not restrict.
alter table events           enable row level security;
alter table event_days       enable row level security;
alter table staff            enable row level security;
alter table attendees        enable row level security;
alter table form_submissions enable row level security;
alter table checkins         enable row level security;
alter table audit_log        enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
  end if;
end $$;
