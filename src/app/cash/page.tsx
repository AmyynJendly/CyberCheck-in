"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp, useDayParam } from "@/components/AppContext";
import { api, errorMessage } from "@/components/api";
import { NeedEvent, Notice, Page, Section, Segmented, Sheet, SheetAction, Spinner, fmtTime } from "@/components/ui";
import { fmtDT } from "@/components/types";

interface Payment {
  id: string;
  created_at: string;
  kind: "membership" | "entry";
  amount: number;
  attendee_name: string;
  staff_id: string;
  staff_name: string;
  day_label: string;
  voided_at: string | null;
  voided_by: string | null;
}
interface Summary {
  payments: Payment[];
  by_staff: { staff_id: string; staff_name: string; memberships: number; entries: number; total: number }[];
  total: number;
}

export default function CashPage() {
  const { ready, event, activeDay, me } = useApp();
  const dayParam = useDayParam();
  const [scope, setScope] = useState<"day" | "all">("day");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const dayId = scope === "day" ? (dayParam.event_day_id ?? activeDay?.id ?? null) : null;

  const load = useCallback(async () => {
    if (!event) return;
    try {
      setData(await api<Summary>(`/api/events/${event.id}/payments${dayId ? `?day_id=${dayId}` : ""}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [event, dayId]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (ready && !activeDay) setScope("all");
  }, [ready, activeDay]);

  const doVoid = async (p: Payment) => {
    setVoiding(null);
    try {
      const r = await api<{ membership_removed: boolean }>(`/api/admin/payments/${p.id}/void`, { body: { reason: "Cancelled from the Cash page" } });
      setMsg(`Cancelled ${fmtDT(p.amount)} from ${p.attendee_name}.${r.membership_removed ? " Their desk membership was removed too." : ""} Their check-in stays; undo it separately if needed.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const mine = data?.by_staff.find((s) => s.staff_id === me?.id);

  return (
    <Page title="Cash">
      {!event ? (
        <NeedEvent />
      ) : (
        <>
          <div className="-mt-2">
            <Segmented<"day" | "all">
              value={scope}
              onChange={setScope}
              options={[
                { value: "day", label: activeDay ? `Today · ${activeDay.label || activeDay.day_date}` : "Today" },
                { value: "all", label: "All days" },
              ]}
            />
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {msg && <Notice tone="ok">{msg}</Notice>}
          {!data && !error && <Spinner />}
          {data && (
            <>
              <section className="rounded-[16px] bg-bg2 p-5">
                <p className="t-footnote font-semibold uppercase tracking-wide text-label2">{scope === "day" ? "Collected today" : "Collected, all days"}</p>
                <p className="mt-1 font-rounded text-[52px] font-bold leading-none tabular">{fmtDT(data.total)}</p>
                <p className="t-subhead mt-3 text-label2">
                  You: <span className="font-semibold text-label tabular">{fmtDT(mine?.total ?? 0)}</span>
                  {mine && ` · ${mine.memberships} membership${mine.memberships === 1 ? "" : "s"}, ${mine.entries} entr${mine.entries === 1 ? "y" : "ies"}`}
                </p>
              </section>

              {data.by_staff.length > 0 && (
                <Section header="By staff member" footer="Each person hands over the cash they took. Totals leave out cancelled payments.">
                  {data.by_staff.map((s) => (
                    <div key={s.staff_id} className="flex min-h-[52px] items-center gap-3 px-4 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="t-body">
                          {s.staff_name}
                          {s.staff_id === me?.id && <span className="text-label2"> (you)</span>}
                        </p>
                        <p className="t-footnote text-label2">
                          {s.memberships} membership{s.memberships === 1 ? "" : "s"} · {s.entries} entr{s.entries === 1 ? "y" : "ies"}
                        </p>
                      </div>
                      <span className="t-headline tabular">{fmtDT(s.total)}</span>
                    </div>
                  ))}
                </Section>
              )}

              {data.payments.length === 0 ? (
                <p className="t-subhead py-6 text-center text-label2">No payments yet.</p>
              ) : (
                <Section header="Payments" footer={me?.role === "admin" ? "Tap a payment to cancel it if it was entered by mistake." : "Only an admin can cancel a payment."}>
                  {data.payments.map((p) => {
                    const row = (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className={`t-body truncate ${p.voided_at ? "text-label2 line-through" : ""}`}>{p.attendee_name}</p>
                          <p className="t-footnote text-label2">
                            {fmtTime(p.created_at)} · {p.staff_name} · {p.kind === "membership" ? "Membership" : "Entry"}
                            {scope === "all" && ` · ${p.day_label}`}
                            {p.voided_at && ` · cancelled by ${p.voided_by}`}
                          </p>
                        </div>
                        <span className={`t-body tabular ${p.voided_at ? "text-label3 line-through" : ""}`}>{fmtDT(p.amount)}</span>
                      </>
                    );
                    return me?.role === "admin" && !p.voided_at ? (
                      <button key={p.id} type="button" onClick={() => setVoiding(p)} className="flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left active:bg-bg4">
                        {row}
                      </button>
                    ) : (
                      <div key={p.id} className="flex min-h-[52px] items-center gap-3 px-4 py-2">
                        {row}
                      </div>
                    );
                  })}
                </Section>
              )}
            </>
          )}

          <Sheet
            open={!!voiding}
            onClose={() => setVoiding(null)}
            title={voiding ? `Cancel ${fmtDT(voiding.amount)} from ${voiding.attendee_name}?` : undefined}
            message="Use this only for a payment entered by mistake. A membership bought with it is removed too."
          >
            <SheetAction destructive onClick={() => voiding && doVoid(voiding)}>
              Cancel Payment
            </SheetAction>
          </Sheet>
        </>
      )}
    </Page>
  );
}
