"use client";

import type { OwnerSearch } from "@/lib/types";
import { Card } from "./ui";

/**
 * The owner search, showing its working.
 *
 * This is the one part of the app that spends money on several providers,
 * makes a factual claim about a named human, and then recommends writing to
 * them. Presenting only the answer would ask the operator to trust it blind —
 * so every stage, what it cost, every address considered and every source is
 * on screen. If the answer is wrong, it should be visibly wrong.
 */
export function OwnerSearchPanel({ search }: { search: OwnerSearch }) {
  const chosen = search.chosen;

  return (
    <Card
      title="Owner search"
      subtitle={search.companyName ? `Company identified as ${search.companyName}` : undefined}
    >
      <div
        className={`rounded-lg border p-3.5 ${
          chosen?.verification.confirmed
            ? "border-done/40 bg-done-soft"
            : chosen
              ? "border-review/40 bg-review-soft"
              : "border-line-strong bg-surface-sunken"
        }`}
      >
        {search.founderName ? (
          <p className="text-[13px] font-medium text-ink">
            {search.founderName}
            {search.founderTitle && <span className="font-normal text-ink-muted"> · {search.founderTitle}</span>}
          </p>
        ) : (
          <p className="text-[13px] font-medium text-ink">No owner identified</p>
        )}

        {chosen ? (
          <>
            <p className="mt-1.5 font-mono text-[13px] text-ink">{chosen.address}</p>
            <p className="mt-1 text-xs text-ink-muted">
              {chosen.verification.summary} <span className="text-ink-subtle">· via {chosen.source}</span>
            </p>
          </>
        ) : (
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{search.reason}</p>
        )}
      </div>

      {search.candidates.length > 0 && (
        <div className="mt-4 border-t border-line pt-3.5">
          <SectionLabel>Addresses considered</SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {search.candidates.map((candidate) => (
              <li key={candidate.address} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-mono text-xs text-ink">{candidate.address}</span>
                <Verdict result={candidate.verification?.result ?? null} />
                <span className="text-xs text-ink-subtle">{candidate.source}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {search.evidence.length > 0 && (
        <div className="mt-4 border-t border-line pt-3.5">
          <SectionLabel>Evidence</SectionLabel>
          <ul className="mt-2 space-y-2">
            {search.evidence.map((entry, index) => (
              <li key={index} className="text-xs leading-relaxed">
                <p className="text-ink-muted">{entry.claim}</p>
                <a
                  href={entry.source}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate font-mono text-[11px] text-accent hover:underline"
                >
                  {entry.source}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-4 border-t border-line pt-3.5">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
          What it did ({search.steps.length} steps)
        </summary>
        <ul className="mt-2 space-y-1">
          {search.steps.map((step, index) => (
            <li key={index} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <span className="text-ink">{step.name}</span>
              <span className="flex-1 truncate text-ink-subtle">{step.outcome}</span>
              <span
                className={`shrink-0 font-medium ${
                  step.cost === "free" || step.cost === "none" ? "text-ink-subtle" : "text-review"
                }`}
              >
                {step.cost}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

/**
 * Three outcomes, not two. "Catch-all" is a domain that accepts mail for every
 * address, so it neither confirms nor refutes the mailbox — showing it as a
 * tick would be a lie, and as a cross would throw away a usable lead.
 */
function Verdict({ result }: { result: string | null }) {
  if (!result) {
    return <Tag tone="muted">not checked</Tag>;
  }
  if (result === "valid") return <Tag tone="ok">confirmed</Tag>;
  if (result === "invalid" || result === "disposable") return <Tag tone="bad">{result}</Tag>;
  return <Tag tone="warn">{result === "catchall" ? "accepts all" : result}</Tag>;
}

function Tag({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  const styles = {
    ok: "bg-done-soft text-done",
    warn: "bg-review-soft text-review",
    bad: "bg-broken-soft text-broken",
    muted: "bg-surface-sunken text-ink-subtle ring-1 ring-line",
  }[tone];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles}`}>
      {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">{children}</p>;
}
