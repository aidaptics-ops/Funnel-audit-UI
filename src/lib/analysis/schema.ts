import type { IssueSeverity } from "../audit/types";

/**
 * The shape of a funnel analysis, and a parser that survives whatever the
 * model actually returns.
 *
 * This module is deliberately free of `server-only`: it is pure data coercion,
 * it is the last place a malformed severity or a weight of 4000 can be caught
 * before it reaches a prompt or a screen, and it is therefore the part most
 * worth testing directly.
 *
 * ON THE ABSENCE OF A FINDING VOCABULARY
 * --------------------------------------
 * `id` is a kebab-case slug, unique within one run, used as a React key and a
 * dedupe key and nothing else. There is deliberately NO enum of permitted
 * finding ids. A fixed list would be the crawler's hardcoded rule table moved
 * across a repo boundary and given a new name — the model would be reduced to
 * choosing from opinions formed before it saw the page, which is exactly the
 * failure this upgrade exists to remove.
 */

export type FindingStage = "landing" | "post_booking" | "relationship";

/**
 * What kind of claim a finding makes.
 *
 * "absence" is the dangerous one. Saying a page has no X is only ever
 * permissible over evidence that was collected completely, which is what the
 * capture's completeness ledger exists to declare and what `verify.ts`
 * enforces. Nothing here may default to it.
 */
export type ClaimType = "presence" | "absence" | "relationship";

/** Which page an evidence citation points at. */
export type EvidencePage = "landing" | "post_booking";

/**
 * A pointer into the rendered evidence, plus the text it points at.
 *
 * `field` is a dotted path exactly as `renderPageEvidence` emitted it
 * (`forms[0].fields[2].label`), and `quote` must appear verbatim in that
 * field's rendered value. Both halves are checked: a quote that is real but
 * attached to the wrong path does not verify, because the pairing is the
 * claim.
 */
export interface EvidenceCitation {
  page: EvidencePage;
  field: string;
  quote: string;
}

export interface FunnelFinding {
  /** Kebab-case slug, unique within the run. A key, never a category. */
  id: string;
  stage: FindingStage;
  claimType: ClaimType;
  title: string;
  description: string;
  severity: IssueSeverity;
  category: string;
  /**
   * How worth raising this is in a first cold email to the funnel's owner,
   * 0-100. Not severity: a broken canonical tag can be a real defect and still
   * be worth nothing in an opening email.
   */
  commercialWeight: number;
  citations: EvidenceCitation[];
  /**
   * For an absence claim only: the evidence roots the model says it searched
   * before concluding the thing is not there.
   *
   * This is the search space, and without it an absence claim cannot be
   * checked by machine at all. "There are no testimonials on this page" is
   * only meaningful once someone has said WHERE they looked — `paragraphs`,
   * `visible_text`, `images` — because the verifier's whole job is to ask
   * whether those particular places were collected completely. A claim that
   * names nowhere gets refused rather than trusted.
   *
   * Empty for every other claim type, where it means nothing.
   */
  absenceOver: string[];
  recommendation: string;
  impact: string | null;
}

export interface FunnelClassification {
  funnelType: string | null;
  pageType: string | null;
  conversionGoal: string | null;
  primaryCta: string | null;
  valueProposition: { clarity: string | null; statement: string | null };
  offerClarity: string | null;
  isVsl: boolean;
  bookingStepVisible: boolean;
}

export interface FunnelAnalysisResult {
  findings: FunnelFinding[];
  classification: FunnelClassification;
  relationshipSummary: string | null;
  /**
   * Things the model wanted to say and could not support. Kept rather than
   * discarded: a stated "I could not check X" is worth more to a human reading
   * the run than the silence that would otherwise stand in its place.
   */
  unverifiableNotes: string[];
}

const SEVERITIES: IssueSeverity[] = ["critical", "high", "medium", "low", "informational"];
const STAGES: FindingStage[] = ["landing", "post_booking", "relationship"];
const CLAIM_TYPES: ClaimType[] = ["presence", "absence", "relationship"];
const EVIDENCE_PAGES: EvidencePage[] = ["landing", "post_booking"];

/** Long enough to stay readable in a URL or a DOM id, short enough to scan. */
const MAX_SLUG_CHARS = 60;

/**
 * Turns whatever came back into a result, or null.
 *
 * Total and defensive: no input throws. Null is reserved for output that is
 * not an analysis at all — a non-object, or an object with no findings array —
 * because that is the one case where a repair retry is worth the money.
 * Everything else is coerced, because a model that returned nine good findings
 * and one with a severity of "very bad" has not failed.
 */
export function parseFunnelAnalysis(value: unknown): FunnelAnalysisResult | null {
  const root = asRecord(value);
  if (!root) return null;

  const rawFindings = pick(root, "findings");
  if (!Array.isArray(rawFindings)) return null;

  const used = new Set<string>();
  const findings = rawFindings
    .map((entry, position) => parseFinding(entry, position, used))
    .filter((finding): finding is FunnelFinding => finding !== null);

  return {
    findings,
    classification: parseClassification(pick(root, "classification")),
    relationshipSummary: str(pick(root, "relationship_summary", "relationshipSummary")),
    unverifiableNotes: strList(pick(root, "unverifiable_notes", "unverifiableNotes")),
  };
}

function parseFinding(value: unknown, position: number, used: Set<string>): FunnelFinding | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const stage = oneOf(pick(raw, "stage"), STAGES, "landing");
  const title = str(pick(raw, "title"));
  const id = uniqueSlug(str(pick(raw, "id")) ?? title ?? `finding-${position + 1}`, position, used);

  return {
    id,
    stage,
    // "presence" is the default because it is the claim that needs the least
    // licence. Defaulting a missing field to "absence" would hand an unstated
    // claim the strongest permissions in the system.
    claimType: oneOf(pick(raw, "claim_type", "claimType"), CLAIM_TYPES, "presence"),
    title: title ?? id,
    description: str(pick(raw, "description")) ?? "",
    severity: oneOf(pick(raw, "severity"), SEVERITIES, "low"),
    category: str(pick(raw, "category")) ?? "other",
    commercialWeight: clampWeight(pick(raw, "commercial_weight", "commercialWeight")),
    citations: parseCitations(pick(raw, "citations"), stage),
    absenceOver: parseRoots(pick(raw, "absence_over", "absenceOver")),
    recommendation: str(pick(raw, "recommendation")) ?? "",
    impact: str(pick(raw, "impact")),
  };
}

function parseCitations(value: unknown, stage: FindingStage): EvidenceCitation[] {
  if (!Array.isArray(value)) return [];
  const fallbackPage: EvidencePage = stage === "post_booking" ? "post_booking" : "landing";

  return value
    .map((entry): EvidenceCitation | null => {
      const raw = asRecord(entry);
      if (!raw) return null;
      const field = str(pick(raw, "field", "path"));
      const quote = str(pick(raw, "quote", "text"));
      // A citation with no path or no quote cites nothing. It is dropped here
      // rather than carried forward as an empty pointer the verifier would
      // have to reject again.
      if (!field || !quote) return null;
      return { page: oneOf(pick(raw, "page"), EVIDENCE_PAGES, fallbackPage), field, quote };
    })
    .filter((citation): citation is EvidenceCitation => citation !== null);
}

/**
 * The stated search space, reduced to bare path roots.
 *
 * A model asked for roots will sometimes give a path (`paragraphs[3].text`) or
 * a whole collection with an index. Both name the same place, so the indices
 * are stripped rather than the answer refused — but nothing is invented: a
 * list that is not a list of strings comes back empty, and an empty search
 * space is what makes the verifier refuse the claim.
 */
export function parseRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roots = value
    .map(str)
    .filter((entry): entry is string => entry !== null)
    .map((entry) => entry.replace(/\[\d+\]/g, "").replace(/^\.+|\.+$/g, "").trim())
    .filter((entry) => entry !== "");
  return [...new Set(roots)];
}

function parseClassification(value: unknown): FunnelClassification {
  const raw = asRecord(value) ?? {};
  const valueProp = asRecord(pick(raw, "value_proposition", "valueProposition")) ?? {};

  return {
    funnelType: str(pick(raw, "funnel_type", "funnelType")),
    pageType: str(pick(raw, "page_type", "pageType")),
    conversionGoal: str(pick(raw, "conversion_goal", "conversionGoal")),
    primaryCta: str(pick(raw, "primary_cta", "primaryCta")),
    valueProposition: {
      clarity: str(pick(valueProp, "clarity")),
      statement: str(pick(valueProp, "statement")),
    },
    offerClarity: str(pick(raw, "offer_clarity", "offerClarity")),
    isVsl: pick(raw, "is_vsl", "isVsl") === true,
    bookingStepVisible: pick(raw, "booking_step_visible", "bookingStepVisible") === true,
  };
}

/**
 * A model can return 4000, -1, NaN or "high" where a 0-100 number belongs.
 * Clamping is cheaper than trusting it, and far cheaper than discovering the
 * ranking was wrong from an email that opened with a missing canonical tag.
 */
export function clampWeight(value: unknown): number {
  const weight = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  if (Number.isNaN(weight)) return 0;
  return Math.min(100, Math.max(0, Math.round(weight)));
}

/**
 * Kebab-cases an id and guarantees it is unique within the run.
 *
 * Uniqueness is enforced here rather than trusted from the model because the
 * id is a React key: two findings sharing one produces a UI that silently
 * renders one of them, which is the kind of bug that survives review.
 */
export function uniqueSlug(input: string, position: number, used: Set<string>): string {
  const base = slugify(input) || `finding-${position + 1}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export function slugify(input: string): string {
  return input
    // NFKD first: "café" decomposes to "cafe" plus a combining accent, and the
    // class below turns the accent into a separator that then gets trimmed.
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, "");
}

/* ------------------------------- coercion -------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads the first key that is present.
 *
 * The prompt asks for snake_case, but a model that has read a million
 * TypeScript files will occasionally answer in camelCase. Accepting both costs
 * one line and removes an entire class of empty-result bug.
 */
function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter((entry): entry is string => entry !== null);
}
