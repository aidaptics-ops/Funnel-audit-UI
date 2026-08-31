import {
  SERVICES,
  type RunUsage,
  type Service,
  type Unit,
  type UsageEvent,
} from "./types";

/**
 * Turning units into money.
 *
 * Pure and separate from where the rates come from, so the same function
 * prices a live run, a row read back from the sheet, and a test — and so a
 * rate change re-prices the entire history rather than only what happens next.
 */

/** The price of ONE unit, in USD. Sub-cent numbers are normal here. */
export type PriceList = Partial<Record<Unit, number>>;

export interface RateCard {
  /** Which model the LLM rates describe. Shown so the figure can be checked. */
  model: string | null;
  prices: Record<Service, PriceList>;
  /** Where each price came from — a plan name, or why it is zero. */
  notes: Partial<Record<Service, string>>;
}

export interface ServiceCost {
  service: Service;
  usd: number;
  units: PriceList;
  events: UsageEvent[];
}

export interface RunCost {
  /** False when the run predates cost tracking: unknown, not free. */
  metered: boolean;
  usd: number;
  /** Every service that did something, cheapest last. */
  byService: ServiceCost[];
}

export function priceRun(usage: RunUsage | null | undefined, card: RateCard): RunCost {
  if (!usage || usage.events.length === 0) return { metered: false, usd: 0, byService: [] };

  const byService: ServiceCost[] = [];

  for (const service of SERVICES) {
    const events = usage.events.filter((event) => event.service === service);
    if (events.length === 0) continue;

    const units: PriceList = {};
    for (const event of events) {
      for (const [unit, value] of Object.entries(event.units) as [Unit, number][]) {
        units[unit] = (units[unit] ?? 0) + value;
      }
    }

    byService.push({ service, usd: priceUnits(units, card.prices[service]), units, events });
  }

  return {
    metered: true,
    usd: round(byService.reduce((total, entry) => total + entry.usd, 0)),
    // Biggest first: the answer to "where is the money going" is the top row.
    byService: byService.sort((left, right) => right.usd - left.usd),
  };
}

export function priceUnits(units: PriceList, prices: PriceList | undefined): number {
  if (!prices) return 0;
  let total = 0;
  for (const [unit, quantity] of Object.entries(units) as [Unit, number][]) {
    total += quantity * (prices[unit] ?? 0);
  }
  return round(total);
}

export interface Totals {
  usd: number;
  /** Runs that carry a ledger. Averages divide by this, never by every row. */
  metered: number;
  /** Rows written before tracking existed. Called out rather than counted. */
  unmetered: number;
  averageUsd: number;
  byService: { service: Service; usd: number; share: number }[];
}

/**
 * The overall picture.
 *
 * Unmetered runs are deliberately excluded from the average rather than
 * treated as zero. A run whose cost was never recorded did not cost nothing,
 * and averaging it in as zero would make every figure quietly optimistic.
 */
export function totalise(costs: RunCost[]): Totals {
  const metered = costs.filter((cost) => cost.metered);
  const usd = round(metered.reduce((total, cost) => total + cost.usd, 0));

  const perService = new Map<Service, number>();
  for (const cost of metered) {
    for (const entry of cost.byService) {
      perService.set(entry.service, (perService.get(entry.service) ?? 0) + entry.usd);
    }
  }

  return {
    usd,
    metered: metered.length,
    unmetered: costs.length - metered.length,
    averageUsd: metered.length > 0 ? round(usd / metered.length) : 0,
    byService: [...perService.entries()]
      .map(([service, amount]) => ({
        service,
        usd: round(amount),
        share: usd > 0 ? amount / usd : 0,
      }))
      .sort((left, right) => right.usd - left.usd),
  };
}

/**
 * Six decimal places internally.
 *
 * A single cache-read token is worth $0.0000005, and hundreds of them are a
 * real fraction of a cent. Rounding to cents at this level would silently
 * discard whole categories of spend before they were ever added up.
 */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Money, at a precision that matches the amount.
 *
 * Two decimal places on a 43-cent run reads as "$0.43" and loses the
 * difference between funnels; four on a $312 total is noise. So the scale of
 * the number decides.
 */
export function money(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd >= 10) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(5)}`;
}

/**
 * A price on the rate card, which is a different job from a total.
 *
 * "$5.0000 / M tokens" reads as spurious precision on a published list price,
 * while "$0.01" would round a real NeverBounce rate away entirely. So: two
 * decimal places, extended only as far as the number actually needs.
 */
export function rate(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const trimmed = usd.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  const [whole, fraction = ""] = trimmed.split(".");
  return `$${whole}.${fraction.padEnd(2, "0")}`;
}

/** 1,234 rather than 1234 — token counts are unreadable without it. */
export function quantity(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1);
}
