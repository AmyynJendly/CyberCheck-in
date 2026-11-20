-- People who paid at the registration stand before the event keep their seat
-- even when the session's limit is reached: we can't turn them away.
--
-- The app sets checkins.over_limit = true when inserting a check-in for such a
-- person. The seat trigger then lets the insert through on a full day (seats
-- still counted, so the admin sees 72/70), and stores whether it really went
-- over the limit. Everyone else still gets DAY_FULL, exactly as before.

alter table checkins add column over_limit boolean not null default false;

create or replace function checkins_take_seat() returns trigger language plpgsql as $$
begin
  if new.undone_at is not null then
    return new;
  end if;
  update event_days
     set seats_taken = seats_taken + 1
   where id = new.event_day_id
     and (capacity is null or seats_taken < capacity);
  if found then
    new.over_limit := false; -- there was a seat: not over the limit
    return new;
  end if;
  if new.over_limit then
    update event_days set seats_taken = seats_taken + 1 where id = new.event_day_id;
    return new;
  end if;
  raise exception 'DAY_FULL' using errcode = 'P0001', detail = new.event_day_id::text;
end $$;
