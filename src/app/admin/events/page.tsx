"use client";

import { AdminTitle } from "@/components/admin/AdminShell";
import { EventsAdmin } from "@/components/admin/EventsAdmin";

export default function AdminEventsPage() {
  return (
    <>
      <AdminTitle title="Events" subtitle="Days, entry rules, seats, the Google Form connection." />
      <div className="max-w-2xl">
        <EventsAdmin />
      </div>
    </>
  );
}
