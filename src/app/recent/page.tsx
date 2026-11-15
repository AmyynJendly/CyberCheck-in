"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { Button, Notice, Page, Section, Sheet, SheetAction, Spinner, fmtDateTime } from "@/components/ui";

interface Item {
  id: string;
  checked_at: string;
  method: "qr" | "manual" | "walk_in";
  undone_at: string | null;
  name: string;
  team_name: string | null;
  day_label: string;
  can_undo: boolean;
  paid_kind: "membership" | "entry" | null;
  paid_amount: number | null;
}

const METHOD = { qr: "QR", manual: "Manual", walk_in: "Walk-in" } as const;

export default function RecentPage() {
  const { event } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Item | null>(null);

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
    setConfirming(null);
    setBusy(true);
    setError(null);
    try {
      await api("/api/checkin/undo", { body: { checkin_id: it.id } });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="My Check-ins">
      {error && <Notice tone="error">{error}</Notice>}
      {items === null && !error && <Spinner />}
      {items?.length === 0 && (
        <div className="py-12 text-center">
          <p className="t-title3">No Check-ins Yet</p>
          <p className="t-subhead mt-1 text-label2">People you check in will appear here.</p>
        </div>
      )}
      {items && items.length > 0 && (
        <Section footer="Your last 20. You can undo your own check-ins for 10 minutes; after that, ask an admin. Undo doesn't cancel a payment; an admin does that from Cash.">
          {items.map((it) => (
            <div key={it.id} className={`flex min-h-[60px] items-center gap-3 px-4 py-2.5 ${it.undone_at ? "opacity-45" : ""}`}>
              <div className="min-w-0 flex-1">
                <p className={`t-body truncate ${it.undone_at ? "line-through" : ""}`}>{it.name}</p>
                <p className="t-footnote text-label2">
                  {fmtDateTime(it.checked_at)} · {it.day_label} · {METHOD[it.method]}
                  {it.paid_amount !== null && ` · paid ${it.paid_amount} DT`}
                  {it.undone_at ? " · Undone" : ""}
                </p>
              </div>
              {it.can_undo && (
                <Button variant="destructive" size="small" onClick={() => setConfirming(it)} disabled={busy}>
                  Undo
                </Button>
              )}
            </div>
          ))}
        </Section>
      )}

      <Sheet open={!!confirming} onClose={() => setConfirming(null)} title={`Undo check-in for ${confirming?.name}?`} message="Their QR code will work again today.">
        <SheetAction destructive onClick={() => confirming && undo(confirming)}>
          Undo Check-in
        </SheetAction>
      </Sheet>
    </Page>
  );
}
