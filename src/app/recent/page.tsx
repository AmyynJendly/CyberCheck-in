"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { Button, Card, Notice, Page, fmtDateTime } from "@/components/ui";

interface Item {
  id: string;
  checked_at: string;
  method: "qr" | "manual" | "walk_in";
  undone_at: string | null;
  name: string;
  team_name: string | null;
  day_label: string;
  can_undo: boolean;
}

const METHOD = { qr: "QR", manual: "manual", walk_in: "walk-in" } as const;

export default function RecentPage() {
  const { event } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = event ? `?event_id=${event.id}` : "";
      setItems((await api<{ checkins: Item[] }>(`/api/checkin/recent${qs}`)).checkins);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [event]);

  useEffect(() => {
    void load();
  }, [load]);

  const undo = async (it: Item) => {
    if (!confirm(`Undo check-in of ${it.name}?`)) return;
    setBusy(it.id);
    setError(null);
    try {
      await api("/api/checkin/undo", { body: { checkin_id: it.id } });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page title="My recent check-ins">
      <p className="text-sm text-slate-400">Your last 20. You can undo your own check-ins for 10 minutes.</p>
      {error && <Notice tone="error">{error}</Notice>}
      {items === null && <p className="text-slate-400">Loading…</p>}
      {items?.length === 0 && <p className="text-slate-400">Nothing yet.</p>}
      {items?.map((it) => (
        <Card key={it.id} className={it.undone_at ? "opacity-50" : ""}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className={`font-bold ${it.undone_at ? "line-through" : ""}`}>{it.name}</p>
              <p className="text-xs text-slate-400">
                {fmtDateTime(it.checked_at)} · {it.day_label} · {METHOD[it.method]}
                {it.team_name ? ` · ${it.team_name}` : ""}
                {it.undone_at ? " · undone" : ""}
              </p>
            </div>
            {it.can_undo && (
              <Button variant="danger" onClick={() => undo(it)} disabled={busy === it.id}>
                Undo
              </Button>
            )}
          </div>
        </Card>
      ))}
    </Page>
  );
}
