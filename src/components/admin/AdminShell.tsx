"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Banknote, CalendarDays, ChevronLeft, IdCard, LayoutDashboard, Mail, ScrollText, UserCog, Users } from "lucide-react";
import { useApp } from "../AppContext";
import { MenuSelect, OfflineBanner } from "../ui";

const NAV = [
  { href: "/admin", label: "Overview", Icon: LayoutDashboard },
  { href: "/admin/people", label: "People", Icon: Users },
  { href: "/admin/cash", label: "Cash", Icon: Banknote },
  { href: "/admin/emails", label: "Emails", Icon: Mail },
  { href: "/admin/members", label: "Members", Icon: IdCard },
  { href: "/admin/activity", label: "Activity", Icon: ScrollText },
  { href: "/admin/staff", label: "Staff", Icon: UserCog },
  { href: "/admin/events", label: "Events", Icon: CalendarDays },
] as const;

/** Admin dashboard frame: sidebar on wide screens, scrolling tab bar on phones. */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { events, event, selectEvent } = useApp();
  const active = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));

  const eventPicker =
    events.length > 1 ? (
      <MenuSelect label="Event" value={event?.id ?? ""} onChange={(v) => selectEvent(v || null)} options={events.map((e) => ({ value: e.id, label: e.name }))} />
    ) : (
      <span className="t-subhead truncate text-label2">{event?.name ?? "No active event"}</span>
    );

  return (
    <div className="min-h-dvh lg:flex">
      <OfflineBanner />
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-sep/60 bg-bg2/60 px-3 pb-4 pt-5 lg:flex">
        <Link href="/" className="mb-4 flex items-center gap-1 px-2 t-subhead text-accent active:opacity-50">
          <ChevronLeft className="h-5 w-5" strokeWidth={2.4} aria-hidden />
          Check-in app
        </Link>
        <p className="px-2 t-title3">Admin</p>
        <div className="mb-4 mt-1 px-2">{eventPicker}</div>
        <nav className="space-y-0.5" aria-label="Admin sections">
          {NAV.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? "page" : undefined}
              className={`flex items-center gap-3 rounded-[10px] px-3 py-2 t-body ${active(href) ? "bg-accent/15 font-semibold text-accent" : "text-label hover:bg-fill"}`}
            >
              <Icon className="h-5 w-5" strokeWidth={2} aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Header + tabs (phones / tablets) */}
      <div className="sticky top-0 z-30 border-b border-sep/60 bg-bg/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl lg:hidden">
        <div className="flex h-11 items-center justify-between gap-3 px-2">
          <Link href="/" className="flex items-center text-accent active:opacity-50">
            <ChevronLeft className="h-7 w-7" strokeWidth={2.4} aria-hidden />
            <span className="t-body -ml-0.5">Check-in</span>
          </Link>
          <div className="min-w-0 pr-2">{eventPicker}</div>
        </div>
        <nav className="flex gap-1.5 overflow-x-auto px-3 pb-2.5 [scrollbar-width:none]" aria-label="Admin sections">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? "page" : undefined}
              className={`shrink-0 rounded-full px-3.5 py-1.5 t-subhead font-semibold ${active(href) ? "bg-accent text-on-accent" : "bg-fill text-label"}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>

      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-5 lg:px-8 lg:pt-8">{children}</main>
    </div>
  );
}

export function AdminTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="t-large">{title}</h1>
        {subtitle && <p className="t-subhead mt-0.5 text-label2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
