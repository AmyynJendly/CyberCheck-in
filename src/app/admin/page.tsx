"use client";

import { useState } from "react";
import { Page, Segmented } from "@/components/ui";
import { EventsAdmin } from "@/components/admin/EventsAdmin";
import { StaffAdmin } from "@/components/admin/StaffAdmin";
import { EmailsAdmin } from "@/components/admin/EmailsAdmin";
import { AuditAdmin } from "@/components/admin/AuditAdmin";
import { MembersAdmin } from "@/components/admin/MembersAdmin";

type Tab = "events" | "members" | "staff" | "emails" | "audit";

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("events");
  return (
    <Page title="Admin" showContext={false}>
      <div className="-mt-2">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "events", label: "Events" },
            { value: "members", label: "Members" },
            { value: "staff", label: "Staff" },
            { value: "emails", label: "Emails" },
            { value: "audit", label: "Activity" },
          ]}
        />
      </div>
      {tab === "events" && <EventsAdmin />}
      {tab === "members" && <MembersAdmin />}
      {tab === "staff" && <StaffAdmin />}
      {tab === "emails" && <EmailsAdmin />}
      {tab === "audit" && <AuditAdmin />}
    </Page>
  );
}
