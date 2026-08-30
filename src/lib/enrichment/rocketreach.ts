import "server-only";
import { config } from "../config";
import { cacheGet, cacheSet } from "./cache";
import {
  mapLookup,
  mapSearch,
  type RrLookup,
  type RrLookupResponse,
  type RrProfile,
  type RrSearchResponse,
} from "./rocketreach-map";
import type { PersonCandidate } from "../identity/types";

/**
 * RocketReach, split along its own pricing line.
 *
 * `search` costs nothing and returns names, titles and LinkedIn URLs. It is
 * safe to run on any domain, and its names are genuinely useful: a name that
 * RocketReach and the site's own copy both produce is a name we can use.
 *
 * `lookup` is the scarce half — three on the free plan — and is the only call
 * that returns an address. It therefore never runs on its own: an operator
 * picks one profile and asks for it. Every result is cached permanently.
 */

const API = "https://api.rocketreach.co";
const TIMEOUT_MS = 20_000;

/** Titles most likely to belong to whoever decides about the funnel. */
const OWNER_TITLES = ["Founder", "Co-Founder", "CEO", "Owner", "President", "Managing Director"];

export interface RocketReachAccount {
  lookupsRemaining: number;
  lookupsUsed: number;
  lookupsAllocated: number;
}

export interface RocketReachSearch {
  profiles: RrProfile[];
  people: PersonCandidate[];
  total: number;
  cached: boolean;
  cachedAt: string | null;
}

export class RocketReachError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "no_credits" | "pending" | "failed" = "failed",
  ) {
    super(message);
    this.name = "RocketReachError";
  }
}

export function isRocketReachConfigured(): boolean {
  return Boolean(config.enrichment.rocketReachApiKey);
}

/* ------------------------------- account --------------------------------- */

interface AccountResponse {
  credit_usage?: { credit_type?: string; allocated?: number | string; used?: number; remaining?: number | string }[];
}

/** Free to call. */
export async function rocketReachAccount(): Promise<RocketReachAccount | null> {
  if (!isRocketReachConfigured()) return null;

  const body = await request<AccountResponse>("/api/v2/account/", { method: "GET" });
  const standard = body?.credit_usage?.find((entry) => entry.credit_type === "standard_lookup");
  if (!standard) return null;

  const numeric = (value: number | string | undefined): number =>
    typeof value === "number" ? value : value === "inf" ? Number.POSITIVE_INFINITY : 0;

  return {
    lookupsUsed: numeric(standard.used),
    lookupsAllocated: numeric(standard.allocated),
    lookupsRemaining: numeric(standard.remaining),
  };
}

/* -------------------------------- search --------------------------------- */

/**
 * Who works here, by name. Free, so this can run on every enrichment.
 *
 * Tries owner-shaped titles first because those are the people worth finding;
 * falls back to anyone at the company, since a small business often lists no
 * title at all. Both calls are free.
 */
export async function rocketReachSearch(
  domain: string,
  options: { force?: boolean; companyName?: string | null } = {},
): Promise<RocketReachSearch> {
  if (!isRocketReachConfigured()) {
    throw new RocketReachError("ROCKETREACH_API_KEY is not set.", "not_configured");
  }

  const key = `rocketreach:search:${domain.toLowerCase()}`;
  if (!options.force) {
    const hit = await cacheGet<RocketReachSearch>(key);
    if (hit) return { ...hit.value, cached: true, cachedAt: hit.at };
  }

  // Every attempt below is free, so the only cost of trying harder is a little
  // latency. Order matters: owner titles on the domain, then owner titles on
  // the company NAME (many small businesses register the domain to one entity
  // and trade under another), then anyone at all.
  const attempts: { filters: Record<string, string[]>; note: string }[] = [
    { filters: { company_domain: [domain], current_title: OWNER_TITLES }, note: "domain + owner titles" },
    ...(options.companyName
      ? [
          {
            filters: { current_employer: [options.companyName], current_title: OWNER_TITLES },
            note: "company name + owner titles",
          },
          { filters: { current_employer: [options.companyName] }, note: "company name" },
        ]
      : []),
    { filters: { company_domain: [domain] }, note: "domain, any title" },
  ];

  let body: RrSearchResponse = {};
  let mapped = mapSearch(body, domain);

  for (const attempt of attempts) {
    body = await searchOnce(attempt.filters);
    mapped = mapSearch(body, domain);
    if (mapped.profiles.length > 0) break;
  }

  const result: RocketReachSearch = {
    ...mapped,
    total: body.pagination?.total ?? mapped.profiles.length,
    cached: false,
    cachedAt: null,
  };
  await cacheSet(key, result);
  return result;
}

async function searchOnce(query: Record<string, string[]>): Promise<RrSearchResponse> {
  const body = await request<RrSearchResponse & { query?: { non_field_errors?: string[] } }>("/v2/api/search", {
    method: "POST",
    body: { query, start: 1, page_size: 10 },
  });

  const invalid = body?.query?.non_field_errors;
  if (invalid?.length) throw new RocketReachError(`RocketReach rejected the search: ${invalid.join("; ")}`);
  return body ?? {};
}

/* -------------------------------- lookup --------------------------------- */

/**
 * The paid half: one profile, one credit, the addresses.
 *
 * Never called automatically. The balance is checked first so an exhausted
 * quota is a clear message rather than a wasted call, and the answer is
 * cached permanently so the same person is never bought twice.
 */
export async function rocketReachLookup(
  profileId: number,
  domain: string,
  options: { force?: boolean } = {},
): Promise<RrLookup> {
  if (!isRocketReachConfigured()) {
    throw new RocketReachError("ROCKETREACH_API_KEY is not set.", "not_configured");
  }

  const key = `rocketreach:lookup:${profileId}`;
  if (!options.force) {
    const hit = await cacheGet<RrLookup>(key);
    // Only a finished lookup is worth keeping; a "progress" result would
    // otherwise be cached forever and never resolve.
    if (hit?.value.complete) return { ...hit.value, cached: true, cachedAt: hit.at };
  }

  // Ask the FREE endpoint first. A profile looked up before — in an earlier
  // run, or by a lookup whose result arrived after we stopped waiting — is
  // already paid for, and RocketReach will keep returning it for nothing.
  // Skipping this check is how one person gets charged for twice.
  const alreadyPaid = await readStatus(profileId, domain);
  if (alreadyPaid?.complete) {
    await cacheSet(key, alreadyPaid);
    return { ...alreadyPaid, cached: true, cachedAt: new Date().toISOString() };
  }

  const account = await rocketReachAccount();
  if (account && account.lookupsRemaining <= 0) {
    throw new RocketReachError("No RocketReach lookup credits remaining.", "no_credits");
  }

  const body = await request<RrLookupResponse>(`/v2/api/lookupProfile?id=${encodeURIComponent(profileId)}`, {
    method: "GET",
  });
  if (!body) throw new RocketReachError("RocketReach did not return a usable response.");

  let mapped = mapLookup(body, domain);

  // The credit is spent the moment lookupProfile is called, but the result is
  // often still queued. Returning "pending" here would charge the operator and
  // hand them an error, so wait it out — checkStatus is free, and re-calling
  // lookupProfile would charge a second time.
  if (!mapped.complete) mapped = await waitForCompletion(profileId, domain, mapped);

  if (mapped.complete) await cacheSet(key, mapped);
  return mapped;
}

const POLL_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 1500;

async function waitForCompletion(profileId: number, domain: string, pending: RrLookup): Promise<RrLookup> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const mapped = await readStatus(profileId, domain);
    if (mapped?.complete) return mapped;
  }
  return pending;
}

/** checkStatus is free: it reports on lookups this key has already bought. */
async function readStatus(profileId: number, domain: string): Promise<RrLookup | null> {
  const body = await request<RrLookupResponse[]>(
    `/v2/api/checkStatus?ids=${encodeURIComponent(profileId)}`,
    { method: "GET" },
  ).catch(() => null);

  const entry = Array.isArray(body) ? body[0] : null;
  return entry ? mapLookup(entry, domain) : null;
}

/* ------------------------------- transport ------------------------------- */

async function request<T>(path: string, options: { method: string; body?: unknown }): Promise<T | null> {
  try {
    const response = await fetch(`${API}${path}`, {
      method: options.method,
      headers: {
        "Api-Key": config.enrichment.rocketReachApiKey,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => null)) as T | null;

    if (!response.ok) {
      if (response.status === 429) throw new RocketReachError("RocketReach rate limit reached. Try again shortly.");
      const detail =
        (body as { message?: string; detail?: string } | null)?.message ??
        (body as { detail?: string } | null)?.detail ??
        `HTTP ${response.status}`;
      throw new RocketReachError(
        scrub(detail),
        response.status === 401 || response.status === 403 ? "not_configured" : "failed",
      );
    }

    return body;
  } catch (error) {
    if (error instanceof RocketReachError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new RocketReachError("RocketReach timed out.");
    }
    throw new RocketReachError("Could not reach RocketReach.");
  }
}

function scrub(message: string): string {
  const key = config.enrichment.rocketReachApiKey;
  return (key ? message.split(key).join("***") : message).slice(0, 200);
}
