import "server-only";
import { config } from "../config";
import type { RateCard } from "./price";

/**
 * What each unit costs.
 *
 * Every number is an environment variable with a published default, because
 * the honest answer to "what does a run cost" depends on plans this code
 * cannot see. The defaults describe the setup this app was built against:
 * Claude Opus 5 on the standard API, Hunter and RocketReach on their free
 * tiers, NeverBounce pay-as-you-go, and a self-hosted audit API.
 *
 * A free tier is priced at zero on purpose. It is the true marginal cost of a
 * run — nothing is charged for the 51st Hunter credit, the lookup simply stops
 * working — so the Expenditure page shows the credits consumed beside the
 * money, and the quota, not the invoice, is what to watch there.
 */

/** Rates are per million tokens in the price list, per token in the card. */
const PER_MILLION = 1_000_000;
const PER_THOUSAND = 1_000;

/**
 * Unlike config.ts's int(), zero is a legitimate value here — it is how a free
 * plan is expressed — so this accepts anything non-negative and finite.
 */
function price(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function rateCard(): RateCard {
  const hunterPerCredit = price("PRICE_HUNTER_PER_CREDIT", 0);
  const rocketPerLookup = price("PRICE_ROCKETREACH_PER_LOOKUP", 0);
  const auditPerRun = price("PRICE_AUDIT_PER_RUN", 0);

  return {
    model: config.llm.model || null,
    prices: {
      anthropic: {
        // Opus 5 list prices. Cache writes are 1.25x input and cache reads
        // 0.1x, which is why the system prompt is cached at all.
        input_tokens: price("PRICE_LLM_INPUT_PER_MTOK", 5) / PER_MILLION,
        output_tokens: price("PRICE_LLM_OUTPUT_PER_MTOK", 25) / PER_MILLION,
        cache_write_tokens: price("PRICE_LLM_CACHE_WRITE_PER_MTOK", 6.25) / PER_MILLION,
        cache_read_tokens: price("PRICE_LLM_CACHE_READ_PER_MTOK", 0.5) / PER_MILLION,
        // The server-side web search tool is billed per request, on top of the
        // tokens the results occupy in the context.
        web_searches: price("PRICE_WEB_SEARCH_PER_THOUSAND", 10) / PER_THOUSAND,
      },
      hunter: { credits: hunterPerCredit },
      rocketreach: { lookups: rocketPerLookup },
      neverbounce: { checks: price("PRICE_NEVERBOUNCE_PER_CHECK", 0.008) },
      audit: { requests: auditPerRun },
    },
    notes: {
      anthropic: `${config.llm.model || "the configured model"} — list price per token, plus $${price("PRICE_WEB_SEARCH_PER_THOUSAND", 10)} per 1,000 web searches.`,
      hunter:
        hunterPerCredit === 0
          ? "Free plan: 50 credits a month, no charge per credit. Watch the quota, not the cost."
          : `$${hunterPerCredit} per credit.`,
      rocketreach:
        rocketPerLookup === 0
          ? "Free plan: 3 lookups a month. Searches are free and unlimited; only a lookup returns an address."
          : `$${rocketPerLookup} per lookup.`,
      neverbounce: `$${price("PRICE_NEVERBOUNCE_PER_CHECK", 0.008)} per address verified.`,
      audit:
        auditPerRun === 0
          ? "Self-hosted on your own server, so a run costs no more than the server you already pay for."
          : `$${auditPerRun} per audit.`,
    },
  };
}
