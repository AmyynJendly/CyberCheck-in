"use client";

import { AdminTitle } from "@/components/admin/AdminShell";
import { StaffAdmin } from "@/components/admin/StaffAdmin";

export default function AdminStaffPage() {
  return (
    <>
      <AdminTitle title="Staff" />
      <div className="max-w-2xl">
        <StaffAdmin />
      </div>
    </>
  );
}
