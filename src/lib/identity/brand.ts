import { looksLikePersonName, parsePersonName, stripEntitySuffix } from "./patterns";

/**
 * What is this business called?
 *
 * Everything downstream depends on this. A founder search for the wrong
 * company finds the wrong person, so getting the name right is not a nicety —
 * it is the first gate, and the pipeline should stop here rather than proceed
 * on a guess.
 *
 * Built against a funnel that defeated the previous version completely. Its
 * footer reads:
 *
 *     @â€"2026 Patrick Wu - The Art of Wooing
 *
 * Three things went wrong there, and each is handled below: the copyright
 * glyph arrived mojibaked so no `©` was ever present to match; the line packs
 * a PERSON and a BUSINESS into one string; and the business is the half after
 * the dash, not the half that looks like a name.
 */

export type BrandConfidence = "high" | "medium" | "low";

export interface BrandFinding {
  /** The trading name. Null when nothing was confident enough. */
  businessName: string | null;
  /** A person named alongside it — often the founder, stated right there. */
  personName: string | null;
  /** Legal entity, suffix intact, when the page gives one. */
  legalEntity: string | null;
  confidence: BrandConfidence;
  /** The line it came from, verbatim, so a human can check it in one glance. */
  evidence: string | null;
  /** Which pattern matched, for the audit trail. */
  method: string | null;
}

/**
 * Repairs UTF-8 text that was decoded as Latin-1 somewhere upstream.
 *
 * "â€™" for an apostrophe and "â€"" for a dash are the signatures. Without
 * this the copyright line is unrecognisable to every pattern below, which is
 * exactly why the live funnel returned nothing at all.
 */
export function repairMojibake(text: string): string {
  if (!/[ÂâÃ]\S/.test(text)) return text;
  return text
    .replace(/â€™/g, "’")
    .replace(/â€œ/g, "“")
    .replace(/â€/g, "”")
    .replace(/â€"/g, "—")
    .replace(/â€“/g, "–")
    .replace(/â€¦/g, "…")
    .replace(/Â©/g, "©")
    .replace(/Â®/g, "®")
    .replace(/Â™/g, "™")
    .replace(/Â /g, " ")
    .replace(/Â/g, "");
}

/**
 * The copyright marker, as it actually appears in the wild.
 *
 * Matching only "©" is why the live case failed: after mojibake the glyph had
 * become "@", and plenty of pages write "(c)" or nothing at all before the
 * year. A four-digit year near the foot of the page carries most of the
 * signal, so the marker itself is optional.
 */
const COPYRIGHT_LINE =
  /(?:©|\(c\)|copyright|@|—|–)?\s*(?:20\d{2}|19\d{2})(?:\s*[-–—]\s*(?:20\d{2}))?\s*[,.\-–—:]?\s*([^\n|·•]{2,90})/i;

/** Trailing noise that follows a name on a footer line. */
const TRAILING_NOISE =
  /\b(all rights reserved|privacy policy|terms(?: of service| and conditions)?|cookie policy|disclaimer|contact us|sitemap)\b.*$/i;

/**
 * Separators that pack "Person - Business" onto one line.
 *
 * Whitespace on BOTH sides is required. Without it "growth-minded men" splits
 * at its own hyphen and the tagline becomes a business name.
 */
const PERSON_BUSINESS = /^(.{2,45}?)\s+[-–—|]\s+(.{2,60})$/;

/** Words that mean the line is a tagline, not a name. */
const TAGLINE =
  /\b(helping|we help|our mission|the best|learn|discover|get|join|free|guide|training|masterclass|coach(?:ing)?|welcome)\b/i;

export function extractBrand(input: {
  /** The page's visible text, ideally including the footer. */
  text: string;
  /** Anything the audit already believed. */
  auditBrand?: string | null;
  copyrightHolders?: string[];
  pageTitle?: string | null;
  domain: string;
}): BrandFinding {
  const text = repairMojibake(input.text ?? "");

  // 1. The audit's own copyright extraction, when it produced anything.
  for (const holder of input.copyrightHolders ?? []) {
    const parsed = readCopyright(repairMojibake(holder), input.domain);
    if (parsed.businessName) return { ...parsed, method: "audit copyright_holders", confidence: "high" };
  }

  // 2. Copyright-shaped lines in the page text. This is where the live case
  //    is caught: no "©" survives, but "2026 Patrick Wu - The Art of Wooing"
  //    still reads as a copyright line.
  for (const line of copyrightCandidates(text)) {
    const parsed = readCopyright(line, input.domain);
    if (parsed.businessName) return { ...parsed, method: "copyright line", confidence: "high" };
  }

  // 3. An explicit legal entity anywhere on the page.
  // The suffix has to TERMINATE the name. Without the trailing guard,
  // "Limited spots remaining" reads as a company called "... Limited".
  const entity = text.match(
    /\b([A-Z][A-Za-z0-9&'.\- ]{1,50}?\s(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Ltd\.?|Limited|GmbH|Pty Ltd|PLC|LLP))(?=[\s.,;:)\]]*(?:$|\n|[A-Z]))/m,
  );
  if (entity?.[1]) {
    const legal = entity[1].trim();
    return {
      businessName: stripEntitySuffix(legal) || legal,
      personName: null,
      legalEntity: legal,
      confidence: "high",
      evidence: legal,
      method: "legal entity suffix",
    };
  }

  // 4. A trademarked name — "The Art of Wooing™" is the brand by definition.
  // Anchored to the LAST capitalised run before the symbol: starting at the
  // first capital swallows "Welcome to ..." and the tagline filter then kills
  // a perfectly good brand.
  const trademark = text.match(/((?:[A-Z][A-Za-z0-9&'.-]*)(?:\s+(?:[A-Z][A-Za-z0-9&'.-]*|of|the|and|for)){0,5})\s*[™®]/);
  if (trademark?.[1] && !TAGLINE.test(trademark[1])) {
    const name = tidy(trademark[1]);
    if (name) {
      return {
        businessName: name,
        personName: null,
        legalEntity: null,
        confidence: "high",
        evidence: trademark[0].trim(),
        method: "trademark symbol",
      };
    }
  }

  // 5. Whatever the audit called the brand.
  if (input.auditBrand && !collidesWithDomainOnly(input.auditBrand, input.domain)) {
    return {
      businessName: tidy(input.auditBrand),
      personName: null,
      legalEntity: null,
      confidence: "medium",
      evidence: input.auditBrand,
      method: "audit brand",
    };
  }

  // 6. The page title, minus the marketing half.
  const fromTitle = titleBrand(input.pageTitle);
  if (fromTitle) {
    return {
      businessName: fromTitle,
      personName: null,
      legalEntity: null,
      confidence: "low",
      evidence: input.pageTitle ?? null,
      method: "page title",
    };
  }

  // Deliberately NOT falling back to the domain. "thefinallover" is not the
  // business name, and searching for it finds nobody — a wrong name here
  // poisons every step that follows, so no name is the better answer.
  return {
    businessName: null,
    personName: null,
    legalEntity: null,
    confidence: "low",
    evidence: null,
    method: null,
  };
}

/** Lines that look like a copyright notice, most-likely first. */
function copyrightCandidates(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 160);

  // The word "copyright" on its own is not enough: "no copyright anywhere" is
  // prose. A year or an actual glyph is what makes a line a notice.
  const marked = lines.filter(
    (line) => /©|\(c\)/i.test(line) || (/copyright/i.test(line) && /(?:19|20)\d{2}/.test(line)),
  );
  // A bare year late in the document is the usual shape once the glyph is lost.
  const yearly = lines.filter((line) => /(?:^|[^\d])(?:20\d{2}|19\d{2})(?:[^\d]|$)/.test(line));

  return [...new Set([...marked, ...yearly])].slice(0, 12);
}

/**
 * Reads one copyright line into a business, and a person when both are there.
 *
 * "Patrick Wu - The Art of Wooing" is the case that matters: the FIRST half is
 * the human and the SECOND is the business. Treating the person as the company
 * would send the founder search hunting for a company called Patrick Wu.
 */
function readCopyright(line: string, domain: string): Omit<BrandFinding, "method" | "confidence"> {
  const cleaned = tidy(line.replace(TRAILING_NOISE, ""));
  if (!cleaned) return empty();

  const match = COPYRIGHT_LINE.exec(cleaned);
  const body = tidy((match?.[1] ?? cleaned).replace(TRAILING_NOISE, ""));
  if (!body) return empty();

  const split = PERSON_BUSINESS.exec(body);
  if (split) {
    const left = tidy(split[1] ?? "");
    const right = tidy(split[2] ?? "");
    const leftIsPerson = left ? looksLikePersonName(left) : false;
    const rightIsPerson = right ? looksLikePersonName(right) : false;

    // Person on one side, business on the other. The business is whichever
    // half is NOT the human.
    if (leftIsPerson && right && !rightIsPerson && !TAGLINE.test(right)) {
      return {
        businessName: right,
        personName: left ? (parsePersonName(left)?.fullName ?? null) : null,
        legalEntity: hasSuffix(right) ? right : null,
        evidence: cleaned,
      };
    }
    if (rightIsPerson && left && !leftIsPerson && !TAGLINE.test(left)) {
      return {
        businessName: left,
        personName: right ? (parsePersonName(right)?.fullName ?? null) : null,
        legalEntity: hasSuffix(left) ? left : null,
        evidence: cleaned,
      };
    }
    // Neither half is a person: the longer half is usually the business and
    // the shorter one a location or a division.
    if (!leftIsPerson && !rightIsPerson) {
      const business = (right?.length ?? 0) > (left?.length ?? 0) ? right : left;
      if (business && !TAGLINE.test(business) && !isNoise(business, domain)) {
        return {
          businessName: business,
          personName: null,
          legalEntity: hasSuffix(business) ? business : null,
          evidence: cleaned,
        };
      }
    }
  }

  if (TAGLINE.test(body) || isNoise(body, domain)) return empty();

  // A lone personal name in a copyright line is a sole trader: the person IS
  // the business, and both fields should say so rather than one guessing.
  if (looksLikePersonName(body)) {
    return {
      businessName: body,
      personName: parsePersonName(body)?.fullName ?? null,
      legalEntity: null,
      evidence: cleaned,
    };
  }

  return {
    // The trading name loses the suffix — "WCLIVE" is what people search for —
    // while legalEntity keeps it intact for the record.
    businessName: hasSuffix(body) ? (stripEntitySuffix(body) || body) : body,
    personName: null,
    legalEntity: hasSuffix(body) ? body : null,
    evidence: cleaned,
  };
}

/** "The Art of Wooing | Free Guide" -> "The Art of Wooing". */
function titleBrand(title: string | null | undefined): string | null {
  if (!title) return null;
  const parts = title
    .split(/[|·—–]/)
    .map((part) => tidy(part))
    .filter((part): part is string => part !== null && !TAGLINE.test(part));
  // The brand is conventionally last in a title, after the page name.
  const candidate = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  return candidate && candidate.length >= 3 && candidate.split(/\s+/).length <= 6 ? candidate : null;
}

function hasSuffix(value: string): boolean {
  return /\b(LLC|L\.L\.C\.|Inc\.?|Incorporated|Ltd\.?|Limited|GmbH|Pty|PLC|LLP)\b/i.test(value);
}

function isNoise(value: string, domain: string): boolean {
  const normal = value.toLowerCase().replace(/[^a-z]/g, "");
  if (normal.length < 2) return true;
  if (/^(home|about|contact|privacy|terms|login|allrightsreserved)$/.test(normal)) return true;
  // Against the domain's first label — "example.com" normalises to
  // "examplecom", which would never equal the "example" written on the page.
  const root = (domain.split(".")[0] ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return root.length > 1 && normal === root;
}

function collidesWithDomainOnly(value: string, domain: string): boolean {
  const normal = value.toLowerCase().replace(/[^a-z]/g, "");
  const root = domain.split(".")[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  return normal === root;
}

function tidy(value: string): string | null {
  const cleaned = value
    .replace(/[©™®]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-–—:|@]+/, "")
    .replace(/[\s,.\-–—:|]+$/, "")
    .trim();
  return cleaned.length >= 2 && cleaned.length <= 90 ? cleaned : null;
}

function empty(): Omit<BrandFinding, "method" | "confidence"> {
  return { businessName: null, personName: null, legalEntity: null, evidence: null };
}
