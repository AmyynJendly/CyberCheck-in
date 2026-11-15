"use client";

import { CalendarDays } from "lucide-react";
import { useApp } from "./AppContext";
import { IconTile, MenuSelect, Notice, Row, Section } from "./ui";
import { dayName } from "./types";

/** Admin-only: choose which event day check-ins count for (used when today is not an event day). */
export function DayPicker() {
  const { me, event, dayOverrideId, setDayOverride, today } = useApp();
  if (!event || me?.role !== "admin") return null;
  if (!event.days.length) return <Notice tone="warn">This event has no days yet. Add them in Admin.</Notice>;
  return (
    <Section inset={60} footer="Admins only. Use this when today isn't an event day. It resets tomorrow.">
      <Row
        icon={
          <IconTile color="bg-sys-indigo">
            <CalendarDays className="h-[17px] w-[17px]" strokeWidth={2.2} />
          </IconTile>
        }
        title="Counting day"
        trailing={
          <MenuSelect
            label="Counting day"
            value={dayOverrideId ?? ""}
            onChange={(v) => setDayOverride(v || null)}
            options={[
              { value: "", label: event.today_day_id ? "Today" : `Today (${today}) · none` },
              ...event.days.map((d) => ({ value: d.id, label: `${dayName(d)} · ${d.day_date}` })),
            ]}
          />
        }
      />
    </Section>
  );
}
