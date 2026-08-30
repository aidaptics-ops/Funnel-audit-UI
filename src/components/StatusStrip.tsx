"use client";

import type { StatusPayload } from "@/lib/types";

/**
 * What is connected, and what it will cost.
 *
 * Every row here answers a question someone would otherwise have to ask a
 * developer: is the analyser up, which model is writing, how many paid lookups
 * are left. Quotas sit here rather than only next to their buttons so nobody
 * discovers an empty balance halfway through a batch.
 */
export function StatusStrip({ status }: { status: StatusPayload | null }) {
  if (!status) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2.5 text-xs text-ink-subtle">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-line-strong" />
        Checking connections…
      </div>
    );
  }

  const items: { label: string; value: string; tone: Tone; hint?: string }[] = [
    {
      label: "Analyser",
      value: status.audit.ok ? "online" : "unreachable",
      tone: status.audit.ok ? "ok" : "bad",
      hint: status.audit.ok ? undefined : "Funnels cannot be analysed until this is back.",
    },
    {
      label: "Model",
      value: status.llm.isMock ? "not configured" : (status.llm.model ?? status.llm.label),
      tone: status.llm.isMock ? "warn" : "ok",
      hint: status.llm.isMock ? "Emails are placeholder text until a model is set." : undefined,
    },
    {
      label: "Client voice",
      value: `${status.knowledge.emailCount} samples`,
      tone: status.knowledge.emailCount > 0 ? "ok" : "warn",
      hint: status.knowledge.emailCount === 0 ? "Without samples the email has no voice to copy." : undefined,
    },
    {
      label: "Sheets",
      value: status.sheets.configured ? "connected" : "not connected",
      tone: status.sheets.configured ? "ok" : "warn",
      hint: status.sheets.configured ? undefined : "Runs will not be saved to history.",
    },
  ];

  const hunter = status.enrichment?.hunter;
  if (hunter?.configured) {
    const left = hunter.creditsRemaining;
    items.push({
      label: "Hunter",
      value: left === null ? "connected" : `${left} left`,
      tone: left !== null && left <= 5 ? "warn" : "ok",
      hint: hunter.resetsAt ? `Resets ${hunter.resetsAt}.` : undefined,
    });
  }

  const rocket = status.enrichment?.rocketreach;
  if (rocket?.configured) {
    const left = rocket.lookupsRemaining;
    items.push({
      label: "RocketReach",
      value: left === null ? "connected" : `${left} lookup${left === 1 ? "" : "s"} left`,
      tone: left !== null && left <= 1 ? "warn" : "ok",
      hint: "Searching for names is free; only fetching an address costs a lookup.",
    });
  }

  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-2.5 shadow-panel">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        {items.map((item) => (
          <span key={item.label} className="flex items-center gap-1.5" title={item.hint}>
            <Dot tone={item.tone} />
            <span className="text-ink-subtle">{item.label}</span>
            <span className="font-medium text-ink">{item.value}</span>
          </span>
        ))}
      </div>

      {!status.knowledge.storage.durable && (
        <p className="mt-2 border-t border-line pt-2 text-xs text-review">
          Storage is in-memory: emails added to the library will not survive a restart.
        </p>
      )}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad";

function Dot({ tone }: { tone: Tone }) {
  const color = { ok: "bg-done", warn: "bg-review", bad: "bg-broken" }[tone];
  return <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />;
}
