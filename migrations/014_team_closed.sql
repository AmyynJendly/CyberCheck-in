-- A team can say "we don't want anyone else" (closed). Default: open.
-- Only a label for HR: the picker lists closed teams last and asks before adding
-- someone to one. The size limit is unchanged.
alter table teams add column closed boolean not null default false;
