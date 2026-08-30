/**
 * The tests that decide whether a string is a person, a company, or noise.
 *
 * Every one of these exists because getting it wrong produces a specific,
 * embarrassing failure: greeting a limited company by its trading name,
 * addressing "Privacy Policy" as a human, or treating info@ as the founder.
 */

/** Legal suffixes. Their presence means "company", never "person". */
const ENTITY_SUFFIX =
  /\b(ltd|limited|llc|l\.l\.c|inc|inc\.|incorporated|corp|corporation|co|company|gmbh|bv|b\.v|pty|plc|llp|lp|sarl|srl|ag|nv|oy|ab|as|aps|s\.a|s\.l|pte|sdn bhd|group|holdings|ventures|partners|associates|agency|media|studios?|labs?|solutions|systems|technologies|consulting|enterprises?)\b\.?/i;

/** Mailbox names that belong to a function, not a person. */
const ROLE_ACCOUNT =
  /^(info|hello|hi|hey|support|help|admin|team|contact|sales|billing|accounts?|office|enquiries|inquiries|no[-.]?reply|noreply|donotreply|do[-.]?not[-.]?reply|mail|email|service|customerservice|care|press|media|marketing|hr|jobs|careers|legal|privacy|abuse|postmaster|webmaster|newsletter|notifications?|bookings?|orders?|shop|store)$/i;

/** Words that appear in page furniture and are never a person's name. */
const NOT_A_NAME =
  /\b(privacy|policy|terms|conditions|cookie|copyright|all rights|reserved|home|about|contact|login|sign in|sign up|register|book now|get started|learn more|read more|click here|free training|watch now|apply now|download|webinar|masterclass|workshop|challenge|bootcamp|program|course|community|academy|university|institute|coaching|consulting|real estate|marketing|fitness|digital|online|business|company|team|support)\b/i;

/** Role words that, next to a name, raise confidence that it IS the owner. */
export const OWNER_ROLE =
  /\b(founder|co-?founder|owner|ceo|president|managing director|principal|proprietor|director|head coach|lead coach|creator|host)\b/i;

/**
 * Words that ARE the job, not the person. A candidate made only of these is a
 * title that happened to sit where a name usually sits.
 */
const ROLE_WORD =
  /^(founder|co-?founder|owner|ceo|cto|coo|cmo|president|director|principal|proprietor|manager|host|creator|coach|consultant|trainer|instructor|speaker|author|expert|specialist|partner|lead|head|chief|staff|admin|advisor|mentor|strategist|team|support|sales|marketing)$/i;

/**
 * English function words. A candidate containing one is a fragment of a
 * sentence, not a name.
 *
 * Found the hard way: a page heading reading "- This Is For You If -" was
 * captured as the person "For You If" at high confidence, which would have
 * opened an email "Hey For,".
 *
 * Deliberately excludes words that are also real names (Will, May, Grace,
 * Young, Best, Long). Erring toward rejection is correct here — the cost of a
 * false negative is a missing first name, the cost of a false positive is a
 * visibly automated email.
 */
const FUNCTION_WORD =
  /^(a|an|the|and|but|or|nor|so|yet|for|if|then|than|that|this|these|those|is|are|was|were|be|been|being|am|do|does|did|have|has|had|my|your|our|his|her|its|their|what|when|where|why|how|who|whom|whose|which|all|any|each|every|some|not|here|there|now|just|only|also|too|very|more|most|much|many|from|into|onto|upon|with|within|without|about|above|below|over|under|again|once|because|while|until|unless|though|although|whether|either|neither|you|we|they|it|me|us|them|i)$/i;

/** Common honorifics to strip before parsing a name. */
const HONORIFIC = /^(mr|mrs|ms|miss|dr|prof|professor|sir|coach)\.?\s+/i;

/** Particles that legitimately appear inside a surname. */
const PARTICLE = /^(van|von|de|del|della|di|da|dos|du|la|le|el|al|bin|ibn|mac|mc|o')$/i;

export function looksLikeCompany(value: string): boolean {
  return ENTITY_SUFFIX.test(value);
}

export function stripEntitySuffix(value: string): string {
  return value
    .replace(new RegExp(`[,\\s]+${ENTITY_SUFFIX.source}\\s*$`, "i"), "")
    .replace(/[.,\s]+$/, "")
    .trim();
}

export function isRoleAccount(localPart: string): boolean {
  return ROLE_ACCOUNT.test(localPart.replace(/[._-]/g, ""));
}

/**
 * Is this plausibly a human name?
 *
 * Deliberately strict. A false negative costs us a personalised greeting; a
 * false positive puts "Hey Privacy Policy," in front of a prospect.
 */
export function looksLikePersonName(raw: string): boolean {
  const value = raw.replace(HONORIFIC, "").trim();
  if (value.length < 3 || value.length > 60) return false;
  if (NOT_A_NAME.test(value)) return false;
  if (looksLikeCompany(value)) return false;
  if (/[0-9@/:_|]/.test(value)) return false;

  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 4) return false;

  // A job title is not a name. Found the hard way: a real page yielded "Host"
  // as a high-confidence person, which would have opened an email "Hey Host,".
  if (tokens.every((token) => ROLE_WORD.test(token))) return false;

  // One function word is enough to know this is a sentence fragment.
  if (tokens.some((token) => FUNCTION_WORD.test(token))) return false;

  // Every token is either a capitalised word or a known surname particle.
  return tokens.every((token) => {
    if (PARTICLE.test(token)) return true;
    if (!/^[A-Z][A-Za-z'’-]*$/.test(token)) return false;
    // Reject ALL-CAPS shouting, which is nearly always a heading.
    return !(token.length > 3 && token === token.toUpperCase());
  });
}


/**
 * Trims a captured string to its leading run of capitalised tokens.
 *
 * The extraction regexes need the `i` flag for their lead-ins ("I'm", "My name
 * is"), but that flag also lets `[A-Z]` match lowercase, so a capture happily
 * runs on: "Shayne Ellis and I help" instead of "Shayne Ellis". This clips it
 * back to the part that can actually be a name.
 */
export function leadingNameRun(value: string): string {
  const kept: string[] = [];
  for (const token of value.trim().split(/\s+/)) {
    if (kept.length > 0 && PARTICLE.test(token)) {
      kept.push(token);
      continue;
    }
    if (!/^[A-Z][A-Za-z'’-]*$/.test(token)) break;
    kept.push(token);
    if (kept.length === 3) break;
  }
  return kept.join(" ");
}

export interface ParsedName {
  fullName: string;
  firstName: string;
  lastName: string | null;
}

export function parsePersonName(raw: string): ParsedName | null {
  const value = raw.replace(HONORIFIC, "").replace(/[.,]+$/, "").trim();
  if (!looksLikePersonName(value)) return null;

  const tokens = value.split(/\s+/).filter(Boolean);
  const firstName = tokens[0]!;
  const lastName = tokens.length > 1 ? tokens.slice(1).join(" ") : null;
  return { fullName: tokens.join(" "), firstName, lastName };
}

/**
 * A name must not simply restate the brand. "Hey RealSide," is the same
 * mistake as a wrong name, dressed up as a right one.
 */
export function collidesWithBrand(name: string, brand: string | null, domain: string): boolean {
  const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z]/g, "");
  const target = normalise(name);
  if (target.length < 3) return true;

  if (brand) {
    const brandNormal = normalise(brand);
    if (brandNormal.includes(target) || target.includes(brandNormal)) return true;
  }

  const domainRoot = normalise(domain.split(".")[0] ?? "");
  return domainRoot.length > 2 && (domainRoot.includes(target) || target.includes(domainRoot));
}

/* --------------------------- extraction regexes --------------------------- */

/**
 * "Hi, I'm Shayne" / "My name is Shayne Ellis" / "I'm Shayne, founder of…"
 *
 * First person only. Whoever wrote this is naming themselves, so a match is
 * strong evidence.
 */
export const SELF_INTRO =
  /\b(?:hi|hey|hello)?[,\s]*(?:i am|i'm|my name is)\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2})\b/gi;

/**
 * "This is Shayne" — the same idea, but those words also begin countless
 * headings ("This Is For You If", "This Is What You Get"). Split out so a
 * match can be trusted less: it needs a second source before it is usable.
 */
export const WEAK_INTRO =
  /\bthis is\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2})\b/gi;

/** "— Shayne" / "Best, Shayne" / "Cheers, Shayne Ellis" */
export const SIGNATURE =
  /(?:^|\n)\s*(?:[-–—]{1,2}\s*|best,?\s*|cheers,?\s*|thanks,?\s*|regards,?\s*|sincerely,?\s*)([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2})\s*(?:\n|$)/gi;

/** "Shayne Ellis, Founder" / "Founder: Shayne Ellis" / "Shayne Ellis — CEO" */
export const NAME_WITH_ROLE = new RegExp(
  `([A-Z][A-Za-z'’-]+(?:\\s+[A-Z][A-Za-z'’-]+){0,2})\\s*[,–—|-]\\s*(${OWNER_ROLE.source.slice(2, -2)})` +
    `|(${OWNER_ROLE.source.slice(2, -2)})\\s*[:–—|-]?\\s*([A-Z][A-Za-z'’-]+(?:\\s+[A-Z][A-Za-z'’-]+){0,2})`,
  "gi",
);

/** RFC-ish, deliberately conservative. */
export const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

/** linkedin.com/in/<slug> — the slug often encodes a real name. */
export const LINKEDIN_PROFILE = /linkedin\.com\/in\/([a-z0-9-]{3,})/i;

/** Turns "shayne-ellis-1a2b3c" into "Shayne Ellis". */
export function nameFromSlug(slug: string): string | null {
  const parts = slug
    .split("-")
    .filter((part) => part.length > 1 && !/^\d+$/.test(part) && !/\d/.test(part));
  if (parts.length < 1 || parts.length > 3) return null;
  const candidate = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
  return looksLikePersonName(candidate) ? candidate : null;
}

/**
 * Turns an email local part into a name, but only when it is unambiguous.
 * "shayne@" and "shayne.ellis@" work; "s.ellis@" and "sales@" do not.
 */
export function nameFromEmailLocalPart(localPart: string): string | null {
  if (isRoleAccount(localPart)) return null;
  const parts = localPart.split(/[._-]/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  // A single initial carries no information and invites a wrong guess.
  if (parts.some((part) => part.length < 3)) return null;
  if (parts.some((part) => /\d/.test(part))) return null;

  const candidate = parts.map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase()).join(" ");
  return looksLikePersonName(candidate) ? candidate : null;
}
