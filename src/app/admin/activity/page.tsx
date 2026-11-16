"use client";

import { AdminTitle } from "@/components/admin/AdminShell";
import { AuditAdmin } from "@/components/admin/AuditAdmin";

export default function AdminActivityPage() {
  return (
    <>
      <AdminTitle title="Activity" subtitle="Everything everyone did, newest first." />
      <div className="max-w-3xl">
        <AuditAdmin />
      </div>
    </>
  );
}
