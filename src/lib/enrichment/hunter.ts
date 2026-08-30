import "server-only";
import { config } from "../config";
import { cacheGet, cacheSet } from "./cache";
import {
  mapCompany,
  mapDomainSearch,
  type CompaniesFindResponse,
  type DomainSearchResponse,
  type HunterCompany,
  type HunterLookup,
} from "./hunter-map";

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

export type { HunterCompany, HunterLookup };

/**
 * The free plan returns at most ten addresses per search, and a bigger `limit`
 * is rejected outright rather than clamped. Ten slots is the real constraint,
 * so the question is not how many to ask for but WHICH ten.
 */
const MAX_RESULTS = 10;

/** Above this head count, ten arbitrary addresses will not include the owner. */
const LARGE_COMPANY = /^(51|101|201|251|501|1K|5K|10K|50K)/i;

/** Titles Hunter's synonym matcher expands (CTO also matches "Co-founder & CTO"). */
const OWNER_JOB_TITLES = "founder,co-founder,owner,ceo,chief executive officer,president,managing director";

export interface HunterCounts {
  total: number;
  personal: number;
  generic: number;
  executive: number;
  senior: number;
  executiveDepartment: number;
}

interface EmailCountResponse {
  data?: {
    total?: number;
    personal_emails?: number;
    generic_emails?: number;
    department?: Record<string, number>;
    seniority?: Record<string, number>;
  };
}

/**
 * A free look before spending anything.
 *
 * email-count costs no credit and still reports how many addresses exist and
 * how they break down by seniority and department. That turns the decision
 * "is this domain worth a credit?" into something we can answer for nothing —
 * previously every lookup paid first and found out afterwards.
 */
export async function hunterCounts(domain: string): Promise<HunterCounts | null> {
  if (!isHunterConfigured()) return null;

  const key = `hunter:counts:${domain.toLowerCase()}`;
  const hit = await cacheGet<HunterCounts | null>(key);
  if (hit) return hit.value;

  try {
    const body = await request<EmailCountResponse>("/email-count", { domain });
    const data = body?.data;
    if (!data) return null;

    const counts: HunterCounts = {
      total: data.total ?? 0,
      personal: data.personal_emails ?? 0,
      generic: data.generic_emails ?? 0,
      executive: data.seniority?.executive ?? 0,
      senior: data.seniority?.senior ?? 0,
      executiveDepartment: data.department?.executive ?? 0,
    };
    await cacheSet(key, counts);
    return counts;
  } catch {
    return null;
  }
}

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

  // Free first. If Hunter holds nothing for this domain there is no point
  // paying to be told so, and the caller can fall straight through to
  // RocketReach instead of burning a credit on an empty result.
  const counts = await hunterCounts(domain);
  if (counts && counts.total === 0) {
    const empty: HunterLookup = {
      organization: null,
      company: null,
      people: [],
      emails: [],
      ownerAddress: null,
      totalFound: 0,
      creditSpent: false,
      cached: false,
      cachedAt: null,
    };
    await cacheSet(key, empty);
    return empty;
  }

  // Company enrichment: 0.2 of a credit for the trading name, the head-count
  // band and the industry. Head count matters directly — the "CEO" of a
  // five-person business is the owner; the CEO of a large one is not who reads
  // a cold email about a landing page.
  const company = await companyProfile(domain);

  // Which ten to ask for depends on how big the company is. A small business
  // has fewer than ten addresses in total, so an unfiltered search returns
  // everything it has. A large one would spend all ten slots on whoever
  // happens to sort first, so ask for decision makers instead.
  // With ten slots, ask for the ones that can actually be the owner. Hunter
  // bills per row returned, so a filtered search costs no more than a broad
  // one and wastes fewer of them — and requiring a full name drops the
  // anonymous catch-alls that could never be addressed by name anyway.
  const large = Boolean(company?.employees && LARGE_COMPANY.test(company.employees.trim()));
  const hasExecutives = !counts || counts.executive > 0 || counts.executiveDepartment > 0;

  const filters: Record<string, string> = {};
  if (hasExecutives) filters.job_titles = OWNER_JOB_TITLES;
  else if (large) filters.decision_maker = "true";

  let first = await searchOnce(domain, filters);
  // A title filter that matches nobody must not look like an empty domain.
  if ((first.data?.emails ?? []).length === 0 && Object.keys(filters).length > 0) {
    first = await searchOnce(domain, {});
  }

  let merged = first;
  const found = first.data?.emails ?? [];

  // A short result set IS everything Hunter has, so a second search would cost
  // a credit to return the same people. Only pay again when the first search
  // was truncated and none of what came back looks like an owner.
  if (found.length >= MAX_RESULTS && !hasOwnerTitle(found)) {
    const second = await searchOnce(domain, { seniority: "executive" }).catch(() => null);
    if (second) merged = mergeResponses(first, second);
  }

  const lookup = mapDomainSearch(merged, domain, company);
  await cacheSet(key, lookup);
  return lookup;
}

async function searchOnce(domain: string, filters: Record<string, string>): Promise<DomainSearchResponse> {
  const body = await request<DomainSearchResponse>("/domain-search", {
    domain,
    limit: String(MAX_RESULTS),
    ...filters,
  });
  if (!body) throw new HunterError("Hunter did not return a usable response.");
  if (body.errors?.length) {
    const detail = body.errors.map((error) => error.details ?? "").filter(Boolean).join("; ");
    throw new HunterError(detail || "Hunter returned an error.");
  }
  return body;
}

const OWNER_TITLE = /\b(founder|co-?founder|owner|proprietor|ceo|chief executive|president|managing director)\b/i;

function hasOwnerTitle(emails: { position?: string | null; position_raw?: string | null }[]): boolean {
  return emails.some((entry) => OWNER_TITLE.test(`${entry.position ?? ""} ${entry.position_raw ?? ""}`));
}

function mergeResponses(first: DomainSearchResponse, second: DomainSearchResponse): DomainSearchResponse {
  const seen = new Set((first.data?.emails ?? []).map((entry) => entry.value?.toLowerCase()));
  const extra = (second.data?.emails ?? []).filter((entry) => !seen.has(entry.value?.toLowerCase()));
  return {
    ...first,
    data: { ...first.data, emails: [...(first.data?.emails ?? []), ...extra] },
  };
}

/** Company enrichment. Cheap, and never fatal — a miss just means less context. */
async function companyProfile(domain: string): Promise<HunterCompany | null> {
  const key = `hunter:company:${domain.toLowerCase()}`;
  const hit = await cacheGet<HunterCompany | null>(key);
  if (hit) return hit.value;

  try {
    const body = await request<CompaniesFindResponse>("/companies/find", { domain });
    const company = body ? mapCompany(body) : null;
    await cacheSet(key, company);
    return company;
  } catch {
    return null;
  }
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
