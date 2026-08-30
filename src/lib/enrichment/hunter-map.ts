import { looksLikePersonName, parsePersonName } from "../identity/patterns";
import type { Confidence, EmailCandidate, PersonCandidate } from "../identity/types";

/**
 * Turning a Hunter payload into candidates — the part worth testing.
 *
 * Kept free of I/O and of "server-only" so the judgement calls here can be
 * exercised directly. Those calls are the entire safety story of the feature:
 * Hunter mixes addresses it observed with addresses it guessed from a naming
 * pattern, and only this file decides which is which.
 */

export interface HunterLookup {
  organization: string | null;
  people: PersonCandidate[];
  emails: EmailCandidate[];
  /** True when this came from the cache and cost nothing. */
  cached: boolean;
  cachedAt: string | null;
}

export interface DomainSearchResponse {
  data?: {
    domain?: string;
    organization?: string | null;
    emails?: {
      value?: string;
      type?: string;
      confidence?: number;
      first_name?: string | null;
      last_name?: string | null;
      position?: string | null;
      sources?: { uri?: string; extracted_on?: string }[];
      verification?: { status?: string | null } | null;
    }[];
  };
  errors?: { details?: string }[];
}

export function mapDomainSearch(body: DomainSearchResponse, domain: string): HunterLookup {
  const people: PersonCandidate[] = [];
  const emails: EmailCandidate[] = [];
  const foundOn = `hunter.io domain-search:${domain}`;

  for (const entry of body.data?.emails ?? []) {
    const address = entry.value?.toLowerCase().trim();
    if (!address) continue;

    const sources = entry.sources ?? [];
    // The distinction that matters: did Hunter SEE this address somewhere, or
    // did it infer it from the company's pattern?
    const observed = sources.length > 0;
    const score = entry.confidence ?? 0;
    const status = entry.verification?.status ?? null;
    const generic = entry.type === "generic";

    emails.push({
      address,
      kind: generic ? "generic_inbox" : entry.type === "personal" ? "personal" : "unknown",
      source: "enrichment_provider",
      confidence: emailConfidence({ observed, score, status, generic }),
      evidence: describeEmail({ score, status, sources: sources.length, position: entry.position ?? null }),
      foundOn,
      observed,
    });

    const full = [entry.first_name, entry.last_name].filter(Boolean).join(" ").trim();
    if (!full || !looksLikePersonName(full)) continue;
    const parsed = parsePersonName(full);
    if (!parsed) continue;

    people.push({
      ...parsed,
      role: entry.position ?? null,
      source: "enrichment_provider",
      // A provider is one source. It reaches "high" only by agreeing with
      // something found on the site itself — resolve.ts does that promotion.
      confidence: observed && score >= 80 ? "medium" : "low",
      evidence: `Hunter: ${address}${entry.position ? ` — ${entry.position}` : ""} (confidence ${score}${
        observed ? `, seen on ${sources.length} page(s)` : ", no public source"
      })`,
      foundOn,
    });
  }

  return {
    organization: body.data?.organization ?? null,
    people,
    emails,
    cached: false,
    cachedAt: null,
  };
}

/**
 * Hunter's own 0-100 score is a pattern-match probability, not proof. It only
 * earns "high" when Hunter both saw the address in public and its verifier
 * says the mailbox is real.
 */
function emailConfidence(input: {
  observed: boolean;
  score: number;
  status: string | null;
  generic: boolean;
}): Confidence {
  if (input.generic) return "low";
  if (!input.observed) return "low";
  if (input.status === "valid" && input.score >= 80) return "high";
  if (input.score >= 50) return "medium";
  return "low";
}

function describeEmail(input: {
  score: number;
  status: string | null;
  sources: number;
  position: string | null;
}): string {
  const parts = [`Hunter confidence ${input.score}/100`];
  if (input.position) parts.push(input.position);
  parts.push(input.sources > 0 ? `seen on ${input.sources} public page(s)` : "inferred from the domain pattern");
  if (input.status) parts.push(`verification: ${input.status}`);
  return parts.join(" · ");
}
