-- Renewing an existing (expired) membership at the door extends that record.
-- Remember what it was, so Undo (or voiding the payment in Cash) can put it
-- back. `extended_at` is the transaction time of the renewal: it equals the
-- check-in's checked_at / the payment's created_at written with it.
alter table members add column prev_valid_until date;
alter table members add column prev_needs_review boolean;
alter table members add column extended_at timestamptz;
