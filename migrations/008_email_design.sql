-- QR email design per event (src/lib/email-designs.ts): 'borderland' or
-- 'classic'. Null = the default (borderland). Picked in Admin → Emails.
alter table events add column email_design text check (email_design is null or email_design in ('borderland', 'classic'));
