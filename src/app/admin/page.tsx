"use client";

import { useState } from "react";
import { Page } from "@/components/ui";
import { EventsAdmin } from "@/components/admin/EventsAdmin";
import { StaffAdmin } from "@/components/admin/StaffAdmin";
import { EmailsAdmin } from "@/components/admin/EmailsAdmin";
import { AuditAdmin } from "@/components/admin/AuditAdmin";

const TABS = [
  { id: "events", label: "Events" },
  { id: "staff", label: "Staff" },
  { id: "emails", label: "Emails" },
  { id: "audit", label: "Audit log" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("events");
  return (
    <Page title="Admin">
      <nav className="grid grid-cols-4 gap-1 rounded-2xl bg-slate-900 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-xl py-2 text-sm font-semibold ${tab === t.id ? "bg-teal-500 text-slate-950" : "text-slate-300"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "events" && <EventsAdmin />}
      {tab === "staff" && <StaffAdmin />}
      {tab === "emails" && <EmailsAdmin />}
      {tab === "audit" && <AuditAdmin />}
    </Page>
  );
}
