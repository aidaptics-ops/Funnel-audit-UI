import "server-only";
import { hunterCounts, hunterDomainSearch, hunterFindEmail, isHunterConfigured } from "../enrichment/hunter";
import {
  isRocketReachConfigured,
  rocketReachSearch,
} from "../enrichment/rocketreach";
import {
  isNeverBounceConfigured,
  verifyEmail,
  type EmailVerification,
} from "../enrichment/neverbounce";
import { scoreOwner } from "../enrichment/owner-score";
import { researchFounder, type FounderEvidence, type FounderFinding } from "./founder";
import type { RrProfile } from "../enrichment/rocketreach-map";
import type { EmailCandidate, PersonCandidate } from "../identity/types";

/**
 * Company -> founder -> address -> verification.
 *
 * The ordering is the point. Every previous attempt started at the contact
 * databases, which for a small coaching or agency funnel hold nothing — so it
 * found nothing. Establishing the NAME first, from the open web, turns the
 * providers from "who works here?" (which they cannot answer) into "what is
 * this specific person's address?" (which they often can).
 *
 * One rule changes at the last step. Elsewhere this system refuses addresses
 * constructed from a naming pattern, because they bounce. With a verifier in
 * the chain that reasoning no longer holds: a constructed address that
 * NeverBounce confirms is a real mailbox is a real mailbox. So a guess is
 * allowed to ENTER the pipeline and is then required to survive verification —
 * it can never reach the operator unverified.
 */

export interface OwnerSearchStep {
  name: string;
  outcome: string;
  /** What this step actually cost, in the provider's own units. */
  cost: string;
}

export interface OwnerSearchResult {
  companyName: string | null;
  founderName: string | null;
  founderTitle: string | null;
  /** The address we ended up recommending, if any. */
  chosen: { address: string; verification: EmailVerification; source: string } | null;
  /** Everything considered, verified where it mattered. */
  candidates: { address: string; source: string; verification: EmailVerification | null }[];
  people: PersonCandidate[];
  emails: EmailCandidate[];
  evidence: FounderEvidence[];
  steps: OwnerSearchStep[];
  reason: string;
}

export interface OwnerSearchInput {
  domain: string;
  companyName?: string | null;
  legalEntity?: string | null;
  headline?: string | null;
  knownNames?: string[];
  /** Allows a constructed address to be generated and then verified. */
  allowPatternGuess?: boolean;
}

export async function findOwner(input: OwnerSearchInput): Promise<OwnerSearchResult> {
  const steps: OwnerSearchStep[] = [];
  const people: PersonCandidate[] = [];
  const emails: EmailCandidate[] = [];
  const candidates: OwnerSearchResult["candidates"] = [];

  const domain = input.domain.toLowerCase().replace(/^www\./, "");

  /* ------------- 1-3. Every independent source at once -------------------
   *
   * These three do not need each other's answers, and the web research alone
   * takes a minute — running them one after another spends that minute three
   * times over for nothing. The only genuinely sequential part is what needs
   * the founder's NAME, which is below.
   */
  const [hunterOutcome, research, rocketOutcome] = await Promise.all([
    hunterChain(domain, steps),
    researchStep(
      { domain, companyName: input.companyName, legalEntity: input.legalEntity, headline: input.headline, knownNames: input.knownNames },
      steps,
    ),
    rocketStep(domain, input.companyName ?? null, steps),
  ]);

  if (hunterOutcome.lookup) {
    people.push(...hunterOutcome.lookup.people);
    emails.push(...hunterOutcome.lookup.emails);
    for (const email of hunterOutcome.lookup.emails) {
      if (email.observed) candidates.push({ address: email.address, source: "Hunter", verification: null });
    }
  }
  people.push(...rocketOutcome.people);
  const rocketProfiles = rocketOutcome.profiles;

  const companyName = research?.companyName ?? hunterOutcome.lookup?.company?.name ?? input.companyName ?? null;
  const founderName = research?.founderName ?? null;

  if (founderName && research) {
    /*
     * Independent SITES, not independent citations.
     *
     * Three URLs on one domain is one publisher repeating itself; the same
     * name on a BBB listing, a personal site and a press piece is three
     * parties who would have to be wrong together. That second case is
     * genuinely stronger than any single contact database, so it is allowed
     * to clear the bar for using a first name unattended.
     */
    const sourceSites = new Set(
      research.evidence.map((entry) => {
        try {
          return new URL(entry.source).hostname.replace(/^www\./, "").toLowerCase();
        } catch {
          return entry.source;
        }
      }),
    );

    people.push({
      ...splitName(founderName),
      role: research.founderTitle,
      source: "web_research",
      confidence: sourceSites.size >= 3 ? "high" : sourceSites.size >= 2 ? "medium" : "low",
      evidence: `Web research across ${sourceSites.size} independent site(s): ${research.reason}`,
      foundOn: research.evidence[0]?.source ?? "web research",
    });

    for (const address of research.emails) {
      candidates.push({ address, source: "web research", verification: null });
    }
  }

  // Cross-check: does more than one source name the same person? That is the
  // strongest signal available, and it is worth saying out loud.
  // Includes names already found ON the page. The copyright line and the open
  // web are independent publishers, and an earlier version compared only the
  // sources this function gathered — so a name confirmed by both was still
  // reported as "one source only".
  const agreement = crossCheck(people, founderName, input.knownNames ?? []);
  if (agreement) steps.push({ name: "Cross-check", outcome: agreement, cost: "free" });

  /* ---------------- Now the parts that need the NAME --------------------- */
  const searchDomains = [domain, ...(research?.relatedDomains ?? [])].slice(0, 3);

  if (founderName && input.allowPatternGuess !== false && isHunterConfigured()) {
    // One request per domain, together rather than in turn.
    const found = await Promise.all(
      searchDomains.map((target) =>
        hunterFindEmail(target, founderName)
          .then((result) => ({ target, result, error: null as unknown }))
          .catch((error: unknown) => ({ target, result: null, error })),
      ),
    );

    for (const entry of found) {
      if (entry.error) {
        steps.push({ name: `Hunter email finder · ${entry.target}`, outcome: describe(entry.error), cost: "none" });
      } else if (entry.result?.address) {
        candidates.push({
          address: entry.result.address,
          source: `Hunter email-finder on ${entry.target}${entry.result.observed ? "" : " (constructed)"}`,
          verification: null,
        });
        steps.push({
          name: `Hunter email finder · ${entry.target}`,
          outcome: `proposed ${entry.result.address} (score ${entry.result.score ?? "?"}) — unverified`,
          cost: "1 credit",
        });
      } else {
        steps.push({ name: `Hunter email finder · ${entry.target}`, outcome: "no address proposed", cost: "free" });
      }
    }
  }

  // Sister domains: free index check first, paid search only where it pays.
  if (isHunterConfigured() && searchDomains.length > 1) {
    const sideResults = await Promise.all(
      searchDomains.slice(1).map(async (target) => {
        const sideCounts = await hunterCounts(target).catch(() => null);
        if (!sideCounts || sideCounts.total === 0) return { target, lookup: null };
        return { target, lookup: await hunterDomainSearch(target).catch(() => null) };
      }),
    );

    for (const entry of sideResults) {
      if (!entry.lookup) {
        steps.push({ name: `Hunter index check · ${entry.target}`, outcome: "nothing indexed", cost: "free" });
        continue;
      }
      people.push(...entry.lookup.people);
      for (const email of entry.lookup.emails) {
        if (email.observed) {
          candidates.push({ address: email.address, source: `Hunter on ${entry.target}`, verification: null });
        }
      }
      steps.push({
        name: `Hunter domain search · ${entry.target}`,
        outcome: `${entry.lookup.people.length} name(s), ${entry.lookup.emails.length} address(es)`,
        cost: entry.lookup.creditSpent ? "1 credit" : "free",
      });
    }
  }

  /* ---------------- 4. Verify, best candidate first ---------------------- */
  const ordered = rank(candidates, founderName, domain);
  let chosen: OwnerSearchResult["chosen"] = null;

  // When nothing free turned up an address but RocketReach holds the founder,
  // say so explicitly — that is a specific, worthwhile paid step rather than a
  // vague "try harder".
  if (founderName && ordered.length === 0) {
    const match = rocketProfiles.find(
      (profile) => profile.fullName.toLowerCase() === founderName.toLowerCase(),
    );
    if (match) {
      steps.push({
        name: "RocketReach match",
        outcome: `${match.fullName} is in RocketReach — one lookup would return their address`,
        cost: "1 lookup if you ask",
      });
    }
  }

  if (isNeverBounceConfigured()) {
    let checked = 0;
    for (const candidate of ordered) {
      // A hard cap: verification is cheap but not free, and past the third
      // candidate we are guessing at people rather than at addresses.
      if (checked >= 4) break;
      checked += 1;
      try {
        const verification = await verifyEmail(candidate.address);
        candidate.verification = verification;
        if (!chosen && verification.usable) {
          chosen = { address: candidate.address, verification, source: candidate.source };
        }
      } catch (error) {
        steps.push({ name: `Verify ${candidate.address}`, outcome: describe(error), cost: "none" });
      }
    }
    steps.push({
      name: "NeverBounce",
      outcome: chosen
        ? `${chosen.address} — ${chosen.verification.result}`
        : ordered.length === 0
          ? "nothing to verify"
          : "no candidate passed",
      cost: `${checked} check(s)`,
    });
  } else if (ordered.length > 0) {
    steps.push({ name: "NeverBounce", outcome: "not configured — addresses are unverified", cost: "none" });
  }

  return {
    companyName,
    founderName,
    founderTitle: research?.founderTitle ?? null,
    chosen,
    candidates: ordered,
    people,
    emails,
    evidence: research?.evidence ?? [],
    steps,
    reason: summarise(founderName, chosen, research),
  };
}

/**
 * Verify the most promising address first, so the cheapest path to a usable
 * answer is taken before the speculative ones.
 */
function rank(
  candidates: OwnerSearchResult["candidates"],
  founderName: string | null,
  domain: string,
): OwnerSearchResult["candidates"] {
  const first = founderName?.split(/\s+/)[0]?.toLowerCase() ?? null;
  const seen = new Set<string>();

  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.address)) return false;
      seen.add(candidate.address);
      return true;
    })
    .map((candidate) => {
      const local = candidate.address.split("@")[0]?.toLowerCase() ?? "";
      let score = 0;
      if (first && local.includes(first)) score += 50;
      if (candidate.address.endsWith(`@${domain}`)) score += 20;
      if (candidate.source === "web research") score += 15;
      if (/^(info|support|hello|contact|admin|team|sales)/.test(local)) score -= 30;
      if (candidate.source.includes("constructed")) score -= 10;
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.candidate);
}

function summarise(
  founderName: string | null,
  chosen: OwnerSearchResult["chosen"],
  research: FounderFinding | null,
): string {
  if (chosen && founderName) {
    return chosen.verification.confirmed
      ? `${founderName} at ${chosen.address}, mailbox confirmed.`
      : `${founderName} at ${chosen.address}, but ${chosen.verification.summary.toLowerCase()}`;
  }
  if (chosen) return `No owner name established, but ${chosen.address} is reachable.`;
  if (founderName) return `Identified ${founderName}, but no usable address was found for them.`;
  return research?.reason ?? "No owner could be established.";
}

function splitName(fullName: string): { fullName: string; firstName: string; lastName: string | null } {
  const tokens = fullName.split(/\s+/).filter(Boolean);
  return {
    fullName,
    firstName: tokens[0] ?? fullName,
    lastName: tokens.length > 1 ? tokens.slice(1).join(" ") : null,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}

export { scoreOwner };

/* --------------------------- parallel stages ----------------------------- */

/**
 * Hunter's free index check, then its paid search only if there is something
 * to buy. These two ARE sequential — the whole point of the check is to decide
 * whether to pay — but the pair runs alongside the other providers.
 */
async function hunterChain(
  domain: string,
  steps: OwnerSearchStep[],
): Promise<{ counts: Awaited<ReturnType<typeof hunterCounts>>; lookup: Awaited<ReturnType<typeof hunterDomainSearch>> | null }> {
  if (!isHunterConfigured()) return { counts: null, lookup: null };

  const counts = await hunterCounts(domain).catch(() => null);
  if (counts) {
    steps.push({
      name: "Hunter index check",
      outcome: `${counts.total} address(es) indexed, ${counts.executive} at executive level`,
      cost: "free",
    });
  }
  if (counts && counts.total === 0) return { counts, lookup: null };

  try {
    const lookup = await hunterDomainSearch(domain);
    steps.push({
      name: "Hunter domain search",
      outcome: `${lookup.people.length} name(s), ${lookup.emails.length} address(es)`,
      cost: lookup.creditSpent ? "1 credit" : "free",
    });
    return { counts, lookup };
  } catch (error) {
    steps.push({ name: "Hunter domain search", outcome: describe(error), cost: "none" });
    return { counts, lookup: null };
  }
}

async function researchStep(
  query: Parameters<typeof researchFounder>[0],
  steps: OwnerSearchStep[],
): Promise<FounderFinding | null> {
  try {
    const research = await researchFounder(query);
    steps.push({
      name: "Web research",
      outcome: research.founderName
        ? `${research.founderName}${research.founderTitle ? ` — ${research.founderTitle}` : ""} (${research.evidence.length} source(s))`
        : research.reason,
      cost: `${research.searchesUsed} search block(s)`,
    });
    return research;
  } catch (error) {
    steps.push({ name: "Web research", outcome: describe(error), cost: "none" });
    return null;
  }
}

async function rocketStep(
  domain: string,
  companyName: string | null,
  steps: OwnerSearchStep[],
): Promise<{ people: PersonCandidate[]; profiles: RrProfile[] }> {
  if (!isRocketReachConfigured()) return { people: [], profiles: [] };
  try {
    const search = await rocketReachSearch(domain, { companyName });
    steps.push({
      name: "RocketReach search",
      outcome: search.profiles.length ? `${search.profiles.length} profile(s)` : "no profiles",
      // Fetching an address is a separate, operator-triggered decision.
      cost: "free (addresses not fetched)",
    });
    return { people: search.people, profiles: search.profiles };
  } catch (error) {
    steps.push({ name: "RocketReach search", outcome: describe(error), cost: "none" });
    return { people: [], profiles: [] };
  }
}

/**
 * Do the sources agree?
 *
 * Two providers naming the same person independently is the strongest signal
 * this system can produce, and the operator should see it stated rather than
 * having to compare rows themselves.
 */
function crossCheck(
  people: PersonCandidate[],
  founderName: string | null,
  knownNames: string[],
): string | null {
  if (!founderName) return null;
  const target = founderName.toLowerCase();

  const families = new Set(
    people
      .filter((person) => person.fullName.toLowerCase() === target)
      .map((person) => person.source.replace(/_/g, " ")),
  );
  if (knownNames.some((name) => name.toLowerCase() === target)) {
    families.add("the funnel page itself");
  }

  if (families.size >= 2) {
    return `${founderName} named independently by ${[...families].join(", ")}`;
  }
  return `${founderName} named by one source only — treat with care`;
}
