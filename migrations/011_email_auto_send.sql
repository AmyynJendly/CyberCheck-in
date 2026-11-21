-- Auto-send (Admin → Emails): when on, the QR emails of people added at the
-- door ("Add Person") are sent every `email_auto_every` minutes. Off by
-- default: everything else waits for the admin's Send Waiting Now.
-- `email_auto_last_run` makes sure only one sender starts per interval.
alter table events add column email_auto_send boolean not null default false;
alter table events add column email_auto_every int not null default 10 check (email_auto_every between 1 and 1440);
alter table events add column email_auto_last_run timestamptz;
