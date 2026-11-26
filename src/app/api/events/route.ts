// GET /api/events — active events + their days (+ which day is "today").
import { query } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireStaff } from "@/lib/auth";
import { tunisDate } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(async (req) => {
  await requireStaff(req);
  const today = tunisDate();
  const r = await query<{
    id: string;
    slug: string;
    name: string;
    location: string | null;
    membership_fee: number;
    team_max: number;
    team_small_ok: boolean;
    team_prompt: boolean;
    days: { id: string; day_date: string; label: string | null; access: string; entry_fee: number }[];
  }>(
    `select e.id, e.slug, e.name, e.location, e.membership_fee, e.team_max, e.team_small_ok, e.team_prompt,
            coalesce(json_agg(json_build_object('id', d.id, 'day_date', d.day_date, 'label', d.label,
                                                'access', d.access, 'entry_fee', d.entry_fee, 'capacity', d.capacity)
                              order by d.day_date) filter (where d.id is not null), '[]') as days
       from events e left join event_days d on d.event_id = e.id
      where e.is_active
      group by e.id
      order by min(d.day_date) desc nulls last, e.created_at desc`,
  );
  const events = r.rows.map((e) => ({
    ...e,
    today_day_id: e.days.find((d) => d.day_date === today)?.id ?? null,
  }));
  return json({ today, events });
});
