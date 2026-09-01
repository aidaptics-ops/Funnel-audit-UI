"use client";

import { useState } from "react";
import { evidenceText } from "@/lib/audit/normalize";
import type { NormalizedAudit } from "@/lib/types";
import { Card, Field, SeverityPill } from "./ui";

/** Read-only view of one audit. Every value here came from the audit API. */
export function AuditPanel({ audit }: { audit: NormalizedAudit }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const counts = audit.issueCounts;

  return (
    <div className="space-y-4">
      <Card title="Funnel">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Domain" value={audit.domain} />
          <Field label="Brand" value={audit.brand} />
          <Field label="Funnel type" value={audit.funnelType} />
          <Field label="Page type" value={audit.pageType} />
          <Field label="Conversion goal" value={audit.conversionGoal} />
          <Field label="Primary CTA" value={audit.primaryCta} />
        </dl>
        <div className="mt-4 border-t border-line pt-3">
          <Field label="Final URL" value={audit.finalUrl} />
        </div>
        {audit.headline && (
          <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">Headline</p>
            <p className="mt-1 text-sm text-ink">{audit.headline}</p>
            {audit.subheadline && <p className="mt-1 text-sm text-ink-subtle">{audit.subheadline}</p>}
          </div>
        )}
      </Card>

      <Card title={`Audit — ${audit.issues.length} finding${audit.issues.length === 1 ? "" : "s"}`}>
        <div className="mb-3 flex flex-wrap gap-2">
          {(["critical", "high", "medium", "low", "informational"] as const).map((severity) =>
            counts[severity] ? (
              <span key={severity} className="flex items-center gap-1.5 text-xs text-ink-muted">
                <SeverityPill severity={severity} />
                {counts[severity]}
              </span>
            ) : null,
          )}
          {audit.issues.length === 0 && <span className="text-sm text-ink-subtle">Nothing flagged.</span>}
        </div>

        <ul className="divide-y divide-line">
          {audit.issues.map((issue) => (
            <li key={issue.id} className="py-2.5">
              <button
                type="button"
                onClick={() => setExpanded(expanded === issue.id ? null : issue.id)}
                className="flex w-full items-start gap-2 text-left"
              >
                <SeverityPill severity={issue.severity} />
                <span className="flex-1 text-sm text-ink">{issue.title}</span>
                <span className="text-xs text-ink-subtle">{expanded === issue.id ? "hide" : "evidence"}</span>
              </button>

              {expanded === issue.id && (
                <div className="mt-2 space-y-2 pl-1 text-sm">
                  <p className="text-ink-muted">{issue.description}</p>
                  {issue.impact && (
                    <p className="text-ink-muted">
                      <span className="font-medium text-ink-subtle">Impact: </span>
                      {issue.impact}
                    </p>
                  )}
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">Evidence</p>
                    <ul className="mt-1 space-y-0.5">
                      {issue.evidence.map((line, index) => (
                        <li key={index} className="font-mono text-xs text-ink-muted">
                          {evidenceText(line)}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {issue.recommendation && (
                    <p className="text-ink-muted">
                      <span className="font-medium text-ink-subtle">Recommendation: </span>
                      {issue.recommendation}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Signals">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="CTAs" value={`${audit.ctaCount} (${audit.ctaAboveFoldCount} above fold)`} />
          <Field label="Forms" value={String(audit.forms.length)} />
          <Field label="Testimonials" value={String(audit.proof.testimonials)} />
          <Field label="Videos" value={String(audit.videoCount)} />
          <Field label="Pricing" value={audit.pricingDetected ? "detected" : "none"} />
          <Field label="Guarantee" value={audit.guaranteePresent ? "present" : "none"} />
          <Field label="Analytics" value={audit.tracking.hasAnalytics ? "detected" : "none observed"} />
          <Field label="Ad pixel" value={audit.tracking.hasAdPixel ? "detected" : "none observed"} />
        </dl>
        <p className="mt-4 border-t border-line pt-3 text-xs text-ink-subtle">
          Scope: the audit rendered one page. It never submitted the form or opened the booking step, so nothing
          after a visitor converts was observed.
        </p>
      </Card>
    </div>
  );
}
