-- Bootcamp details:
-- * "Already a member, not on the list": HR can admit someone as a member
--   without taking money. The membership is flagged for admin review.
-- * Payments taken at the registration stand (imported from the stand sheet)
--   are kept apart from cash taken at the door.
-- * The Google Form's "what do you enroll in" checkbox is stored.

alter table members drop constraint members_source_check;
alter table members add constraint members_source_check
  check (source in ('import', 'desk', 'manual', 'claimed', 'stand'));
alter table members add column needs_review boolean not null default false;
create index members_review_idx on members (created_at) where needs_review;

-- A membership can be paid on no particular event day (e.g. at the stand, or in the admin panel the night before).
alter table payments alter column event_day_id drop not null;
alter table payments add column channel text not null default 'desk' check (channel in ('desk', 'stand'));

alter table attendees add column enrollment text;          -- raw answer, e.g. "Sessions, Main event"
alter table attendees add column enroll_sessions boolean;  -- derived from it (null = unknown)
alter table attendees add column enroll_main boolean;
