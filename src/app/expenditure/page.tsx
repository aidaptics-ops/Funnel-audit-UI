"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ago, Button, Card, Empty, Notice } from "@/components/ui";
import { money, quantity, rate, type RateCard, type RunCost, type Totals } from "@/lib/cost/price";
import { SERVICE_LABEL, UNIT_LABEL, type Service, type Unit } from "@/lib/cost/types";
import type { ApiEnvelope } from "@/lib/types";

/**
 * Where the money goes.
 *
 * Two questions, answered in that order: what does a lead cost us, and which
 * service is that. Everything on the page is derived from units recorded at
 * the moment each provider was called, priced at the rates currently
 * configured — so the rate card is shown too. A figure whose derivation is
 * invisible is a figure nobody can act on.
 */

interface CostsPayload {
  runs: RunCostRow[];
  totals: Totals;
  rates: RateCard;
  configured: boolean;
}

interface RunCostRow {
  url: string;
  domain: string;
  business: string;
  owner: string;
  updatedAt: string;
  cost: RunCost;
}

/** One colour per service, so the bar and the column agree at a glance. */
const SERVICE_TONE: Record<Service, { bar: string; text: string }> = {
  anthropic: { bar: "bg-accent", text: "text-accent" },
  hunter: { bar: "bg-busy", text: "text-busy" },
  rocketreach: { bar: "bg-review", text: "text-review" },
  neverbounce: { bar: "bg-done", text: "text-done" },
  audit: { bar: "bg-idle", text: "text-ink-muted" },
};

const COLUMNS: Service[] = ["anthropic", "hunter", "rocketreach", "neverbounce"];

interface LoadResult {
  data: CostsPayload | null;
  error: string | null;
}

/** Pure fetch: it returns what it found and never touches React state. */
async function loadCosts(): Promise<LoadResult> {
  try {
    const response = await fetch("/api/costs");
    const payload = (await response.json()) as ApiEnvelope<CostsPayload>;
    if (!payload.ok || !payload.data) {
      return { data: null, error: payload.error?.message ?? "Could not load the expenditure figures." };
    }
    return { data: payload.data, error: null };
  } catch {
    return { data: null, error: "Could not reach the server." };
  }
}

export default function ExpenditurePage() {
  const [data, setData] = useState<CostsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openUrl, setOpenUrl] = useState<string | null>(null);

  /** State lands in the callback, never in the effect body. */
  const apply = useCallback((result: LoadResult) => {
    if (result.data) setData(result.data);
    setError(result.error);
    setLoading(false);
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    void loadCosts().then(apply);
  }, [apply]);

  useEffect(() => {
    let alive = true;
    void loadCosts().then((result) => {
      if (alive) apply(result);
    });
    return () => {
      alive = false;
    };
  }, [apply]);

  const runs = useMemo(() => data?.runs ?? [], [data]);
  const totals = data?.totals;
  const open = runs.find((run) => run.url === openUrl) ?? null;

  // The single most expensive lead, which is usually the one worth explaining.
  const dearest = useMemo(
    () => runs.filter((run) => run.cost.metered).reduce<RunCostRow | null>(
      (worst, run) => (!worst || run.cost.usd > worst.cost.usd ? run : worst),
      null,
    ),
    [runs],
  );

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-6 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Expenditure</h1>
          <p className="mt-0.5 text-[13px] text-ink-subtle">
            What each lead cost, and which service it went to. Priced at the rates below, from the units
            recorded when each provider was called.
          </p>
        </div>
        <Button variant="secondary" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {data && !data.configured && (
        <Notice tone="warn" title="Google Sheets is not connected">
          Costs are recorded on each run&apos;s row, so nothing can be totalled until the spreadsheet is
          configured. See docs/GOOGLE_SHEETS.md.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {totals && (
        /*
         * One answer, then its workings.
         *
         * This was four equal tiles above four separate bars, which asked the
         * reader to assemble the answer themselves. The question the page
         * exists for is "what does a lead cost", so that figure is the size of
         * the answer and everything else is context around it. One stacked bar
         * rather than four separate ones, because the useful fact is the
         * PROPORTION between services and four bars each scaled to their own
         * width hide it.
         */
        <Card tone="feature" className="overflow-hidden">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                Average cost per lead
              </p>
              <p
                data-numeric
                className="mt-1.5 text-[38px] font-semibold leading-none tracking-[-0.03em] text-ink-strong"
              >
                {money(totals.averageUsd)}
              </p>
              <p className="mt-2.5 text-[12px] leading-relaxed text-ink-subtle">
                Across{" "}
                <span data-numeric className="font-medium text-ink-muted">
                  {totals.metered}
                </span>{" "}
                costed lead{totals.metered === 1 ? "" : "s"} ·{" "}
                <span data-numeric className="font-medium text-ink-muted">
                  {money(totals.usd)}
                </span>{" "}
                total
                {dearest && (
                  <>
                    {" "}
                    · dearest{" "}
                    <span data-numeric className="font-medium text-ink-muted">
                      {money(dearest.cost.usd)}
                    </span>
                  </>
                )}
              </p>
            </div>

            {totals.byService.length > 0 && (
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[11px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
                    Where it goes
                  </p>
                  <p className="text-[11px] text-ink-subtle">share of total spend</p>
                </div>

                {/* One bar, so the proportions are comparable by eye. */}
                <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-surface-inset">
                  {totals.byService
                    .filter((entry) => entry.usd > 0)
                    .map((entry) => (
                      <div
                        key={entry.service}
                        title={`${SERVICE_LABEL[entry.service]} — ${money(entry.usd)}`}
                        className={`h-full transition-[width] duration-700 ease-out-soft ${SERVICE_TONE[entry.service].bar}`}
                        style={{ width: `${Math.max(entry.share * 100, 1.5)}%` }}
                      />
                    ))}
                </div>

                <ul className="mt-3 grid gap-x-5 gap-y-2 sm:grid-cols-2">
                  {totals.byService.map((entry) => (
                    <li key={entry.service} className="flex items-baseline gap-2">
                      <span
                        aria-hidden
                        className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${SERVICE_TONE[entry.service].bar}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">
                        {SERVICE_LABEL[entry.service]}
                      </span>
                      <span data-numeric className="text-[12px] font-semibold text-ink">
                        {money(entry.usd)}
                      </span>
                      <span data-numeric className="w-9 text-right text-[11px] text-ink-subtle">
                        {Math.round(entry.share * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {totals && totals.unmetered > 0 && (
        <Notice>
          {totals.unmetered} run{totals.unmetered === 1 ? " was" : "s were"} recorded before cost tracking
          existed, so {totals.unmetered === 1 ? "its cost is" : "their costs are"} unknown rather than zero.
          {totals.unmetered === 1 ? " It is" : " They are"} shown with a dash and left out of the totals and
          the average.
        </Notice>
      )}

      {/* items-start: the table should size to its rows rather than stretching
          to match a tall detail column beside it. */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <Card
          title="Cost per lead"
          subtitle={runs.length > 0 ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : undefined}
          padded={false}
        >
          {loading && !data ? (
            <Empty title="Loading">Reading the spreadsheet…</Empty>
          ) : runs.length === 0 ? (
            <Empty title="Nothing to cost yet">
              Analyse a funnel on the Funnels page. What each one spends is recorded automatically as it
              runs.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wider text-ink-subtle">
                    <th className="px-5 py-2.5 font-medium">Lead</th>
                    {COLUMNS.map((service) => (
                      <th key={service} className="px-3 py-2.5 text-right font-medium">
                        {SHORT_LABEL[service]}
                      </th>
                    ))}
                    <th className="px-5 py-2.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr
                      key={run.url}
                      onClick={() => setOpenUrl(run.url === openUrl ? null : run.url)}
                      className={`cursor-pointer border-b border-line/70 transition-colors last:border-0 ${
                        run.url === openUrl ? "bg-accent-soft" : "hover:bg-surface-sunken"
                      }`}
                    >
                      <td className="max-w-[260px] px-5 py-3">
                        <p className="truncate font-medium text-ink" title={run.url}>
                          {run.business || run.domain || prettyUrl(run.url)}
                        </p>
                        <p className="truncate text-xs text-ink-subtle" title={run.url}>
                          {prettyUrl(run.url)}
                        </p>
                      </td>
                      {COLUMNS.map((service) => {
                        const entry = run.cost.byService.find((item) => item.service === service);
                        return (
                          <td key={service} className="px-3 py-3 text-right">
                            {!run.cost.metered ? (
                              <span className="text-ink-subtle">—</span>
                            ) : entry && entry.usd > 0 ? (
                              <span data-numeric className="text-ink">
                                {money(entry.usd)}
                              </span>
                            ) : (
                              <span data-numeric className="text-ink-subtle">
                                {entry ? "$0" : "—"}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-5 py-3 text-right">
                        {run.cost.metered ? (
                          <span data-numeric className="font-semibold text-ink">
                            {money(run.cost.usd)}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-subtle" title="Recorded before cost tracking">
                            not tracked
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-5">
          {open ? (
            <RunBreakdown run={open} />
          ) : (
            <Card title="Lead detail">
              <Empty title="Nothing selected">
                Pick a lead to see every call it made, what each one consumed, and what that cost.
              </Empty>
            </Card>
          )}

          {data && <RatesCard rates={data.rates} />}
        </div>
      </div>
    </div>
  );
}

/** Column headers have to fit; the full names are on the breakdown above. */
const SHORT_LABEL: Record<Service, string> = {
  anthropic: "Claude",
  hunter: "Hunter",
  rocketreach: "RocketReach",
  neverbounce: "NeverBounce",
  audit: "Audit",
};

/**
 * Every call this lead made, with what it consumed.
 *
 * The per-step labels are the point: "$0.31" tells an operator nothing they
 * can act on, whereas "founder research — 8 web searches" tells them exactly
 * which part of the pipeline their money is going to.
 */
function RunBreakdown({ run }: { run: RunCostRow }) {
  if (!run.cost.metered) {
    return (
      <Card title={run.business || run.domain || "Lead"} subtitle={prettyUrl(run.url)}>
        <Empty title="No cost recorded">
          This run finished before cost tracking existed, so what it spent was never written down.
          Re-analysing the funnel records it — and spends it again.
        </Empty>
      </Card>
    );
  }

  return (
    <Card
      title={run.business || run.domain || "Lead"}
      subtitle={prettyUrl(run.url)}
      action={
        <span data-numeric className="text-[15px] font-semibold text-ink">
          {money(run.cost.usd)}
        </span>
      }
      padded={false}
    >
      <ul className="divide-y divide-line">
        {run.cost.byService.map((entry) => (
          <li key={entry.service} className="px-5 py-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className={`text-[13px] font-medium ${SERVICE_TONE[entry.service].text}`}>
                {SERVICE_LABEL[entry.service]}
              </span>
              <span data-numeric className="text-[13px] text-ink">
                {money(entry.usd)}
              </span>
            </div>

            <ul className="mt-2 space-y-1.5">
              {entry.events.map((event) => (
                <li key={event.label} className="text-xs leading-relaxed">
                  <span className="text-ink-muted">
                    {event.label}
                    {event.count > 1 && <span className="text-ink-subtle"> ×{event.count}</span>}
                  </span>
                  <span className="ml-1.5 text-ink-subtle">{unitSummary(event.units)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="border-t border-line px-5 py-3 text-xs text-ink-subtle">
        Last updated <Ago iso={run.updatedAt} />
        {run.owner && ` · ${run.owner}`}
      </div>
    </Card>
  );
}

function RatesCard({ rates }: { rates: RateCard }) {
  return (
    <Card
      title="Rates in force"
      subtitle="Set with environment variables, applied when this page is read — so changing one re-prices the whole history."
    >
      <dl className="space-y-2.5 text-xs">
        <Rate label="Claude input" value={`${rate(perMillion(rates, "input_tokens"))} / M tokens`} />
        <Rate label="Claude output" value={`${rate(perMillion(rates, "output_tokens"))} / M tokens`} />
        <Rate
          label="Prompt cache"
          value={`${rate(perMillion(rates, "cache_write_tokens"))} write · ${rate(perMillion(rates, "cache_read_tokens"))} read / M`}
        />
        <Rate
          label="Web search"
          value={`${rate((rates.prices.anthropic.web_searches ?? 0) * 1000)} / 1,000 searches`}
        />
        <Rate label="Hunter" value={rateOrFree(rates.prices.hunter.credits, "credit")} />
        <Rate label="RocketReach" value={rateOrFree(rates.prices.rocketreach.lookups, "lookup")} />
        <Rate label="NeverBounce" value={rateOrFree(rates.prices.neverbounce.checks, "check")} />
        <Rate label="Funnel audit" value={rateOrFree(rates.prices.audit.requests, "run")} />
      </dl>
      {rates.model && (
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-subtle">
          Model rates describe <span className="font-mono">{rates.model}</span>. Free-tier services are
          priced at zero because that is their true marginal cost — the quota runs out rather than the bill
          going up, so watch the credits on the Funnels page for those.
        </p>
      )}
    </Card>
  );
}

function Rate({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd data-numeric className="text-right text-ink">
        {value}
      </dd>
    </div>
  );
}

/** The token rates are stored per token; nobody thinks in those. */
function perMillion(rates: RateCard, unit: Unit): number {
  return (rates.prices.anthropic[unit] ?? 0) * 1_000_000;
}

function rateOrFree(price: number | undefined, unit: string): string {
  return price ? `${rate(price)} / ${unit}` : "free plan — no charge";
}

/** "31,204 input tokens · 8 web searches" — the units, in words. */
function unitSummary(units: Partial<Record<Unit, number>>): string {
  const parts = (Object.entries(units) as [Unit, number][])
    .filter(([, value]) => value > 0)
    .map(([unit, value]) => `${quantity(value)} ${plural(UNIT_LABEL[unit], value)}`);
  return parts.length > 0 ? parts.join(" · ") : "no billable units";
}

/** The labels are plural; one credit is not "1 credits". */
function plural(label: string, value: number): string {
  return value === 1 ? label.replace(/s$/, "") : label;
}

function prettyUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const [head] = bare.split("?");
  return (head ?? bare).replace(/\/$/, "");
}
