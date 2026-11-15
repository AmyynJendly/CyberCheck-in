"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Stats } from "./types";

/** Polls /api/events/:id/stats. Also acts as the connection heartbeat. */
export function useStats(eventId: string | null | undefined, dayId: string | null | undefined, intervalMs = 10_000) {
  const [stats, setStats] = useState<Stats | null>(null);
  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const q = dayId ? `?day_id=${dayId}` : "";
      setStats(await api<Stats>(`/api/events/${eventId}/stats${q}`, { timeoutMs: 8000 }));
    } catch {
      /* banner handles offline */
    }
  }, [eventId, dayId]);
  useEffect(() => {
    void load();
    if (!intervalMs) return;
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);
  return { stats, reload: load };
}
