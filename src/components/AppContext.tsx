"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { api } from "./api";
import type { DayInfo, EventInfo, Me } from "./types";

interface AppState {
  ready: boolean;
  me: Me | null;
  events: EventInfo[];
  today: string;
  event: EventInfo | null;
  selectEvent: (id: string | null) => void;
  /** Admin-only manual day (when today isn't an event day). Remembered for today only. */
  dayOverrideId: string | null;
  setDayOverride: (id: string | null) => void;
  /** The day check-ins count for: admin override, else today's event day. */
  activeDay: DayInfo | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

const EVENT_KEY = "ct_event_id";
const overrideKey = (eventId: string) => `ct_day_override:${eventId}`;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isPublic = pathname === "/login";
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [today, setToday] = useState("");
  const [eventId, setEventId] = useState<string | null>(null);
  const [dayOverrideId, setDayOverrideId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [meRes, evRes] = await Promise.all([
      api<{ staff: Me }>("/api/auth/me"),
      api<{ today: string; events: EventInfo[] }>("/api/events"),
    ]);
    setMe(meRes.staff);
    setEvents(evRes.events);
    setToday(evRes.today);
    const stored = readStorage(EVENT_KEY);
    const pick =
      evRes.events.find((e) => e.id === stored)?.id ?? (evRes.events.length === 1 ? evRes.events[0].id : null);
    setEventId(pick);
  }, []);

  useEffect(() => {
    if (isPublic) return;
    refresh()
      .catch(() => {})
      .finally(() => setReady(true));
  }, [isPublic, refresh]);

  // Load the remembered admin day override for this event (valid only for the day it was set).
  useEffect(() => {
    if (!eventId || !today) return setDayOverrideId(null);
    const raw = readStorage(overrideKey(eventId));
    const [setOn, dayId] = raw?.split("|") ?? [];
    setDayOverrideId(setOn === today && dayId ? dayId : null);
  }, [eventId, today]);

  const event = useMemo(() => events.find((e) => e.id === eventId) ?? null, [events, eventId]);

  const selectEvent = useCallback((id: string | null) => {
    setEventId(id);
    writeStorage(EVENT_KEY, id);
  }, []);

  const setDayOverride = useCallback(
    (id: string | null) => {
      if (!eventId) return;
      setDayOverrideId(id);
      writeStorage(overrideKey(eventId), id ? `${today}|${id}` : null);
    },
    [eventId, today],
  );

  const activeDay = useMemo(() => {
    if (!event) return null;
    const overrideDay = me?.role === "admin" && dayOverrideId ? event.days.find((d) => d.id === dayOverrideId) : undefined;
    return overrideDay ?? event.days.find((d) => d.id === event.today_day_id) ?? null;
  }, [event, me, dayOverrideId]);

  const value: AppState = {
    ready,
    me,
    events,
    today,
    event,
    selectEvent,
    dayOverrideId: me?.role === "admin" ? dayOverrideId : null,
    setDayOverride,
    activeDay,
    refresh,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Extra body fields to send so the server uses the admin's manually picked day. */
export function useDayParam(): { event_day_id?: string } {
  const { dayOverrideId, event } = useApp();
  return dayOverrideId && event?.days.some((d) => d.id === dayOverrideId) ? { event_day_id: dayOverrideId } : {};
}
