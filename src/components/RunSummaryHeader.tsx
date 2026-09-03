"use client";

import type { DisplayStatus } from "@/lib/types";
import { StatusBadge } from "./ui";

/**
 * The answer, above the fold.
 *
 * Everything this tool exists to produce — who the business is, who runs it,
 * which address was approved, and the email itself — used to be scattered down
 * a column of equal-weight cards, so finding any of it meant scrolling past
 * all of it. This puts the four facts and the one action at the top, and lets
 * the detail panels below stay detail.
 */
export function RunSummaryHeader({
  url,
  status,
  business,
  founder,
  founderRole,
  approvedEmail,
  verification,
  contactCount,
  hasEmail,
  onViewEmail,
}: {
  url: string;
  status: DisplayStatus;
  business: string | null;
  founder: string | null;
  founderRole?: string | null;
  approvedEmail: string | null;
  verification?: string | null;
  contactCount: number;
  hasEmail: boolean;
  onViewEmail?: () => void;
}) {
  return (
    <section className="animate-rise overflow-hidden rounded-panel border border-line-accent/45 bg-surface shadow-lift">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 pb-4 pt-4">
        {/*
          * basis-0 matters as much as min-w-0 here. Under flex-wrap a flex-1
          * child sizes from its content, so a 300-character tracked URL made
          * the header — and the whole column — wider than the viewport.
          */}
        <div className="min-w-0 flex-1 basis-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="truncate text-[17px] font-semibold tracking-tight text-ink-strong">
              {business ?? "Business not identified"}
            </h2>
            <StatusBadge status={status} size="sm" />
          </div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 block max-w-full truncate font-mono text-xs text-ink-subtle transition-colors hover:text-accent"
            title={url}
          >
            {url.replace(/^https?:\/\//, "").replace(/^www\./, "")}
          </a>
        </div>

        {/* The one action worth promoting: reading what was written. */}
        {hasEmail && onViewEmail && (
          <button
            type="button"
            onClick={onViewEmail}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-on-solid shadow-flat transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-accent-hover active:scale-[0.98]"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.75" stroke="currentColor" strokeWidth="1.4" />
              <path d="M2.5 4.5 8 8.75 13.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            View generated email
          </button>
        )}
      </div>

      {/* The four facts, on one line, each answering a different question. */}
      <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
        <Fact label="Founder" value={founder} hint={founderRole} />
        <Fact
          label="Approved email"
          value={approvedEmail}
          hint={approvedEmail ? verificationLabel(verification) : "none approved yet"}
          mono
          tone={approvedEmail ? "good" : "pending"}
        />
        <Fact
          label="Addresses found"
          value={contactCount > 0 ? String(contactCount) : null}
          hint={contactCount > 0 ? "review and approve one" : "none discovered"}
        />
        <Fact
          label="Outreach email"
          value={hasEmail ? "Written" : null}
          hint={hasEmail ? "ready to review" : "not generated yet"}
          tone={hasEmail ? "good" : "pending"}
        />
      </dl>
    </section>
  );
}

function Fact({
  label,
  value,
  hint,
  mono,
  tone = "neutral",
}: {
  label: string;
  value: string | null;
  hint?: string | null;
  mono?: boolean;
  tone?: "neutral" | "good" | "pending";
}) {
  const valueTone = tone === "good" ? "text-ink" : tone === "pending" ? "text-ink-subtle" : "text-ink";

  return (
    <div className="bg-surface px-5 py-3.5">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-subtle">{label}</dt>
      <dd
        className={`mt-1 truncate text-[13px] font-medium ${valueTone} ${mono ? "font-mono text-xs" : ""}`}
        title={value ?? undefined}
      >
        {value ?? <span className="font-sans font-normal text-ink-subtle">—</span>}
      </dd>
      {hint && <p className="mt-0.5 truncate text-[11px] text-ink-subtle">{hint}</p>}
    </div>
  );
}

/** Three outcomes, not two — "accepts all" is neither proof nor refutation. */
function verificationLabel(result: string | null | undefined): string {
  if (!result) return "not checked";
  if (result === "valid") return "mailbox confirmed";
  if (result === "catchall") return "accepts all mail — unproven";
  if (result === "invalid") return "would bounce";
  return result;
}
