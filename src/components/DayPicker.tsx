"use client";

import { useApp } from "./AppContext";
import { Notice } from "./ui";
import { dayName } from "./types";

/** Admin-only: choose which event day check-ins count for (used when today is not an event day). */
export function DayPicker() {
  const { me, event, dayOverrideId, setDayOverride, today } = useApp();
  if (!event || me?.role !== "admin") return null;
  if (!event.days.length) return <Notice tone="warn">This event has no days yet. Add them in Admin.</Notice>;
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-400">Admin: check-ins count for</span>
      <select
        className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-base"
        value={dayOverrideId ?? ""}
        onChange={(e) => setDayOverride(e.target.value || null)}
      >
        <option value="">{event.today_day_id ? "Today (automatic)" : `Today ${today} — not an event day`}</option>
        {event.days.map((d) => (
          <option key={d.id} value={d.id}>
            {dayName(d)} ({d.day_date})
          </option>
        ))}
      </select>
    </label>
  );
}
