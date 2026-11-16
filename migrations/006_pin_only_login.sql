-- PIN-only login: staff type just their PIN, and the PIN says who they are.
--
-- * staff.pin_lookup = HMAC-SHA256(PIN_PEPPER, pin), hex. Unique, so no two
--   accounts can share a PIN and login is one indexed lookup. Without the
--   pepper (an env var, never in the database) it can't be reversed.
--   Accounts created before this migration have no lookup yet; it is filled
--   in on their first successful login (or when an admin resets their PIN).
-- * login_throttle: wrong guesses can no longer be pinned on one account, so
--   they are limited per device (IP) and across the whole app.

alter table staff add column pin_lookup text;
create unique index staff_pin_lookup_key on staff (pin_lookup);

create table login_throttle (
  key          text primary key,           -- 'ip:<address>' or 'global'
  attempts     int not null default 0,     -- attempts in the current window (successes are given back)
  window_start timestamptz not null default now()
);
alter table login_throttle enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on login_throttle from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on login_throttle from authenticated';
  end if;
end $$;
