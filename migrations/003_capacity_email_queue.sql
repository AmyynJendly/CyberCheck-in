-- Capacity per day, per-event email template, and a single-sender email queue.

-- Max active check-ins per day (seats). NULL = no limit.
alter table event_days add column capacity int check (capacity is null or capacity > 0);

-- Editable email template (NULL = built-in default). Placeholders: {{name}}, {{event}},
-- {{code}}, {{qr}}, {{dates}}, {{location}}, {{entry}}.
alter table events add column email_subject text;
alter table events add column email_body text;

-- Queue bookkeeping: transient Gmail errors are retried a few times before 'failed'.
alter table attendees add column email_attempts int not null default 0;
create index attendees_email_queue_idx on attendees (updated_at) where email_status = 'pending';

-- Leases for background jobs ("only one email sender at a time"), safe with
-- Supabase's transaction pooler (no session-level advisory locks).
create table job_leases (
  name         text primary key,
  holder       text,
  locked_until timestamptz not null default now()
);
alter table job_leases enable row level security;

-- Faster capacity / stats counts.
create index if not exists checkins_day_active_idx on checkins (event_day_id) where undone_at is null;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on job_leases from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on job_leases from authenticated';
  end if;
end $$;
