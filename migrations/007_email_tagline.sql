-- QR email header: a line under the event name (e.g. the edition's theme),
-- edited in Admin → Emails. Null = no line.
alter table events add column email_tagline text;
