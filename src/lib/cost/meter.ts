import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { addEvent, emptyUsage, type RunUsage, type Service, type Unit } from "./types";

/**
 * A per-request ledger of what was spent.
 *
 * Ambient rather than threaded. The alternative is passing a meter through
 * findOwner -> hunterChain -> hunterDomainSearch -> request(), and through
 * every other provider besides — a parameter in a dozen signatures that exists
 * only for accounting, and one that any new call site can silently forget.
 * AsyncLocalStorage carries it across awaits and Promise.all instead, so the
 * measurement lives where the money is actually spent: at the HTTP boundary.
 *
 * The consequences of that placement are the point. A cached Hunter result
 * never reaches request(), so it correctly records nothing. A call that fails
 * after the credit was taken still records it. Neither is true of a meter that
 * counts intentions further up.
 *
 * Recording is best-effort by construction: outside a meter it is a no-op, and
 * nothing here can throw into the work being measured.
 */
const ledger = new AsyncLocalStorage<{ usage: RunUsage }>();

/** Runs `work` with a fresh ledger. Call meteredUsage() inside to read it. */
export function withMeter<T>(work: () => Promise<T>): Promise<T> {
  return ledger.run({ usage: emptyUsage() }, work);
}

/** What has been spent so far in the current meter. Empty when there is none. */
export function meteredUsage(): RunUsage {
  return ledger.getStore()?.usage ?? emptyUsage();
}

/**
 * Records one unit of spend against the active meter.
 *
 * `label` is what the money bought, in words an operator would use — it
 * becomes a line on the Expenditure page, so "founder research" rather than
 * "messages.stream".
 */
export function recordSpend(
  service: Service,
  label: string,
  units: Partial<Record<Unit, number>>,
): void {
  const store = ledger.getStore();
  if (!store) return;

  // Zero-valued units are dropped so a step that cost nothing still appears
  // (its label is informative) without carrying a row of empty numbers.
  const meaningful: Partial<Record<Unit, number>> = {};
  for (const [unit, value] of Object.entries(units) as [Unit, number][]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) meaningful[unit] = value;
  }

  store.usage = addEvent(store.usage, { service, label, units: meaningful, count: 1 });
}
