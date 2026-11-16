"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { Notice, Row, Section, Sheet, SheetAction, fmtDateTime } from "../ui";

interface Claim {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  claimed_by: string | null;
  events: string | null;
  updated_at: string;
}

/** People HR admitted as "already a member, not on the list". Confirm or reject each one. */
export function MemberReview() {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [open, setOpen] = useState<Claim | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setClaims((await api<{ members: Claim[] }>("/api/admin/members/review")).members);
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (c: Claim, decision: "confirm" | "reject") => {
    setOpen(null);
    try {
      await api(`/api/admin/members/${c.id}/review`, { body: { decision } });
      setMsg({
        tone: "ok",
        text: decision === "confirm" ? `${c.full_name} confirmed as a member.` : `${c.full_name} is no longer a member; they'll be asked to pay next time.`,
      });
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) });
    }
  };

  if (!claims?.length && !msg) return null;
  return (
    <div className="space-y-3">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {claims && claims.length > 0 && (
        <Section
          header={`To check · ${claims.length} said “already a member”`}
          footer="HR let these people in as members without payment because they weren't on the list. Check your records, then confirm or reject each one."
        >
          {claims.map((c) => (
            <Row
              key={c.id}
              title={c.full_name}
              subtitle={[c.email, c.phone, c.claimed_by && `by ${c.claimed_by}`, fmtDateTime(c.updated_at), c.events].filter(Boolean).join(" · ")}
              chevron
              onClick={() => setOpen(c)}
            />
          ))}
        </Section>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.full_name} message="Is this person really a club member?">
        <SheetAction onClick={() => open && decide(open, "confirm")}>Confirm Member</SheetAction>
        <SheetAction destructive onClick={() => open && decide(open, "reject")}>
          Not a Member
        </SheetAction>
      </Sheet>
    </div>
  );
}
