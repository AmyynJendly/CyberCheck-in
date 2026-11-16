"use client";

import { AdminTitle } from "@/components/admin/AdminShell";
import { MembersAdmin } from "@/components/admin/MembersAdmin";
import { MemberReview } from "@/components/admin/MemberReview";

export default function AdminMembersPage() {
  return (
    <>
      <AdminTitle title="Members" subtitle="The club membership list. Members get in free on members-only days." />
      <div className="max-w-2xl space-y-8">
        <MemberReview />
        <MembersAdmin />
      </div>
    </>
  );
}
