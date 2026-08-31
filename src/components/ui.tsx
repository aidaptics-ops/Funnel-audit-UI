"use client";

import { useEffect, useState, type ReactNode } from "react";
import { STATUS_LABEL, type DisplayStatus } from "@/lib/types";

/**
 * Shared primitives. Every colour is an explicit token from globals.css —
 * nothing relies on inherited colour, so no ancestor rule can wash the text out.
 */

export function Card({
  title,
  subtitle,
  action,
  children,
  padded = true,
  tone = "default",
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** Off for tables and lists that manage their own edges. */
  padded?: boolean;
  /** "feature" lifts a card that carries the page's primary answer. */
  tone?: "default" | "feature";
  className?: string;
}) {
  const shell =
    tone === "feature"
      ? "border-line-accent/45 bg-surface shadow-lift"
      : "border-line bg-surface shadow-panel";

  return (
    <section className={`animate-rise rounded-panel border ${shell} ${className}`}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
            )}
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-ink-subtle">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className={padded ? "px-5 py-4" : ""}>{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  size = "md",
  disabled,
  type = "button",
  title,
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  full?: boolean;
}) {
  const variants = {
    primary:
      "bg-accent text-white shadow-flat hover:bg-accent-hover active:scale-[0.98] disabled:bg-line-strong disabled:text-ink-subtle disabled:shadow-none disabled:active:scale-100",
    secondary:
      "border border-line-strong bg-surface text-ink shadow-flat hover:bg-surface-sunken active:scale-[0.98] disabled:text-ink-subtle disabled:shadow-none disabled:hover:bg-surface disabled:active:scale-100",
    ghost:
      "text-ink-muted hover:bg-surface-sunken hover:text-ink active:scale-[0.98] disabled:text-ink-subtle disabled:active:scale-100",
    danger:
      "border border-broken/25 bg-surface text-broken shadow-flat hover:bg-broken-soft active:scale-[0.98]",
  }[variant];

  const sizes = { sm: "px-2.5 py-1 text-xs", md: "px-3.5 py-2 text-[13px]" }[size];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[background-color,box-shadow,transform,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] disabled:cursor-not-allowed ${variants} ${sizes} ${
        full ? "w-full" : ""
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Status, colour-coded by what it asks of the person reading it:
 * grey = wait, blue = working, amber = your turn, green = done, red = broken.
 */
const STATUS_STYLES: Record<DisplayStatus, string> = {
  queued: "bg-idle-soft text-idle ring-1 ring-line-strong",
  analyzing: "bg-busy-soft text-busy ring-1 ring-busy/20",
  generating: "bg-busy-soft text-busy ring-1 ring-busy/20",
  ready: "bg-done-soft text-done ring-1 ring-done/25",
  needs_review: "bg-review-soft text-review ring-1 ring-review/30",
  approved: "bg-done text-white",
  saved: "bg-ink text-white",
  failed: "bg-broken-soft text-broken ring-1 ring-broken/25",
};

export function StatusBadge({ status, size = "md" }: { status: DisplayStatus; size?: "sm" | "md" }) {
  const working = status === "analyzing" || status === "generating";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap ${
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"
      } ${STATUS_STYLES[status]}`}
    >
      {working && <Spinner />}
      {status === "needs_review" && <span aria-hidden>●</span>}
      {STATUS_LABEL[status]}
    </span>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-critical-soft text-critical ring-critical/25",
  high: "bg-high-soft text-high ring-high/25",
  medium: "bg-medium-soft text-medium ring-medium/25",
  low: "bg-low-soft text-low ring-line-strong",
  informational: "bg-surface-sunken text-ink-subtle ring-line",
};

export function SeverityPill({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ${
        SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.low
      }`}
    >
      {severity}
    </span>
  );
}

export function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd
        className={`mt-1 truncate text-[13px] text-ink ${mono ? "font-mono text-xs" : ""}`}
        title={typeof value === "string" ? value : undefined}
      >
        {value || <span className="text-ink-subtle">—</span>}
      </dd>
    </div>
  );
}

/**
 * An empty state that says what to do next.
 *
 * "No funnels yet" tells someone nothing; the point of this component is that
 * every empty region of the app explains itself.
 */
export function Empty({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      {title && <p className="text-[13px] font-medium text-ink">{title}</p>}
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-ink-subtle">{children}</p>
    </div>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "error" | "success";
  title?: string;
  children: ReactNode;
}) {
  const styles = {
    info: "border-line bg-surface-sunken text-ink-muted",
    warn: "border-review/30 bg-review-soft text-ink",
    error: "border-broken/30 bg-broken-soft text-broken",
    success: "border-done/30 bg-done-soft text-ink",
  }[tone];
  return (
    <div className={`rounded-lg border px-3.5 py-2.5 text-[13px] leading-relaxed ${styles}`}>
      {title && <p className="mb-0.5 font-semibold">{title}</p>}
      {children}
    </div>
  );
}

/** A labelled number, used for the audit's counts. */
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "muted" }) {
  return (
    <div className="rounded-lg bg-surface-sunken px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">{label}</p>
      <p
        data-numeric
        className={`mt-1 text-[13px] font-semibold ${tone === "muted" ? "text-ink-muted" : "text-ink"}`}
      >
        {value}
      </p>
    </div>
  );
}

/** A headline number for the top of a page. Clickable when it filters a list. */
export function Metric({
  label,
  value,
  tone = "neutral",
  active,
  onClick,
}: {
  label: string;
  /** A count, or a pre-formatted figure such as money. */
  value: number | string;
  tone?: "neutral" | "busy" | "review" | "done" | "broken";
  active?: boolean;
  onClick?: () => void;
}) {
  const accents = {
    neutral: "text-ink",
    busy: "text-busy",
    review: "text-review",
    done: "text-done",
    broken: "text-broken",
  }[tone];

  const shell = active
    ? "border-line-accent bg-accent-soft shadow-flat"
    : "border-line bg-surface hover:border-line-strong hover:shadow-panel";

  const content = (
    <>
      <p data-numeric className={`text-xl font-semibold tracking-tight ${accents}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] font-medium tracking-wide text-ink-subtle">{label}</p>
    </>
  );

  if (!onClick) {
    return <div className={`rounded-lg border px-3.5 py-2.5 ${shell}`}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-3.5 py-2.5 text-left transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] ${shell}`}
    >
      {content}
    </button>
  );
}

/** Batch progress. Shown only while a batch is actually running. */
export function Progress({ done, total }: { done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink">
          {done} of {total} analysed
        </span>
        <span data-numeric className="text-ink-subtle">
          {percent}%
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={total}
        />
      </div>
    </div>
  );
}

/**
 * A short relative time — "4m ago" reads faster than an ISO string.
 *
 * "Now" is read after mount rather than during render. Reading the clock while
 * rendering is impure, and on a server-rendered page it also guarantees a
 * hydration mismatch, because the server and the browser render it at
 * different instants. Until then it shows the absolute date, which is correct
 * in both places.
 */
export function Ago({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Both updates happen in a callback rather than in the effect body, so the
    // first paint is not followed by an immediate second render.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  if (!iso) return <span className="text-ink-subtle">—</span>;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return <span className="text-ink-subtle">—</span>;

  const label = now === null ? absolute(then) : relative(then, now);

  return (
    <time dateTime={iso} title={new Date(then).toLocaleString()} className="text-ink-subtle">
      {label}
    </time>
  );
}

function relative(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d ago`;
  return absolute(then);
}

function absolute(then: number): string {
  return new Date(then).toISOString().slice(0, 10);
}
