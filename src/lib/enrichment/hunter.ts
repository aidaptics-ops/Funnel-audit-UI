import "server-only";
import { config } from "../config";
import { cacheGet, cacheSet } from "./cache";
import { mapDomainSearch, type DomainSearchResponse, type HunterLookup } from "./hunter-map";

/**
 * Hunter.io, used sparingly and read sceptically.
 *
 * Two facts shape this whole file:
 *
 *   1. Credits are scarce (50/month on the free plan). So a lookup is never
 *      automatic — an operator asks for it, one domain at a time — and every
 *      answer is cached permanently so a domain is never paid for twice.
 *
 *   2. Hunter returns two very different kinds of address in the same array.
 *      Some it actually saw on a web page (`sources` is non-empty); others it
 *      inferred from a company's naming pattern. The inferred ones are exactly
 *      the addresses that bounce, so they arrive here as `observed: false` and
 *      can never become the owner's address.
 *
 * Only Domain Search is implemented. Email Finder is deliberately absent: it
 * takes a name and *constructs* the most likely address, which is the one
 * thing this system has consistently refused to do.
 */

const API = "https://api.hunter.io/v2";
const TIMEOUT_MS = 15_000;

export interface HunterAccount {
  planName: string;
  creditsUsed: number;
  creditsAvailable: number;
  creditsRemaining: number;
  resetsAt: string | null;
}

export type { HunterLookup };

export function isHunterConfigured(): boolean {
  return Boolean(config.enrichment.hunterApiKey);
}

export class HunterError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "no_credits" | "failed" = "failed",
  ) {
    super(message);
    this.name = "HunterError";
  }
}

/* ------------------------------- account --------------------------------- */

interface AccountResponse {
  data?: {
    plan_name?: string;
    requests?: { searches?: { used?: number; available?: number } };
    reset_date?: string;
  };
  errors?: { details?: string }[];
}

/** Free to call — Hunter does not charge for /account. */
export async function hunterAccount(): Promise<HunterAccount | null> {
  if (!isHunterConfigured()) return null;

  const body = await request<AccountResponse>("/account", {});
  if (!body?.data) return null;

  const used = body.data.requests?.searches?.used ?? 0;
  const available = body.data.requests?.searches?.available ?? 0;
  return {
    planName: body.data.plan_name ?? "unknown",
    creditsUsed: used,
    creditsAvailable: available,
    creditsRemaining: Math.max(0, available - used),
    resetsAt: body.data.reset_date ?? null,
  };
}

/* ---------------------------- domain search ------------------------------ */

/**
 * One paid lookup for one domain.
 *
 * `force` re-queries a domain already in the cache. It exists because a site
 * can add a team page later — but it spends a credit, so it is never the
 * default and the UI asks for it explicitly.
 */
export async function hunterDomainSearch(
  domain: string,
  options: { force?: boolean } = {},
): Promise<HunterLookup> {
  if (!isHunterConfigured()) {
    throw new HunterError("HUNTER_API_KEY is not set.", "not_configured");
  }

  const key = `hunter:domain:${domain.toLowerCase()}`;
  if (!options.force) {
    const hit = await cacheGet<HunterLookup>(key);
    if (hit) return { ...hit.value, cached: true, cachedAt: hit.at };
  }

  // Check the balance before spending, so an exhausted quota is a clear
  // message rather than a confusing empty result.
  const account = await hunterAccount();
  if (account && account.creditsRemaining <= 0) {
    throw new HunterError(
      `No Hunter credits remaining${account.resetsAt ? ` until ${account.resetsAt}` : ""}.`,
      "no_credits",
    );
  }

  const body = await request<DomainSearchResponse>("/domain-search", { domain });
  if (!body) throw new HunterError("Hunter did not return a usable response.");
  if (body.errors?.length) {
    const detail = body.errors.map((error) => error.details ?? "").filter(Boolean).join("; ");
    throw new HunterError(detail || "Hunter returned an error.");
  }

  const lookup = mapDomainSearch(body, domain);
  await cacheSet(key, lookup);
  return lookup;
}

/* -------------------------------- transport ------------------------------ */

async function request<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(`${API}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  // The key goes in a header, never the query string: query strings end up in
  // logs, proxies and error messages.
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${config.enrichment.hunterApiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as T | null;
    if (!response.ok) {
      const detail =
        (body as { errors?: { details?: string }[] } | null)?.errors?.[0]?.details ?? `HTTP ${response.status}`;
      throw new HunterError(scrub(detail), response.status === 401 ? "not_configured" : "failed");
    }
    return body;
  } catch (error) {
    if (error instanceof HunterError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HunterError("Hunter timed out.");
    }
    throw new HunterError("Could not reach Hunter.");
  }
}

function scrub(message: string): string {
  const key = config.enrichment.hunterApiKey;
  return (key ? message.split(key).join("***") : message).slice(0, 200);
}
