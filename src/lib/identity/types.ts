/**
 * Business-owner identification.
 *
 * The governing rule: a wrong name is worse than no name. "Hey Mike," sent to
 * someone called Dana does more damage than "Hey," — it proves the email was
 * automated. So every candidate carries where it came from, nothing is ever
 * merged into an unlabelled "owner", and the email may only use a name that
 * cleared a confidence bar or was confirmed by a human.
 */

export type Confidence = "confirmed" | "high" | "medium" | "low";

/** Ranked worst-to-best so comparisons read naturally. */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
  confirmed: 3,
};

export type PersonSource =
  | "structured_data_person"      // JSON-LD Person / author
  | "self_introduction"           // "Hi, I'm Shayne"
  | "signature"                   // "— Shayne", "Best, Shayne"
  | "team_page"                   // /about, /team, /meet-the-team
  | "email_local_part"            // shayne@domain.com
  | "social_profile"              // linkedin.com/in/shayne-x
  | "copyright_line"              // "© 2026 Patrick Wu - The Art of Wooing"
  | "enrichment_provider"         // Hunter / RocketReach
  | "web_research";               // named on the open web, with citations

export type EmailSource =
  | "mailto_link"
  | "page_text"
  | "structured_data"
  | "contact_page"
  | "enrichment_provider";

/**
 * What an email address IS, which matters more than whether we found one.
 * A generic inbox is a real address but not a person — addressing it as the
 * owner is the same class of error as a wrong name.
 */
export type EmailKind = "personal" | "generic_inbox" | "unknown";

export interface PersonCandidate {
  fullName: string;
  firstName: string;
  lastName: string | null;
  /** Stated role, when the page gave one ("Founder", "CEO"). */
  role: string | null;
  source: PersonSource;
  confidence: Confidence;
  /** Verbatim text that produced this. Shown to the human who confirms. */
  evidence: string;
  /** Where the evidence was found. */
  foundOn: string;
}

export interface EmailCandidate {
  address: string;
  kind: EmailKind;
  source: EmailSource;
  confidence: Confidence;
  evidence: string;
  foundOn: string;
  /**
   * Whether the address was actually observed, or constructed from a pattern.
   * This app NEVER constructs one — the field exists so an enrichment provider
   * that does can be told apart and treated as unverified.
   */
  observed: boolean;
}

export interface CompanyIdentity {
  /** Trading/brand name, e.g. "RealSide Real Estate". */
  brand: string | null;
  /** Legal entity from a copyright or trademark line, suffix intact. */
  legalEntity: string | null;
  domain: string;
  rootDomain: string;
}

export interface IdentityResult {
  company: CompanyIdentity;
  people: PersonCandidate[];
  emails: EmailCandidate[];
  /** The single best person, or null when nothing cleared the bar. */
  owner: PersonCandidate | null;
  /**
   * The owner's own address — personal, observed, tied to the named person.
   * This is what we always want. Never a guess, never a role inbox.
   */
  ownerEmail: EmailCandidate | null;
  /**
   * The best other real address, kept when no owner address was found.
   *
   * A role inbox is not the owner, but it is a working way to reach the
   * business, so discarding it loses a usable lead. It is offered as a clearly
   * labelled second choice for a human to accept or refuse — never silently
   * promoted into the owner slot.
   */
  fallbackEmail: EmailCandidate | null;
  /** True when the email may open with a first name. */
  safeToAddressByName: boolean;
  /** Plain-language reason, shown in the UI. */
  reason: string;
  /** Pages consulted beyond the landing page. */
  pagesChecked: string[];
}

/** The bar a name must clear before it can be used unattended. */
export const MIN_AUTO_USE: Confidence = "high";

export function meets(candidate: Confidence, bar: Confidence): boolean {
  return CONFIDENCE_RANK[candidate] >= CONFIDENCE_RANK[bar];
}

export function emptyIdentity(domain: string, rootDomain: string): IdentityResult {
  return {
    company: { brand: null, legalEntity: null, domain, rootDomain },
    people: [],
    emails: [],
    owner: null,
    ownerEmail: null,
    fallbackEmail: null,
    safeToAddressByName: false,
    reason: "No identity signals were found.",
    pagesChecked: [],
  };
}
