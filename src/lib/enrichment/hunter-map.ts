import { looksLikePersonName, parsePersonName } from "../identity/patterns";
import type { Confidence, EmailCandidate, PersonCandidate } from "../identity/types";
import { OWNER_SCORE_BAR, scoreOwner } from "./owner-score";

/**
 * Turning a Hunter payload into candidates — the part worth testing.
 *
 * Hunter returns far more per address than "an email": a job title, a
 * seniority band, a department, its own decision-maker flag, a LinkedIn URL,
 * and whether it actually found the address or derived it from the company's
 * naming pattern. An earlier version read almost none of that and simply took
 * whichever address came back first, which is why it kept surfacing support
 * inboxes instead of founders.
 *
 * Two traps are handled explicitly:
 *
 *   accept_all — a domain that accepts mail for every address makes an SMTP
 *   "valid" result meaningless. Trusting it there is how a pattern-guessed
 *   address gets promoted to "verified".
 *
 *   pattern    — Hunter publishes the company's address format. An address
 *   that matches it but was never actually seen is a guess wearing a
 *   plausible shape.
 */

export interface HunterCompany {
  name: string | null;
  legalName: string | null;
  description: string | null;
  industry: string | null;
  employees: string | null;
  location: string | null;
  foundedYear: number | null;
  linkedinHandle: string | null;
  /** Addresses printed on the company's own site, per Hunter. */
  siteEmails: string[];
}

export interface HunterLookup {
  organization: string | null;
  company: HunterCompany | null;
  people: PersonCandidate[];
  emails: EmailCandidate[];
  /** The best owner candidate's address, when one cleared the title bar. */
  ownerAddress: string | null;
  /** How many addresses Hunter returned before filtering. */
  totalFound: number;
  /**
   * Whether this result actually cost a credit. A free pre-flight that finds
   * the domain empty short-circuits before any paid call, and reporting "1
   * credit" there would quietly mislead someone watching a small quota.
   */
  creditSpent: boolean;
  cached: boolean;
  cachedAt: string | null;
}

export interface DomainSearchResponse {
  data?: {
    domain?: string;
    organization?: string | null;
    /** The company's address format, e.g. "{first}{last}". */
    pattern?: string | null;
    /** True when the mail server accepts every address, valid or not. */
    accept_all?: boolean;
    webmail?: boolean;
    disposable?: boolean;
    emails?: HunterEmail[];
  };
  errors?: { details?: string }[];
}

export interface HunterEmail {
  value?: string;
  type?: string;
  /** "found" when Hunter saw it somewhere; anything else is inferred. */
  source_type?: string | null;
  confidence?: number;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  position_raw?: string | null;
  seniority?: string | null;
  department?: string | null;
  decision_maker?: boolean | null;
  linkedin?: string | null;
  twitter?: string | null;
  phone_number?: string | null;
  sources?: { uri?: string; extracted_on?: string }[];
  verification?: { status?: string | null; date?: string | null } | null;
}

export interface CompaniesFindResponse {
  data?: {
    name?: string | null;
    legalName?: string | null;
    description?: string | null;
    foundedYear?: number | null;
    location?: string | null;
    category?: { industry?: string | null } | null;
    metrics?: { employees?: string | null } | null;
    linkedin?: { handle?: string | null } | null;
    site?: { emailAddresses?: string[] | null } | null;
  };
  errors?: { details?: string }[];
}

export function mapCompany(body: CompaniesFindResponse): HunterCompany | null {
  const data = body.data;
  if (!data) return null;
  return {
    name: data.name ?? null,
    legalName: data.legalName ?? null,
    description: data.description ?? null,
    industry: data.category?.industry ?? null,
    employees: data.metrics?.employees ?? null,
    location: data.location ?? null,
    foundedYear: data.foundedYear ?? null,
    linkedinHandle: data.linkedin?.handle ?? null,
    siteEmails: (data.site?.emailAddresses ?? []).filter(Boolean).map((value) => value.toLowerCase()),
  };
}

export function mapDomainSearch(
  body: DomainSearchResponse,
  domain: string,
  company: HunterCompany | null = null,
): HunterLookup {
  const people: PersonCandidate[] = [];
  const emails: EmailCandidate[] = [];
  const foundOn = `hunter.io domain-search:${domain}`;

  const acceptAll = body.data?.accept_all === true;
  const entries = body.data?.emails ?? [];

  // Rank first, so the highest-scoring person is the one the resolver sees at
  // the top rather than whoever Hunter happened to list first.
  const ranked = entries
    .map((entry) => ({
      entry,
      score: scoreOwner({
        title: entry.position ?? entry.position_raw ?? null,
        seniority: entry.seniority,
        department: entry.department,
        decisionMaker: entry.decision_maker,
        companySize: company?.employees ?? null,
      }),
    }))
    .sort((left, right) => right.score.score - left.score.score);

  let ownerAddress: string | null = null;

  for (const { entry, score } of ranked) {
    const address = entry.value?.toLowerCase().trim();
    if (!address) continue;

    const observed = wasObserved(entry);
    const generic = entry.type === "generic";

    emails.push({
      address,
      kind: generic ? "generic_inbox" : entry.type === "personal" ? "personal" : "unknown",
      source: "enrichment_provider",
      confidence: emailConfidence({ observed, entry, acceptAll, generic }),
      evidence: describeEmail(entry, score.rationale, observed, acceptAll),
      foundOn,
      observed,
    });

    const full = [entry.first_name, entry.last_name].filter(Boolean).join(" ").trim();
    if (!full || !looksLikePersonName(full)) continue;
    const parsed = parsePersonName(full);
    if (!parsed) continue;

    const isOwner = score.score >= OWNER_SCORE_BAR;
    if (isOwner && !ownerAddress && !generic && observed) ownerAddress = address;

    people.push({
      ...parsed,
      role: entry.position ?? entry.position_raw ?? null,
      source: "enrichment_provider",
      // A provider is one source, whatever its own confidence. An owner-shaped
      // title makes the person worth surfacing first, but it still takes the
      // site's own copy agreeing before the name may be used unattended.
      confidence: isOwner && observed ? "medium" : "low",
      evidence: `Hunter: ${parsed.fullName}${entry.position ? ` — ${entry.position}` : ""} · ${score.rationale} · score ${score.score}`,
      foundOn,
    });
  }

  return {
    organization: body.data?.organization ?? company?.name ?? null,
    company,
    people,
    emails,
    ownerAddress,
    totalFound: entries.length,
    creditSpent: true,
    cached: false,
    cachedAt: null,
  };
}

/**
 * Did Hunter actually see this address, or construct it?
 *
 * `source_type: "found"` is Hunter saying so directly; a public source says it
 * too. Nothing else counts — and in particular a high confidence score does
 * not, however convincing it looks. That number is Hunter's probability that
 * an address of this SHAPE is right, which is exactly what it reports for an
 * address generated from the company's naming pattern. Reading it as evidence
 * of observation would promote precisely the addresses that bounce.
 */
function wasObserved(entry: HunterEmail): boolean {
  return entry.source_type === "found" || (entry.sources ?? []).length > 0;
}

/**
 * Hunter's 0-100 score is a pattern-match probability, not proof.
 *
 * On an accept-all domain the mail server answers for every address, so an
 * SMTP "valid" verdict carries no information at all — treating it as proof
 * there is how a fabricated address gets promoted to verified.
 */
function emailConfidence(input: {
  observed: boolean;
  entry: HunterEmail;
  acceptAll: boolean;
  generic: boolean;
}): Confidence {
  if (input.generic) return "low";
  if (!input.observed) return "low";

  const status = input.entry.verification?.status ?? null;
  const score = input.entry.confidence ?? 0;
  const smtpProves = status === "valid" && !input.acceptAll;

  if (smtpProves && score >= 80) return "high";
  if (smtpProves || score >= 80) return "medium";
  if (score >= 50) return "medium";
  return "low";
}

function describeEmail(
  entry: HunterEmail,
  rationale: string,
  observed: boolean,
  acceptAll: boolean,
): string {
  const parts = [`Hunter ${entry.confidence ?? 0}/100`];
  if (entry.position) parts.push(entry.position);
  if (rationale) parts.push(rationale);
  parts.push(observed ? "seen publicly" : "inferred from the domain pattern");
  if (entry.verification?.status) {
    parts.push(
      acceptAll
        ? `verification: ${entry.verification.status} (domain accepts all mail — proves nothing)`
        : `verification: ${entry.verification.status}`,
    );
  }
  return parts.join(" · ");
}
