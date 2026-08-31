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
import { OWNER_SCORE_BAR, scoreOwner } from "../enrichment/owner-score";
import { researchFounder, type FounderEvidence, type FounderFinding } from "./founder";
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

  /* ---------------- 1. Is there anything in the contact databases? -------- */
  // Free, and it decides whether the paid Hunter search is worth running.
  const counts = isHunterConfigured() ? await hunterCounts(domain).catch(() => null) : null;
  if (counts) {
    steps.push({
      name: "Hunter index check",
      outcome: `${counts.total} address(es) indexed, ${counts.executive} at executive level`,
      cost: "free",
    });
  }

  /* ---------------- 2. Who is the founder, per the open web? ------------- */
  let research: FounderFinding | null = null;
  try {
    research = await researchFounder({
      domain,
      companyName: input.companyName,
      legalEntity: input.legalEntity,
      headline: input.headline,
      knownNames: input.knownNames,
    });
    steps.push({
      name: "Web research",
      outcome: research.founderName
        ? `${research.founderName}${research.founderTitle ? ` — ${research.founderTitle}` : ""} (${research.evidence.length} source(s))`
        : research.reason,
      cost: `${research.searchesUsed} search block(s)`,
    });
  } catch (error) {
    steps.push({
      name: "Web research",
      outcome: error instanceof Error ? error.message : "failed",
      cost: "none",
    });
  }

  const companyName = research?.companyName ?? input.companyName ?? null;
  const founderName = research?.founderName ?? null;

  if (founderName && research) {
    /*
     * Independent SITES, not independent citations.
     *
     * Three URLs on one domain is one publisher repeating itself; the same
     * name on a BBB listing, a personal site and a press piece is three
     * parties who would have to be wrong together. That second case is
     * genuinely stronger than any single contact database, so it is allowed
     * to clear the bar for using a first name unattended — which is the whole
     * reason for finding the founder in the first place.
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

  /* ---------------- 3. The contact databases, now targeted --------------- */
  if (isHunterConfigured() && (!counts || counts.total > 0)) {
    try {
      const lookup = await hunterDomainSearch(domain);
      people.push(...lookup.people);
      emails.push(...lookup.emails);
      for (const email of lookup.emails) {
        if (email.observed) candidates.push({ address: email.address, source: "Hunter", verification: null });
      }
      steps.push({
        name: "Hunter domain search",
        outcome: `${lookup.people.length} name(s), ${lookup.emails.length} address(es)`,
        cost: lookup.creditSpent ? "1 credit" : "free",
      });
    } catch (error) {
      steps.push({ name: "Hunter domain search", outcome: describe(error), cost: "none" });
    }
  }

  // With a name in hand, Hunter can be asked the specific question — on the
  // funnel domain AND on any sister domain the research turned up. That second
  // part matters: an ad funnel rarely hosts anyone's mailbox, while the brand
  // or personal site behind it usually does.
  const searchDomains = [domain, ...(research?.relatedDomains ?? [])].slice(0, 3);

  if (founderName && input.allowPatternGuess !== false && isHunterConfigured()) {
    for (const target of searchDomains) {
      try {
        const found = await hunterFindEmail(target, founderName);
        if (found?.address) {
          candidates.push({
            address: found.address,
            source: `Hunter email-finder on ${target}${found.observed ? "" : " (constructed)"}`,
            verification: null,
          });
          steps.push({
            name: `Hunter email finder · ${target}`,
            outcome: `proposed ${found.address} (score ${found.score ?? "?"}) — unverified`,
            cost: "1 credit",
          });
        } else {
          steps.push({ name: `Hunter email finder · ${target}`, outcome: "no address proposed", cost: "free" });
        }
      } catch (error) {
        steps.push({ name: `Hunter email finder · ${target}`, outcome: describe(error), cost: "none" });
      }
    }
  }

  // Any sister domain is also worth a free index check plus, when it holds
  // something, its own search — that is often where the real addresses are.
  for (const target of searchDomains.slice(1)) {
    if (!isHunterConfigured()) break;
    const sideCounts = await hunterCounts(target).catch(() => null);
    if (!sideCounts || sideCounts.total === 0) {
      steps.push({ name: `Hunter index check · ${target}`, outcome: "nothing indexed", cost: "free" });
      continue;
    }
    try {
      const lookup = await hunterDomainSearch(target);
      people.push(...lookup.people);
      for (const email of lookup.emails) {
        if (email.observed) {
          candidates.push({ address: email.address, source: `Hunter on ${target}`, verification: null });
        }
      }
      steps.push({
        name: `Hunter domain search · ${target}`,
        outcome: `${lookup.people.length} name(s), ${lookup.emails.length} address(es)`,
        cost: lookup.creditSpent ? "1 credit" : "free",
      });
    } catch (error) {
      steps.push({ name: `Hunter domain search · ${target}`, outcome: describe(error), cost: "none" });
    }
  }

  if (isRocketReachConfigured()) {
    try {
      const search = await rocketReachSearch(domain, { companyName });
      people.push(...search.people);
      const match = founderName
        ? search.profiles.find((profile) => profile.fullName.toLowerCase() === founderName.toLowerCase())
        : search.profiles.find((profile) => profile.ownerScore >= OWNER_SCORE_BAR);
      steps.push({
        name: "RocketReach search",
        outcome: search.profiles.length
          ? `${search.profiles.length} profile(s)${match ? `, incl. ${match.fullName}` : ""}`
          : "no profiles",
        // Fetching an address is a separate, operator-triggered decision.
        cost: "free (addresses not fetched)",
      });
    } catch (error) {
      steps.push({ name: "RocketReach search", outcome: describe(error), cost: "none" });
    }
  }

  /* ---------------- 4. Verify, best candidate first ---------------------- */
  const ordered = rank(candidates, founderName, domain);
  let chosen: OwnerSearchResult["chosen"] = null;

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
