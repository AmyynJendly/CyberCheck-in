-- A second address for someone who registered with two emails (e.g. once on
-- each form). The QR email goes to both, in one message. Null = none.
alter table attendees add column alt_email text check (alt_email is null or alt_email = lower(trim(alt_email)));
