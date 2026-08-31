/**
 * What a run consumed, in the units each provider actually bills.
 *
 * Units are stored, never money. A dollar figure written at the time of the
 * run freezes the price list at that moment: change a plan, or correct a rate
 * that was wrong, and the whole history is quietly wrong too — with nothing to
 * say which rows were priced at which rate. Tokens, credits, checks and
 * lookups are facts about what happened. The rate card is configuration, and
 * it is applied when the page is read.
 *
 * Client-safe: no server-only import, so the Expenditure page can use these
 * types directly.
 */

/** Everything this app can spend money on. */
export type Service = "anthropic" | "hunter" | "rocketreach" | "neverbounce" | "audit";

export const SERVICES: Service[] = ["anthropic", "hunter", "rocketreach", "neverbounce", "audit"];

export const SERVICE_LABEL: Record<Service, string> = {
  anthropic: "Claude (Anthropic)",
  hunter: "Hunter.io",
  rocketreach: "RocketReach",
  neverbounce: "NeverBounce",
  audit: "Funnel audit API",
};

/**
 * A billable quantity. Deliberately provider-agnostic: the same word means the
 * same thing everywhere, and a new provider adds a rate rather than a concept.
 */
export type Unit =
  | "input_tokens"
  | "output_tokens"
  | "cache_write_tokens"
  | "cache_read_tokens"
  | "web_searches"
  | "credits"
  | "lookups"
  | "checks"
  | "requests";

export const UNIT_LABEL: Record<Unit, string> = {
  input_tokens: "input tokens",
  output_tokens: "output tokens",
  cache_write_tokens: "cache writes",
  cache_read_tokens: "cache reads",
  web_searches: "web searches",
  credits: "credits",
  lookups: "lookups",
  checks: "checks",
  requests: "requests",
};

const UNITS = new Set<string>(Object.keys(UNIT_LABEL));
const KNOWN_SERVICES = new Set<string>(SERVICES);

/**
 * One kind of spend within a run.
 *
 * Kept per step rather than per service, because "what did this cost" is much
 * less useful than "what did it buy" — an operator looking at 40 cents wants
 * to see that 30 of them were the founder research.
 */
export interface UsageEvent {
  service: Service;
  /** What the money bought, in the operator's words. */
  label: string;
  units: Partial<Record<Unit, number>>;
  /** How many times this exact step ran. Repeats merge instead of stacking. */
  count: number;
}

export interface RunUsage {
  events: UsageEvent[];
}

export function emptyUsage(): RunUsage {
  return { events: [] };
}

export function isEmptyUsage(usage: RunUsage | null | undefined): boolean {
  return !usage || usage.events.length === 0;
}

/**
 * Adds one step's units to a ledger, merging into the matching step.
 *
 * Merging is what keeps the record bounded: regenerating an email twenty times
 * produces one "outreach email" line with count 20, not twenty lines. The
 * total is identical either way, and only one of them stays readable.
 */
export function addEvent(usage: RunUsage, event: UsageEvent): RunUsage {
  const existing = usage.events.find(
    (entry) => entry.service === event.service && entry.label === event.label,
  );

  if (!existing) return { events: [...usage.events, { ...event, units: { ...event.units } }] };

  return {
    events: usage.events.map((entry) =>
      entry === existing
        ? { ...entry, count: entry.count + event.count, units: sumUnits(entry.units, event.units) }
        : entry,
    ),
  };
}

/** Everything two ledgers spent, together. Used when a run is re-analysed. */
export function mergeUsage(left: RunUsage | null, right: RunUsage | null): RunUsage {
  let merged: RunUsage = { events: (left?.events ?? []).map((entry) => ({ ...entry, units: { ...entry.units } })) };
  for (const event of right?.events ?? []) merged = addEvent(merged, event);
  return merged;
}

function sumUnits(
  left: Partial<Record<Unit, number>>,
  right: Partial<Record<Unit, number>>,
): Partial<Record<Unit, number>> {
  const total: Partial<Record<Unit, number>> = { ...left };
  for (const [unit, value] of Object.entries(right) as [Unit, number][]) {
    total[unit] = (total[unit] ?? 0) + value;
  }
  return total;
}

/** Readable in the spreadsheet by eye: this cell is the audit trail. */
export function serializeUsage(usage: RunUsage | null): string {
  if (!usage || usage.events.length === 0) return "";
  return JSON.stringify(usage);
}

/**
 * Rows are written by us and edited by people, so every field is untrusted:
 * an unknown service, a negative token count or a hand-mangled cell must
 * produce an empty ledger rather than a broken page or a nonsense total.
 */
export function parseUsage(raw: string): RunUsage | null {
  if (!raw || !raw.trim().startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const events = (parsed as { events?: unknown })?.events;
  if (!Array.isArray(events)) return null;

  const clean = events.flatMap((entry): UsageEvent[] => {
    const record = entry as Partial<UsageEvent>;
    if (typeof record.service !== "string" || !KNOWN_SERVICES.has(record.service)) return [];

    const units: Partial<Record<Unit, number>> = {};
    for (const [unit, value] of Object.entries(record.units ?? {})) {
      if (UNITS.has(unit) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
        units[unit as Unit] = value;
      }
    }

    return [
      {
        service: record.service as Service,
        label: typeof record.label === "string" && record.label ? record.label.slice(0, 120) : "unlabelled",
        units,
        count: typeof record.count === "number" && record.count > 0 ? Math.floor(record.count) : 1,
      },
    ];
  });

  return clean.length > 0 ? { events: clean } : null;
}
