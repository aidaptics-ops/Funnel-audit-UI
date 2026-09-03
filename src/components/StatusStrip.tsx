"use client";

import { ServiceMark, type ServiceMarkId } from "./ServiceMark";
import type { StatusPayload } from "@/lib/types";

/**
 * What is connected, and what it will cost.
 *
 * Every entry answers a question someone would otherwise have to ask a
 * developer: is the analyser up, which model is writing, how many paid lookups
 * are left. Quotas sit here rather than only next to their buttons so nobody
 * discovers an empty balance halfway through a batch.
 *
 * The services are marks rather than names. Four labelled rows is a list to
 * read; four glyphs with their balances is a row to scan, and the name is one
 * hover away. The analyser keeps its NAME — it is ours, it has no logo anyone
 * would recognise, and it is the one entry whose failure stops everything.
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

  const services: ServiceEntry[] = [
    {
      name: "Model",
      mark: "anthropic",
      value: status.llm.isMock ? "not configured" : (status.llm.model ?? status.llm.label),
      tone: status.llm.isMock ? "warn" : "ok",
      hint: status.llm.isMock ? "Emails are placeholder text until a model is set." : "Writes the analysis and the email.",
    },
    {
      name: "Client voice",
      mark: "voice",
      value: `${status.knowledge.emailCount} samples`,
      tone: status.knowledge.emailCount > 0 ? "ok" : "warn",
      hint:
        status.knowledge.emailCount === 0
          ? "Without samples the email has no voice to copy."
          : "The client's own emails, which every draft is written from.",
    },
    {
      name: "Google Sheets",
      mark: "sheets",
      value: status.sheets.configured ? "connected" : "not connected",
      tone: status.sheets.configured ? "ok" : "warn",
      hint: status.sheets.configured ? "Every run is written here." : "Runs will not be saved to history.",
    },
  ];

  const hunter = status.enrichment?.hunter;
  if (hunter?.configured) {
    const left = hunter.creditsRemaining;
    services.push({
      name: "Hunter",
      mark: "hunter",
      value: left === null ? "connected" : `${left} left`,
      tone: left !== null && left <= 5 ? "warn" : "ok",
      hint: `Turns a founder's name into an address.${hunter.resetsAt ? ` Resets ${hunter.resetsAt}.` : ""}`,
    });
  }

  const rocket = status.enrichment?.rocketreach;
  if (rocket?.configured) {
    const left = rocket.lookupsRemaining;
    services.push({
      name: "RocketReach",
      mark: "rocketreach",
      value: left === null ? "connected" : `${left} lookup${left === 1 ? "" : "s"} left`,
      tone: left !== null && left <= 1 ? "warn" : "ok",
      hint: "Searching for names is free; only fetching an address costs a lookup.",
    });
  }

  const bounce = status.enrichment?.neverbounce;
  if (bounce?.configured) {
    const left = bounce.creditsRemaining;
    services.push({
      name: "NeverBounce",
      mark: "neverbounce",
      value: left === null ? "connected" : `${left} left`,
      tone: left !== null && left <= 20 ? "warn" : "ok",
      hint: "Checks an address is deliverable before it is offered for approval.",
    });
  }

  const analyser = status.audit.ok;

  return (
    <div className="animate-rise rounded-xl border border-line bg-surface px-4 py-2.5 shadow-panel">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 text-xs">
        {/* Ours, and named: a mark for it would mean nothing to anyone. */}
        <span
          className="flex items-center gap-1.5"
          title={analyser ? "Our crawler. Renders the page and records what is there." : "Funnels cannot be analysed until this is back."}
        >
          <Dot tone={analyser ? "ok" : "bad"} />
          <span className="font-medium text-ink">OurAnalysis API</span>
          <span className="text-ink-subtle">{analyser ? "online" : "unreachable"}</span>
        </span>

        <span className="h-4 w-px bg-line" aria-hidden />

        {services.map((service) => (
          <span
            key={service.name}
            title={`${service.name} — ${service.hint}`}
            className="group flex items-center gap-1.5 transition-opacity hover:opacity-100 sm:opacity-90"
          >
            <span className={TONE_TEXT[service.tone]}>
              <ServiceMark id={service.mark} className="h-[15px] w-[15px]" />
            </span>
            {/* The name appears on hover; the balance is always visible. */}
            <span className="max-w-0 overflow-hidden whitespace-nowrap text-ink-muted opacity-0 transition-all duration-300 ease-out-soft group-hover:max-w-[120px] group-hover:opacity-100">
              {service.name}
            </span>
            <span className="font-medium text-ink">{service.value}</span>
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

interface ServiceEntry {
  name: string;
  mark: ServiceMarkId;
  value: string;
  tone: Tone;
  hint: string;
}

/** The mark itself carries the state, so a quota running low is visible. */
const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ink-muted",
  warn: "text-review",
  bad: "text-broken",
};

function Dot({ tone }: { tone: Tone }) {
  const color = { ok: "bg-done", warn: "bg-review", bad: "bg-broken" }[tone];
  return <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />;
}
