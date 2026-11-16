-- Capacity enforced by the database, like one-check-in-per-day.
-- event_days.seats_taken = number of active check-ins for that day, kept by
-- triggers. A check-in INSERT increments it with a conditional UPDATE (row
-- lock + re-check of the latest value), and raises DAY_FULL if no seat is
-- left — so no code path can oversell a session, and the check-in stays one
-- statement (no explicit transaction or extra round trips).

alter table event_days add column seats_taken int not null default 0;

update event_days d
   set seats_taken = (select count(*) from checkins c where c.event_day_id = d.id and c.undone_at is null);

create function checkins_take_seat() returns trigger language plpgsql as $$
begin
  if new.undone_at is not null then
    return new;
  end if;
  update event_days
     set seats_taken = seats_taken + 1
   where id = new.event_day_id
     and (capacity is null or seats_taken < capacity);
  if not found then
    raise exception 'DAY_FULL' using errcode = 'P0001', detail = new.event_day_id::text;
  end if;
  return new;
end $$;

create function checkins_release_seat() returns trigger language plpgsql as $$
begin
  if old.undone_at is null and new.undone_at is not null then
    update event_days set seats_taken = greatest(seats_taken - 1, 0) where id = new.event_day_id;
  elsif old.undone_at is not null and new.undone_at is null then
    update event_days set seats_taken = seats_taken + 1 where id = new.event_day_id;
  end if;
  return new;
end $$;

create trigger checkins_take_seat before insert on checkins
  for each row execute function checkins_take_seat();
create trigger checkins_release_seat after update of undone_at on checkins
  for each row execute function checkins_release_seat();
