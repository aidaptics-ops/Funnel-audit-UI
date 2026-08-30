import {
  EMAIL_RE,
  LINKEDIN_PROFILE,
  NAME_WITH_ROLE,
  OWNER_ROLE,
  SELF_INTRO,
  SIGNATURE,
  WEAK_INTRO,
  collidesWithBrand,
  isRoleAccount,
  leadingNameRun,
  looksLikePersonName,
  nameFromEmailLocalPart,
  nameFromSlug,
  parsePersonName,
  stripEntitySuffix,
} from "./patterns";
import type { Confidence, EmailCandidate, PersonCandidate } from "./types";

/**
 * Pure extraction. Given some text (a page, an about page, a footer) it emits
 * candidates with provenance. It never decides who the owner is — that is
 * resolve.ts, after corroboration across sources.
 */

export interface ExtractInput {
  text: string;
  /** Where this text came from, shown to the human who confirms. */
  foundOn: string;
  domain: string;
  rootDomain: string;
  brand: string | null;
  /** Links on the page, used for LinkedIn slugs and mailto addresses. */
  links?: string[];
  jsonLd?: unknown[];
}

export interface Extraction {
  people: PersonCandidate[];
  emails: EmailCandidate[];
  legalEntity: string | null;
}

const CONTEXT_CHARS = 120;

export function extractIdentity(input: ExtractInput): Extraction {
  const people: PersonCandidate[] = [];
  const emails: EmailCandidate[] = [];

  const accept = (
    raw: string,
    source: PersonCandidate["source"],
    confidence: Confidence,
    evidence: string,
    role: string | null = null,
  ): void => {
    const parsed = parsePersonName(leadingNameRun(raw));
    if (!parsed) return;
    if (collidesWithBrand(parsed.fullName, input.brand, input.domain)) return;
    people.push({
      ...parsed,
      role,
      source,
      confidence,
      evidence: trim(evidence),
      foundOn: input.foundOn,
    });
  };

  /* ---------------------------- structured data --------------------------- */
  for (const person of personsFromJsonLd(input.jsonLd ?? [])) {
    accept(person.name, "structured_data_person", "high", `JSON-LD ${person.type}: ${person.name}`, person.role);
  }

  /* ------------------------------ page text ------------------------------- */
  for (const match of input.text.matchAll(SELF_INTRO)) {
    accept(match[1] ?? "", "self_introduction", "high", context(input.text, match.index ?? 0));
  }

  // "This is X" only reaches medium: it is as often a heading as an
  // introduction, so it must be corroborated before it can be used.
  for (const match of input.text.matchAll(WEAK_INTRO)) {
    accept(match[1] ?? "", "self_introduction", "medium", context(input.text, match.index ?? 0));
  }

  for (const match of input.text.matchAll(SIGNATURE)) {
    accept(match[1] ?? "", "signature", "medium", context(input.text, match.index ?? 0));
  }

  for (const match of input.text.matchAll(NAME_WITH_ROLE)) {
    // The regex has two arms: "Name, Role" and "Role: Name".
    const name = match[1] ?? match[4] ?? "";
    const role = match[2] ?? match[3] ?? null;
    accept(name, "team_page", "high", context(input.text, match.index ?? 0), role);
  }

  /* -------------------------------- emails -------------------------------- */
  const seenEmails = new Set<string>();
  const collectEmail = (address: string, source: EmailCandidate["source"], evidence: string): void => {
    const value = address.toLowerCase().trim();
    if (!value || seenEmails.has(value)) return;
    // Image filenames and asset hashes trip the regex surprisingly often.
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(value)) return;
    seenEmails.add(value);

    const [localPart = "", host = ""] = value.split("@");
    const generic = isRoleAccount(localPart);
    const onOwnDomain = host.endsWith(input.rootDomain);

    emails.push({
      address: value,
      kind: generic ? "generic_inbox" : onOwnDomain ? "personal" : "unknown",
      source,
      // A personal-looking address on the company's own domain is the strongest
      // signal available without a provider; anything else stays medium/low.
      confidence: generic ? "low" : onOwnDomain ? "high" : "medium",
      evidence: trim(evidence),
      foundOn: input.foundOn,
      observed: true,
    });
  };

  for (const link of input.links ?? []) {
    if (!link.toLowerCase().startsWith("mailto:")) continue;
    const address = link.slice(7).split("?")[0] ?? "";
    collectEmail(address, "mailto_link", `mailto link: ${address}`);
  }

  for (const match of input.text.matchAll(EMAIL_RE)) {
    collectEmail(match[0], "page_text", context(input.text, match.index ?? 0));
  }

  // A personal address can itself name the person — but only when the local
  // part is unambiguous. "s.ellis@" tells us nothing safe.
  for (const email of emails) {
    if (email.kind !== "personal") continue;
    const derived = nameFromEmailLocalPart(email.address.split("@")[0] ?? "");
    if (derived) accept(derived, "email_local_part", "medium", `email address: ${email.address}`);
  }

  /* ------------------------------- LinkedIn ------------------------------- */
  for (const link of input.links ?? []) {
    const match = link.match(LINKEDIN_PROFILE);
    if (!match?.[1]) continue;
    const derived = nameFromSlug(match[1]);
    if (derived) accept(derived, "social_profile", "medium", `LinkedIn profile: ${link}`);
  }

  return { people, emails, legalEntity: legalEntityFrom(input.text) };
}

/* ------------------------------- helpers --------------------------------- */

/** The copyright line names the legal entity — the company, not the person. */
export function legalEntityFrom(text: string): string | null {
  const match = text.match(/(?:©|\(c\)|copyright)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?)?\s*([^.|·•\n]{2,80})/i);
  const raw = match?.[1]?.trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/\b(?:19|20)\d{2}\b/g, "")
    .replace(/\ball rights reserved\b\.?/gi, "")
    .replace(/[\s,.·|•–-]+$/, "")
    .replace(/^[\s,.·|•–-]+/, "")
    .trim();

  return cleaned.length >= 2 && /[a-z]/i.test(cleaned) ? cleaned : null;
}

interface JsonLdPerson {
  name: string;
  role: string | null;
  type: string;
}

/** Walks JSON-LD for Person nodes, plus author/founder fields on any node. */
export function personsFromJsonLd(nodes: unknown[]): JsonLdPerson[] {
  const found: JsonLdPerson[] = [];

  const visit = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;
    const type = String(record["@type"] ?? "");

    if (/person/i.test(type) && typeof record.name === "string") {
      const role = typeof record.jobTitle === "string" ? record.jobTitle : null;
      if (looksLikePersonName(record.name)) found.push({ name: record.name, role, type: "Person" });
    }

    for (const key of ["author", "founder", "creator", "employee", "member"]) {
      const value = record[key];
      if (typeof value === "string" && looksLikePersonName(value)) {
        found.push({ name: value, role: key === "founder" ? "Founder" : null, type: key });
      } else if (value && typeof value === "object") {
        visit(value, depth + 1);
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === "object") visit(value, depth + 1);
    }
  };

  visit(nodes);
  return found;
}

function context(text: string, index: number): string {
  const start = Math.max(0, index - CONTEXT_CHARS / 2);
  return text.slice(start, index + CONTEXT_CHARS).replace(/\s+/g, " ").trim();
}

function trim(value: string): string {
  return value.length > 200 ? `${value.slice(0, 199)}…` : value;
}

export { OWNER_ROLE, stripEntitySuffix };
