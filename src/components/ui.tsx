"use client";

import Link from "next/link";
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, ChevronsUpDown, CircleAlert, CircleCheck, Info, Search, TriangleAlert, WifiOff, X } from "lucide-react";
import { isOnline, subscribeOnline } from "./api";
import { useApp } from "./AppContext";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = "filled" | "tinted" | "gray" | "destructive" | "plain";
type Size = "large" | "medium" | "small";

const VARIANT: Record<Variant, string> = {
  filled: "bg-accent text-on-accent active:opacity-80",
  tinted: "bg-accent/15 text-accent active:bg-accent/25",
  gray: "bg-fill text-label active:bg-fill2",
  destructive: "bg-sys-red/15 text-sys-red active:bg-sys-red/25",
  plain: "bg-transparent text-accent active:opacity-50",
};
const SIZE: Record<Size, string> = {
  large: "h-[50px] px-5 rounded-[12px] t-headline",
  medium: "h-[38px] px-4 rounded-[10px] t-subhead font-semibold",
  small: "h-[30px] px-3 rounded-full t-footnote font-semibold",
};

export function btn(variant: Variant = "filled", size: Size = "medium"): string {
  return cx(
    "inline-flex items-center justify-center gap-1.5 select-none whitespace-nowrap transition-[opacity,background-color] duration-150 disabled:opacity-35 disabled:pointer-events-none",
    VARIANT[variant],
    SIZE[size],
  );
}

export function Button({
  variant = "filled",
  size = "medium",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type="button" {...props} className={cx(btn(variant, size), className)} />;
}

// ---------------------------------------------------------------------------
// Grouped inset lists (iOS Settings style)
// ---------------------------------------------------------------------------

export function Section({
  header,
  footer,
  children,
  className,
  inset = 16,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Left inset of row separators (60 when rows start with an IconTile). */
  inset?: number;
}) {
  const rows = Children.toArray(children); // drops null / false / undefined
  return (
    <section className={className}>
      {header && <h2 className="t-footnote mb-1.5 px-4 uppercase text-label2">{header}</h2>}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-[12px] bg-bg2">
          {rows.map((row, i) => (
            <div key={isValidElement(row) && row.key != null ? row.key : i} className="relative">
              {row}
              {i < rows.length - 1 && <div className="pointer-events-none absolute bottom-0 right-0 h-px scale-y-50 bg-sep" style={{ left: inset }} />}
            </div>
          ))}
        </div>
      )}
      {footer && <div className="t-footnote mt-1.5 px-4 text-label2">{footer}</div>}
    </section>
  );
}

/** Small rounded square with a white glyph, like iOS Settings icons. */
export function IconTile({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span className={cx("grid h-[29px] w-[29px] shrink-0 place-items-center rounded-[7px] text-white", color)} aria-hidden>
      {children}
    </span>
  );
}

interface RowProps {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  value?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  destructive?: boolean;
  accent?: boolean;
  href?: string;
  external?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

export function Row({ icon, title, subtitle, value, trailing, chevron, destructive, accent, href, external, onClick, disabled }: RowProps) {
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className={cx("block t-body", destructive && "text-sys-red", accent && "text-accent")}>{title}</span>
        {subtitle && <span className="mt-0.5 block t-subhead text-label2">{subtitle}</span>}
      </span>
      {value !== undefined && <span className="t-body shrink-0 text-label2">{value}</span>}
      {trailing}
      {chevron && <ChevronRight className="h-[18px] w-[18px] shrink-0 text-label3" strokeWidth={2.5} aria-hidden />}
    </>
  );
  const cls = cx(
    "flex min-h-[44px] w-full items-center gap-3 px-4 py-[11px] text-left",
    (href || onClick) && !disabled && "active:bg-bg4 transition-colors",
    disabled && "opacity-40",
  );
  if (href && !disabled) {
    return external ? (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {body}
      </a>
    ) : (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} disabled={disabled} className={cls}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** A form row: label on the left, field on the right (iOS form style). */
export function FieldRow({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="flex min-h-[44px] items-center gap-3 px-4">
      <span className="t-body w-[104px] shrink-0">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

export const fieldClass =
  "w-full bg-transparent py-[11px] t-body text-label placeholder:text-label3 outline-none focus-visible:outline-none";

export function TextField(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(fieldClass, props.className)} />;
}

/** Native <select> dressed as an iOS menu row value. */
export function MenuSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  const current = options.find((o) => o.value === value)?.label ?? "";
  return (
    <span className="relative inline-flex items-center gap-1 text-label2">
      <span className="t-body max-w-[52vw] truncate">{current}</span>
      <ChevronsUpDown className="h-4 w-4 shrink-0" aria-hidden />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex h-9 items-center gap-1.5 rounded-[10px] bg-fill px-2 text-label2">
      <Search className="h-[17px] w-[17px] shrink-0" strokeWidth={2.4} aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        className="t-body min-w-0 flex-1 bg-transparent text-label placeholder:text-label2 outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label="Clear" className="grid h-5 w-5 place-items-center rounded-full bg-label3 text-bg2">
          <X className="h-3 w-3" strokeWidth={3} />
        </button>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div role="tablist" className="grid rounded-[9px] bg-fill p-[2px]" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-7 rounded-[7px] t-footnote font-semibold transition-colors",
            o.value === value ? "bg-[#636366] text-label shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)]" : "text-label",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40",
        checked ? "bg-sys-green" : "bg-fill2",
      )}
    >
      <span
        className={cx(
          "absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_3px_1px_rgba(0,0,0,0.06)] transition-[left] duration-200",
          checked ? "left-[22px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

type Tone = "info" | "ok" | "warn" | "error";
const TONE: Record<Tone, { cls: string; Icon: typeof Info }> = {
  info: { cls: "bg-bg2 text-label", Icon: Info },
  ok: { cls: "bg-sys-green/15 text-sys-green", Icon: CircleCheck },
  warn: { cls: "bg-sys-orange/15 text-sys-orange", Icon: TriangleAlert },
  error: { cls: "bg-sys-red/15 text-sys-red", Icon: CircleAlert },
};

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  const { cls, Icon } = TONE[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex items-start gap-2.5 rounded-[12px] px-3.5 py-3 t-subhead", cls)}>
      <Icon className="mt-px h-[18px] w-[18px] shrink-0" strokeWidth={2.2} aria-hidden />
      <div className="min-w-0 flex-1 [&_a]:font-semibold [&_a]:underline">{children}</div>
    </div>
  );
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(isOnline());
    return subscribeOnline(setOnline);
  }, []);
  return online;
}

export function OfflineBanner({ floating }: { floating?: boolean }) {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="alert"
      className={cx(
        "z-50 flex items-center justify-center gap-2 bg-sys-red px-4 py-2 t-footnote font-semibold text-white",
        floating ? "fixed inset-x-0 top-0 pt-[max(0.5rem,env(safe-area-inset-top))]" : "sticky top-0",
      )}
    >
      <WifiOff className="h-4 w-4" strokeWidth={2.5} aria-hidden />
      No connection · scans are not being saved
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet (replaces confirm()/prompt())
// ---------------------------------------------------------------------------

export function Sheet({ open, onClose, title, message, children }: { open: boolean; onClose: () => void; title?: string; message?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="anim-fade absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="anim-sheet relative w-full max-w-lg space-y-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="overflow-hidden rounded-[14px] bg-bg3/95 backdrop-blur-xl">
          {(title || message) && (
            <div className="px-4 pb-3 pt-4 text-center">
              {title && <p className="t-footnote font-semibold text-label2">{title}</p>}
              {message && <div className="mt-1 t-footnote text-label2">{message}</div>}
            </div>
          )}
          {children}
        </div>
        <button type="button" onClick={onClose} className="h-[57px] w-full rounded-[14px] bg-bg3 t-body font-semibold text-accent active:bg-bg4">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SheetAction({ children, onClick, destructive, disabled }: { children: ReactNode; onClick: () => void; destructive?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "relative h-[57px] w-full border-t border-sep/60 t-body active:bg-bg4 disabled:opacity-40",
        destructive ? "text-sys-red" : "text-accent",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page chrome: translucent nav bar + large title that collapses on scroll
// ---------------------------------------------------------------------------

export function Page({
  title,
  children,
  back = { href: "/", label: "Home" },
  trailing,
  showContext = true,
}: {
  title: string;
  children: ReactNode;
  back?: { href: string; label: string } | null;
  trailing?: ReactNode;
  showContext?: boolean;
}) {
  const { event, activeDay, ready } = useApp();
  const [scrolled, setScrolled] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const onScroll = () => {
      const el = titleRef.current;
      setScrolled(el ? el.getBoundingClientRect().bottom < 52 : window.scrollY > 40);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-[max(2rem,env(safe-area-inset-bottom))]">
      <OfflineBanner />
      <header
        className={cx(
          "sticky top-0 z-40 pt-[env(safe-area-inset-top)] transition-colors duration-200",
          scrolled ? "bg-bg/75 backdrop-blur-xl backdrop-saturate-150" : "bg-bg",
        )}
      >
        <div className="relative flex h-[44px] items-center justify-between px-2">
          {back ? (
            <Link href={back.href} className="flex items-center text-accent active:opacity-50">
              <ChevronLeft className="h-7 w-7" strokeWidth={2.4} aria-hidden />
              <span className="t-body -ml-0.5">{back.label}</span>
            </Link>
          ) : (
            <span />
          )}
          <span
            className={cx(
              "pointer-events-none absolute left-1/2 -translate-x-1/2 t-headline transition-opacity duration-150",
              scrolled ? "opacity-100" : "opacity-0",
            )}
          >
            {title}
          </span>
          <div className="flex items-center gap-1 pr-2">{trailing}</div>
        </div>
        <div className={cx("h-px scale-y-50 transition-colors", scrolled ? "bg-sep" : "bg-transparent")} />
      </header>
      <div className="px-4">
        <h1 ref={titleRef} className="t-large pt-1">
          {title}
        </h1>
        {showContext && ready && event && (
          <p className="t-subhead mt-0.5 text-label2">
            {event.name} · {activeDay ? activeDay.label || activeDay.day_date : "No event day today"}
          </p>
        )}
      </div>
      <main className="mt-5 space-y-7 px-4">{children}</main>
    </div>
  );
}

/** Shown when a page needs a selected event. */
export function NeedEvent() {
  return (
    <Notice tone="warn">
      No event selected. <Link href="/">Choose an event</Link> first.
    </Notice>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 t-subhead text-label2" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-label3 border-t-label" aria-hidden />
      {label}
    </div>
  );
}

export function Initials({ name, size = 40 }: { name: string; size?: number }) {
  const parts = name.trim().split(/\s+/);
  const letters = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-gradient-to-b from-[#a5a5aa] to-[#86868b] font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden
    >
      {letters}
    </span>
  );
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tunis", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Tunis",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
