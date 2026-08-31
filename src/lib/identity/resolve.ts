import { OWNER_ROLE } from "./patterns";
import {
  CONFIDENCE_RANK,
  MIN_AUTO_USE,
  meets,
  type Confidence,
  type EmailCandidate,
  type IdentityResult,
  type PersonCandidate,
} from "./types";

/**
 * Turns raw candidates into a decision.
 *
 * Two ideas do the work:
 *   1. Corroboration — the same name from two independent sources is worth far
 *      more than the same name twice from one source.
 *   2. A hard bar — below it, the email simply does not use a name. Refusing to
 *      guess is the feature.
 */

export interface ResolveInput {
  people: PersonCandidate[];
  emails: EmailCandidate[];
  brand: string | null;
  legalEntity: string | null;
  domain: string;
  rootDomain: string;
  pagesChecked: string[];
  /** A human ticked "this is the owner" in the UI. Beats every heuristic. */
  confirmedName?: string | null;
  confirmedEmail?: string | null;
  /** Addresses the operator has refused. Never proposed again. */
  rejectedEmails?: string[];
}

/** Sources that count as independent of one another for corroboration. */
const SOURCE_FAMILY: Record<PersonCandidate["source"], string> = {
  structured_data_person: "structured",
  self_introduction: "page_copy",
  signature: "page_copy",
  team_page: "team",
  email_local_part: "email",
  social_profile: "social",
  enrichment_provider: "provider",
  // Its own family: the open web is independent of both the site and the
  // contact databases, so agreeing with either is real corroboration.
  web_research: "web",
};

export function resolveIdentity(input: ResolveInput): IdentityResult {
  const company = {
    brand: input.brand,
    legalEntity: input.legalEntity,
    domain: input.domain,
    rootDomain: input.rootDomain,
  };

  const people = mergePeople(input.people);
  const emails = dedupeEmails(input.emails);

  // A human confirmation short-circuits everything below it.
  if (input.confirmedName) {
    const confirmed = people.find(
      (person) => person.fullName.toLowerCase() === input.confirmedName!.toLowerCase(),
    );
    const owner: PersonCandidate = confirmed
      ? { ...confirmed, confidence: "confirmed" }
      : {
          fullName: input.confirmedName,
          firstName: input.confirmedName.split(/\s+/)[0] ?? input.confirmedName,
          lastName: input.confirmedName.split(/\s+/).slice(1).join(" ") || null,
          role: null,
          source: "team_page",
          confidence: "confirmed",
          evidence: "Confirmed by the operator.",
          foundOn: "operator",
        };

    const chosen = pickEmails(emails, owner, input.rejectedEmails ?? [], input.rootDomain);
    const ownerEmail =
      emails.find((email) => email.address === input.confirmedEmail?.toLowerCase()) ?? chosen.ownerEmail;

    return {
      company,
      people,
      emails,
      owner,
      ownerEmail: ownerEmail ? { ...ownerEmail, confidence: "confirmed" } : null,
      fallbackEmail: ownerEmail ? null : chosen.fallbackEmail,
      safeToAddressByName: true,
      reason: "Confirmed by the operator.",
      pagesChecked: input.pagesChecked,
    };
  }

  const owner = people[0] ?? null;
  const { ownerEmail, fallbackEmail } = pickEmails(emails, owner, input.rejectedEmails ?? [], input.rootDomain);
  const safe = owner !== null && meets(owner.confidence, MIN_AUTO_USE);

  return {
    company,
    people,
    emails,
    owner,
    ownerEmail,
    fallbackEmail,
    safeToAddressByName: safe,
    reason: explain(owner, people, safe),
    pagesChecked: input.pagesChecked,
  };
}

/**
 * Collapses duplicates and promotes a name that two independent source
 * families agree on. That is the difference between "we saw a name once in a
 * footer" and "the schema, the copy and the email all say Shayne".
 */
function mergePeople(candidates: PersonCandidate[]): PersonCandidate[] {
  const groups = new Map<string, PersonCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.fullName.toLowerCase();
    const list = groups.get(key);
    if (list) list.push(candidate);
    else groups.set(key, [candidate]);
  }

  const merged: PersonCandidate[] = [];
  for (const group of groups.values()) {
    const best = [...group].sort(
      (left, right) => CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence],
    )[0]!;

    const families = new Set(group.map((candidate) => SOURCE_FAMILY[candidate.source]));
    const withRole = group.filter((candidate) => candidate.role);
    // Prefer a role the site stated over one a provider supplied.
    const role =
      withRole.find((candidate) => SOURCE_FAMILY[candidate.source] !== "provider")?.role ??
      withRole[0]?.role ??
      null;

    let confidence = best.confidence;
    // Two independent families agreeing is the strongest signal we can build
    // without a provider, so it lifts a medium reading to high.
    if (families.size >= 2 && confidence === "medium") confidence = "high";

    // A stated owner role reinforces the name — but only when the SITE stated
    // it. An enrichment provider returns the name and the job title inside one
    // record, so its title is part of the same claim, not a second source
    // agreeing with the first. Letting it promote would mean one paid lookup
    // could put a name in a greeting entirely on its own.
    const siteStatedRole = withRole.some(
      (candidate) =>
        SOURCE_FAMILY[candidate.source] !== "provider" && candidate.role && OWNER_ROLE.test(candidate.role),
    );
    if (siteStatedRole && confidence === "medium") confidence = "high";

    merged.push({ ...best, role, confidence });
  }

  return merged.sort((left, right) => {
    const byConfidence = CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
    if (byConfidence !== 0) return byConfidence;
    // Prefer someone with a stated owner role, then a fuller name.
    const leftRole = left.role && OWNER_ROLE.test(left.role) ? 1 : 0;
    const rightRole = right.role && OWNER_ROLE.test(right.role) ? 1 : 0;
    if (leftRole !== rightRole) return rightRole - leftRole;
    return (right.lastName ? 1 : 0) - (left.lastName ? 1 : 0);
  });
}

function dedupeEmails(candidates: EmailCandidate[]): EmailCandidate[] {
  const seen = new Map<string, EmailCandidate>();
  for (const candidate of candidates) {
    const existing = seen.get(candidate.address);
    if (!existing || CONFIDENCE_RANK[candidate.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      seen.set(candidate.address, candidate);
    }
  }

  return [...seen.values()].sort((left, right) => {
    const kindRank = (kind: EmailCandidate["kind"]): number =>
      kind === "personal" ? 2 : kind === "unknown" ? 1 : 0;
    const byKind = kindRank(right.kind) - kindRank(left.kind);
    if (byKind !== 0) return byKind;
    return CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
  });
}

/**
 * Two slots, in strict priority order.
 *
 *   1. ownerEmail    — the owner's own address. What we actually want.
 *   2. fallbackEmail — any other real address, so a reachable business is not
 *                      thrown away just because the founder is not listed.
 *
 * The two never collapse into one. A role inbox filling the owner slot would
 * let "info@" be treated as the founder — the same class of error as a wrong
 * name — so it is offered separately and labelled for what it is.
 *
 * Addresses that were never observed (an enrichment provider's pattern guess)
 * are excluded from both slots. They remain in `emails` for the operator to
 * see and choose deliberately, but nothing proposes them: those are the ones
 * that bounce.
 */
function pickEmails(
  emails: EmailCandidate[],
  owner: PersonCandidate | null,
  rejected: string[],
  rootDomain = "",
): { ownerEmail: EmailCandidate | null; fallbackEmail: EmailCandidate | null } {
  const refused = new Set(rejected.map((address) => address.toLowerCase()));
  const usable = emails.filter((email) => email.observed && !refused.has(email.address));

  const onDomain = (email: EmailCandidate): boolean =>
    rootDomain.length > 0 && email.address.endsWith(`@${rootDomain}`);

  // A work address beats a private one for cold outreach: it is the account
  // they read at work, and writing to someone's personal inbox about their
  // business reads as having dug too far.
  const personal = usable
    .filter((email) => email.kind === "personal")
    .sort((left, right) => Number(onDomain(right)) - Number(onDomain(left)));
  let ownerEmail: EmailCandidate | null = null;

  if (owner) {
    ownerEmail =
      personal.find((email) => {
        const localPart = (email.address.split("@")[0] ?? "").toLowerCase();
        return localPart.includes(owner.firstName.toLowerCase());
      }) ?? null;
  }
  // Exactly one personal address is unambiguous; several without a name match
  // is a coin flip, and we do not flip coins.
  if (!ownerEmail && personal.length === 1) ownerEmail = personal[0]!;

  const fallbackEmail =
    usable
      .filter((email) => email.address !== ownerEmail?.address)
      .sort((left, right) => {
        const rank = (email: EmailCandidate): number =>
          email.kind === "personal" ? 2 : email.kind === "unknown" ? 1 : 0;
        const byKind = rank(right) - rank(left);
        if (byKind !== 0) return byKind;
        const byDomain = Number(onDomain(right)) - Number(onDomain(left));
        if (byDomain !== 0) return byDomain;
        return CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
      })[0] ?? null;

  return { ownerEmail, fallbackEmail };
}

function explain(owner: PersonCandidate | null, people: PersonCandidate[], safe: boolean): string {
  if (!owner) {
    return "No person could be identified from the page. The email will not use a first name.";
  }
  if (safe) {
    return `Identified ${owner.fullName}${owner.role ? ` (${owner.role})` : ""} from ${describe(owner.source)}.`;
  }
  const others = people.length > 1 ? ` ${people.length} candidates were found.` : "";
  return `Best guess is ${owner.fullName}, from ${describe(
    owner.source,
  )}, but that is not strong enough to use unattended.${others} Confirm it to address them by name.`;
}

function describe(source: PersonCandidate["source"]): string {
  const labels: Record<PersonCandidate["source"], string> = {
    structured_data_person: "the page's structured data",
    self_introduction: "the page copy (a self-introduction)",
    signature: "a signature on the page",
    team_page: "a team or about page",
    email_local_part: "an email address",
    social_profile: "a linked social profile",
    enrichment_provider: "an enrichment provider",
    web_research: "published sources on the open web",
  };
  return labels[source];
}

export type { Confidence };
