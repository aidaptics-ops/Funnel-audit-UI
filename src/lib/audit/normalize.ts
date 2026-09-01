import type { Determination, IssueSeverity, RawAnalysis, RawObservedIssue } from "./types";

/**
 * Turns a raw audit response into a compact, total shape the UI and the AI
 * context builder can rely on. Every read is defensive: a missing section, a
 * null value or an "unknown" determination must never throw.
 */

/** Which page an evidence line was observed on. */
export type EvidencePage = "landing" | "post_booking";

/**
 * One observed line, tagged with where it was seen.
 *
 * The tag exists because the two pages carry different licences: a claim about
 * the landing page is backed by a rendered screenshot, and a claim about the
 * page after conversion is only ever as good as whatever was actually reached.
 * Untagged evidence makes those indistinguishable once it is in a prompt.
 */
export interface EvidenceLine {
  text: string;
  page: EvidencePage;
}

/**
 * Reads an evidence line as plain text.
 *
 * Tolerates a bare string because rows written before lines carried a page tag
 * are still read back from storage, and a history page that renders blanks for
 * them would be a regression nobody notices until the data is gone.
 */
export function evidenceText(line: EvidenceLine | string): string {
  return typeof line === "string" ? line : line.text;
}

/** Where in the funnel the finding sits. */
export type IssueStage = "landing" | "post_booking" | "relationship";

/**
 * What kind of claim the finding makes.
 *
 * "absence" is the dangerous one: saying a page has no X is only permissible
 * over evidence that was collected completely, which is what the API's
 * completeness ledger exists to declare.
 */
export type ClaimType = "presence" | "absence" | "relationship";

export interface NormalizedIssue {
  id: string;
  /** Which page (or which pair of pages) the finding is about. */
  stage: IssueStage;
  claimType: ClaimType;
  severity: IssueSeverity;
  category: string;
  title: string;
  description: string;
  evidence: EvidenceLine[];
  /** Pointers back into the raw evidence — field names, selectors, hosts. */
  citations: string[];
  recommendation: string;
  impact: string | null;
  confidence: number | null;
  /**
   * How worth raising this is in a first cold email, 0-100.
   *
   * It arrives from the finding rather than a table here. Ranking findings is
   * interpretation, and a weight table in this file would be the same mistake
   * as a rule table in the crawler: a fixed opinion about pages it has never
   * seen, applied with more confidence than it has earned.
   */
  commercialWeight: number;
}

/**
 * A finding as the analysis model produces it.
 *
 * Every field is optional and every value is treated as untrusted: this is
 * model output, and normalising it is the last place a malformed severity or a
 * weight of 4000 can be caught before it reaches a prompt.
 */
export interface AuditFinding {
  id?: string;
  stage?: string;
  claim_type?: string;
  severity?: string;
  category?: string;
  title?: string;
  description?: string;
  evidence?: (string | { text?: string; page?: string })[];
  citations?: string[];
  recommendation?: string;
  impact?: string;
  confidence?: number;
  commercial_weight?: number;
}

/**
 * What this run knows about the page after conversion.
 *
 * Down from four crawl outcomes to two, because there is no longer a crawl to
 * describe: the audit never visits a second URL. The operator either has
 * supplied a screenshot of that stage — via the pre-existing manual-upload
 * feature — or has not yet.
 */
export type PostBookingOutcome = "not_supplied" | "supplied";

export interface NormalizedAudit {
  jobId: string | null;
  schemaVersion: string | null;
  analyzedAt: string | null;
  durationMs: number | null;

  requestedUrl: string;
  finalUrl: string;
  domain: string;
  brand: string | null;
  funnelType: string | null;
  funnelTypeConfidence: number | null;
  pageType: string | null;
  conversionGoal: string | null;

  pageTitle: string | null;
  metaDescription: string | null;
  headline: string | null;
  subheadline: string | null;
  valueProposition: { clarity: string | null; statement: string | null };
  supportingCopy: string[];
  keyMessages: string[];
  wordCount: number | null;

  offer: {
    product: string | null;
    audience: string | null;
    mechanism: string | null;
    benefits: string[];
    clarity: string | null;
    missing: string[];
  };

  ctas: { text: string; aboveFold: boolean; isPrimary: boolean; destinationKind: string | null }[];
  primaryCta: string | null;
  ctaCount: number;
  ctaAboveFoldCount: number;

  forms: { provider: string; integration: string; fieldCount: number; aboveFold: boolean; ctaText: string | null }[];
  hasScheduler: boolean;

  proof: { testimonials: number; logos: number; ratings: number; numericClaims: number };
  testimonials: { text: string; name: string | null }[];

  pricingDetected: boolean;
  guaranteePresent: boolean;
  urgencyDetected: boolean;
  urgencyQuality: string | null;

  videoCount: number;
  isVsl: boolean;

  tracking: { vendors: string[]; hasAnalytics: boolean; hasAdPixel: boolean; statements: string[] };

  navItemCount: number;
  brokenLinks: string[];

  issues: NormalizedIssue[];
  issueCounts: Record<IssueSeverity, number>;

  contact: { emails: string[]; phones: string[]; organizations: string[] };

  /** Everything the audit genuinely could NOT see. Drives the AI guardrails. */
  observability: Observability;
}

export interface Observability {
  /**
   * How far the evidence reaches. "landing_only" is the audit as it has always
   * worked: one page, rendered, nothing beyond it.
   */
  scope: "landing_only" | "landing_and_post_booking";
  /** True only when the operator has supplied at least one post-booking screenshot. */
  postBookingObserved: boolean;
  /** The same fact, as the two-state outcome. */
  postBookingStatus: PostBookingOutcome;
  /**
   * Literally false, permanently.
   *
   * The crawler fills nothing in and submits nothing, ever. This is a constant
   * rather than a variable on purpose: the day it becomes a boolean is the day
   * a bug can flip it, and the guardrail that reads it is the one thing
   * standing between the generator and inventing a form's thank-you page.
   */
  formSubmissionObserved: false;
  /** True only when a booking/scheduler step is visibly present on the page. */
  bookingStepVisible: boolean;
  notes: string[];
}

const SEVERITY_ORDER: IssueSeverity[] = ["critical", "high", "medium", "low", "informational"];

/**
 * How much a crawler issue is worth raising in a first cold email.
 *
 * This table belongs to the LEGACY path and to nothing else. It is a fixed
 * opinion about pages it has never seen, which is exactly why the model path
 * below does not have one — but it is also the ordering that is running in
 * production today, and `audit.issues` is sliced to the first four in
 * `email/context.ts` and to the first three for the sheet's top_issue columns.
 * Deleting it while `observed_issues` is still the only live path would not
 * have been a simplification; it would have silently changed which four
 * observations every email in flight is built from, and made every new sheet
 * row incomparable with every historical one.
 *
 * It goes when the model path replaces it, in the phase that wires the
 * analysis call through and supplies the weights that stand in for it.
 */
const COMMERCIAL_WEIGHT: Record<string, number> = {
  NO_CTA_DETECTED: 100,
  NO_FORM_OR_CONVERSION_PATH: 95,
  BROKEN_CTA_DESTINATION: 95,
  NO_CTA_ABOVE_FOLD: 80,
  OFFER_CLARITY_UNCLEAR: 85,
  NO_VISIBLE_SOCIAL_PROOF: 75,
  COMPETING_PRIMARY_ACTIONS: 70,
  WEAK_CTA_HIERARCHY: 55,
  THIN_COPY: 60,
  EXCESSIVE_NAVIGATION: 55,
  NO_PRICE_AND_NO_LEAD_CAPTURE: 50,
  BROKEN_IMAGES: 50,
  NO_ANALYTICS_DETECTED: 45,
  NO_ADVERTISING_PIXEL_DETECTED: 40,
  NO_GUARANTEE_OR_RISK_REVERSAL: 35,
  HORIZONTAL_OVERFLOW: 35,
  MISSING_VIEWPORT_META: 30,
  NOT_HTTPS: 60,
  NOINDEX_DETECTED: 40,
  // Housekeeping: real, but not what a cold email should lead with.
  MISSING_TITLE: 20,
  MISSING_META_DESCRIPTION: 10,
  MISSING_CANONICAL: 5,
  BROKEN_HEADING_HIERARCHY: 5,
  MULTIPLE_H1: 5,
  IMAGES_MISSING_ALT: 5,
  CONSOLE_ERRORS: 10,
  FAILED_REQUESTS: 10,
};

const SEVERITY_BONUS: Record<IssueSeverity, number> = {
  critical: 25,
  high: 15,
  medium: 5,
  low: 0,
  informational: -20,
};

const STAGES: IssueStage[] = ["landing", "post_booking", "relationship"];
const CLAIM_TYPES: ClaimType[] = ["presence", "absence", "relationship"];
const EVIDENCE_PAGES: EvidencePage[] = ["landing", "post_booking"];

export interface NormalizeMeta {
  jobId: string | null;
  requestedUrl: string;
  /**
   * Findings from the analysis model. Absent whenever the analysis call has
   * not run or did not come back, which is exactly when the legacy fallback
   * below has to carry the run.
   */
  findings?: AuditFinding[];
  /** How many post-booking screenshots the operator has supplied, so far. */
  suppliedScreenshotCount?: number;
}

export function normalizeAudit(raw: RawAnalysis, meta: NormalizeMeta): NormalizedAudit {
  const funnel = raw.funnel ?? {};
  const page = raw.page ?? {};
  const hero = raw.hero ?? {};
  const offer = raw.offer ?? {};
  const summary = raw.summary ?? {};

  const ctas = arr(raw.ctas).map((cta) => ({
    text: str(cta?.text) ?? "",
    aboveFold: bool(cta?.above_fold),
    isPrimary: bool(cta?.is_primary),
    destinationKind: str(cta?.destination?.kind),
  }));

  const forms = arr(raw.forms).map((form) => ({
    provider: str(form?.provider) ?? "unknown",
    integration: str(form?.integration) ?? "unknown",
    fieldCount: num(form?.field_count) ?? 0,
    aboveFold: bool(form?.location?.above_fold),
    ctaText: str(form?.cta_text),
  }));

  /*
   * The DEFAULT answer to "does this page book something".
   *
   * A later phase lets an analysis finding override this, because a model
   * looking at the screenshot spots a scheduler that renders as a bare div
   * with no recognisable provider in its markup. It does not replace it: the
   * classification does not exist on any run where the analysis call fails,
   * and a booking funnel silently reading as a non-booking one is worse than a
   * heuristic that occasionally misses.
   */
  const hasScheduler =
    ctas.some((cta) => cta.destinationKind === "scheduler") ||
    arr(raw.forms).some((form) => /calendly|savvycal|acuity|hubspot|cal\.com/i.test(str(form?.provider) ?? ""));

  const findings = arr(meta.findings);
  const issues = findings.length > 0 ? normalizeFindings(findings) : normalizeLegacyIssues(raw.observed_issues);

  const issueCounts = SEVERITY_ORDER.reduce(
    (acc, severity) => {
      acc[severity] = issues.filter((issue) => issue.severity === severity).length;
      return acc;
    },
    {} as Record<IssueSeverity, number>,
  );

  const identity = funnel.business_identity ?? {};
  const suppliedScreenshotCount = meta.suppliedScreenshotCount ?? 0;

  const trackingVendors = arr(raw.tracking?.detected)
    .map((vendor) => str(vendor?.vendor))
    .filter(isNonEmptyString);

  return {
    jobId: meta.jobId,
    schemaVersion: str(raw.schema_version),
    analyzedAt: str(raw.analyzed_at),
    durationMs: num(raw.duration_ms),

    requestedUrl: str(funnel.requested_url) ?? meta.requestedUrl,
    finalUrl: str(funnel.final_url) ?? str(page.final_url) ?? meta.requestedUrl,
    domain: str(funnel.domain) ?? "",
    brand: determined(funnel.brand_name),
    funnelType: determined(funnel.funnel_type),
    funnelTypeConfidence: confidenceOf(funnel.funnel_type),
    pageType: str(funnel.page_type_classification?.page_type),
    conversionGoal: determined(funnel.primary_conversion_goal),

    pageTitle: str(page.title),
    metaDescription: str(page.meta_description),
    headline: str(hero.headline),
    subheadline: str(hero.subheadline),
    valueProposition: {
      clarity: valuePropClarity(hero.value_proposition),
      statement: valuePropStatement(hero.value_proposition),
    },
    supportingCopy: arr(hero.supporting_copy).filter(isNonEmptyString).slice(0, 6),
    keyMessages: arr(raw.copy?.key_messages).filter(isNonEmptyString).slice(0, 10),
    wordCount: num(raw.copy?.word_count),

    offer: {
      product: determined(offer.product),
      audience: determined(offer.audience),
      mechanism: determined(offer.mechanism),
      benefits: arr(offer.benefits).filter(isNonEmptyString).slice(0, 8),
      clarity: offerClarity(offer.clarity),
      missing: offerMissing(offer.clarity),
    },

    ctas,
    primaryCta: str(summary.ctas?.primary_text) ?? ctas.find((cta) => cta.isPrimary)?.text ?? null,
    ctaCount: num(summary.ctas?.total) ?? ctas.length,
    ctaAboveFoldCount: num(summary.ctas?.above_fold) ?? ctas.filter((cta) => cta.aboveFold).length,

    forms,
    hasScheduler,

    proof: {
      testimonials: num(raw.social_proof?.testimonial_count) ?? arr(raw.testimonials).length,
      logos: arr(raw.social_proof?.client_logos).length,
      ratings: arr(raw.social_proof?.ratings).length,
      numericClaims: arr(raw.social_proof?.numeric_claims).length,
    },
    testimonials: arr(raw.testimonials)
      .map((item) => ({ text: str(item?.text) ?? "", name: str(item?.name) }))
      .filter((item) => item.text !== "")
      .slice(0, 5),

    pricingDetected: bool(raw.pricing?.detected),
    guaranteePresent: bool(raw.guarantees?.detected) || bool(offer.guarantee_present),
    urgencyDetected: bool(raw.urgency?.detected),
    urgencyQuality: urgencyQuality(raw.urgency),

    videoCount: num(summary.videos?.dom_count) ?? arr(raw.videos).length,
    isVsl: raw.vsl?.determination?.status === "detected",

    tracking: {
      vendors: trackingVendors,
      hasAnalytics: bool(raw.tracking?.has_analytics),
      hasAdPixel: bool(raw.tracking?.has_advertising_pixel),
      statements: trackingStatements(raw.tracking, trackingVendors),
    },

    navItemCount: num(raw.navigation?.nav_item_count) ?? 0,
    brokenLinks: arr(raw.links?.broken)
      .map((link) => str(link?.url))
      .filter(isNonEmptyString),

    issues,
    issueCounts,

    contact: {
      emails: arr(identity.contact_emails).filter(isNonEmptyString),
      phones: arr(identity.contact_phones).filter(isNonEmptyString),
      organizations: arr(identity.organization_names).filter(isNonEmptyString),
    },

    observability: buildObservability(hasScheduler, forms.length > 0, suppliedScreenshotCount),
  };
}

/**
 * What the audit could not see, stated rather than implied.
 *
 * The only source of post-booking evidence is the operator's own screenshot
 * (the pre-existing manual-upload feature) — there is no crawl of a second
 * URL to describe. So this collapses to one question: has he supplied one yet.
 */
export function buildObservability(
  hasScheduler: boolean,
  hasForm: boolean,
  suppliedScreenshotCount: number,
): Observability {
  const status: PostBookingOutcome = suppliedScreenshotCount > 0 ? "supplied" : "not_supplied";
  const observed = status === "supplied";

  const notes = ["The audit filled in no form, submitted nothing, and bought or booked nothing."];

  if (observed) {
    notes.push(
      `The operator supplied ${suppliedScreenshotCount} screenshot(s) of the page after conversion.`,
      "Those are a real page he saw, so they may be described directly.",
      "Nothing past that page — email sequences, reminders, the call itself — was observed.",
    );
  } else {
    notes.push(
      "No screenshot of the page after conversion has been supplied for this funnel yet.",
      "Nothing about what happens AFTER a visitor converts was observed.",
    );
  }

  if (hasScheduler) {
    notes.push("A scheduler/booking widget is visibly present on the page, but it was never opened or used.");
  }
  if (hasForm) {
    notes.push("A form is present and its fields were read, but it was never filled in or submitted.");
  }

  return {
    scope: observed ? "landing_and_post_booking" : "landing_only",
    postBookingObserved: observed,
    postBookingStatus: status,
    formSubmissionObserved: false,
    bookingStepVisible: hasScheduler,
    notes,
  };
}

/* ------------------------------- findings -------------------------------- */

function normalizeFindings(findings: AuditFinding[]): NormalizedIssue[] {
  return findings
    .map(normalizeFinding)
    .filter((issue): issue is NormalizedIssue => issue !== null)
    .sort((left, right) => right.commercialWeight - left.commercialWeight);
}

function normalizeFinding(raw: AuditFinding | undefined): NormalizedIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.id);
  if (!id) return null;

  const stage: IssueStage = isStage(raw.stage) ? raw.stage : "landing";
  const evidence = arr(raw.evidence)
    .map((entry) => toEvidenceLine(entry, stage))
    .filter((entry): entry is EvidenceLine => entry !== null);
  // The audit guarantees evidence on every issue; if it is missing, the finding
  // is not usable as outreach material and we drop it rather than guess.
  if (evidence.length === 0) return null;

  return {
    id,
    stage,
    claimType: isClaimType(raw.claim_type) ? raw.claim_type : "presence",
    severity: severityOf(raw.severity),
    category: str(raw.category) ?? "other",
    title: str(raw.title) ?? id,
    description: str(raw.description) ?? "",
    evidence,
    citations: arr(raw.citations).filter(isNonEmptyString),
    recommendation: str(raw.recommendation) ?? "",
    impact: str(raw.impact),
    confidence: num(raw.confidence),
    commercialWeight: clampWeight(raw.commercial_weight),
  };
}

function toEvidenceLine(entry: string | { text?: string; page?: string } | undefined, stage: IssueStage): EvidenceLine | null {
  if (typeof entry === "string") {
    const text = str(entry);
    return text ? { text, page: stage === "post_booking" ? "post_booking" : "landing" } : null;
  }
  if (!entry || typeof entry !== "object") return null;
  const text = str(entry.text);
  if (!text) return null;
  const page = isEvidencePage(entry.page) ? entry.page : stage === "post_booking" ? "post_booking" : "landing";
  return { text, page };
}

/**
 * A model can return 4000, -1 or "high" where a number belongs. Clamping is
 * cheaper than trusting it and cheaper still than discovering the ordering is
 * wrong from an email that led with a missing canonical tag.
 */
function clampWeight(value: unknown): number {
  const weight = num(value);
  if (weight === null) return 0;
  return Math.min(100, Math.max(0, Math.round(weight)));
}

/* --------------------------- legacy issue path ---------------------------- */

/**
 * The crawler's own `observed_issues`, normalised.
 *
 * This is the fallback used whenever no model findings are available — an
 * analysis call that failed, an API build older than this dashboard, or the
 * feature switched off. Until the analysis call is actually wired up it is not
 * the fallback at all: it is the ONLY path, and so it is kept behaving exactly
 * as it does in production, weight table and weight ordering intact.
 *
 * The ordering is load-bearing rather than cosmetic. `email/context.ts` takes
 * the first four issues and nothing else, and the sheet records the first
 * three; ranking by severity alone drops a tempered OFFER_CLARITY_UNCLEAR
 * below six routine mediums and opens the email on a missing viewport tag.
 *
 * It is a bridge, and it is removed once the model path is the only path —
 * which is the same phase that supplies the weights replacing this table.
 */
export function normalizeLegacyIssues(raw: RawObservedIssue[] | undefined): NormalizedIssue[] {
  return arr(raw)
    .map(normalizeLegacyIssue)
    .filter((issue): issue is NormalizedIssue => issue !== null)
    .sort((left, right) => right.commercialWeight - left.commercialWeight);
}

function normalizeLegacyIssue(raw: RawObservedIssue | undefined): NormalizedIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.id);
  if (!id) return null;

  // Unchanged from the pre-findings dashboard, down to the fallback severity:
  // this path is live today and an issue that lands in a different severity
  // bucket lands in a different place in the four the email may draw on.
  const severity = isSeverity(raw.severity) ? raw.severity : "informational";
  const evidence = arr(raw.evidence).filter(isNonEmptyString);
  // The audit guarantees evidence on every issue; if it is missing, the finding
  // is not usable as outreach material and we drop it rather than guess.
  if (evidence.length === 0) return null;

  return {
    id,
    // The crawler only ever looked at the landing page, so nothing it reports
    // can be about anything else.
    stage: "landing",
    claimType: "presence",
    severity,
    category: str(raw.category) ?? "other",
    title: str(raw.title) ?? id,
    description: str(raw.description) ?? "",
    evidence: evidence.map((text) => ({ text, page: "landing" as const })),
    citations: [],
    recommendation: str(raw.recommendation) ?? "",
    impact: str(raw.impact),
    confidence: num(raw.confidence),
    commercialWeight: Math.max(0, (COMMERCIAL_WEIGHT[id] ?? 30) + SEVERITY_BONUS[severity]),
  };
}

/* ----------------------- crawler verdicts, re-sourced --------------------- */

/**
 * Urgency evidence quality, preferring the crawler's own verdict and falling
 * back to the three inputs it was computed from.
 *
 * `evidence_quality` is a judgement the API will stop emitting. The inputs it
 * was made from survive, and they carry the distinction that matters: a
 * visitor can check a clock that is actually running, a date with a number in
 * it, or a counted quantity — and cannot check "hurry, ends soon".
 *
 * The reconstruction is by SHAPE, not by re-running the crawler's regexes: a
 * deadline is dated when its `date_text` contains a digit, which separates
 * "March 3" and "12/04" from "Friday" and "tonight" without this file owning a
 * list of month names. Where the crawler's line is finer than shape can draw,
 * the fallback is the looser of the two, and that is stated rather than hidden.
 */
function urgencyQuality(urgency: RawAnalysis["urgency"]): string | null {
  if (!urgency || typeof urgency !== "object") return null;

  const stated = str(urgency.evidence_quality);
  if (stated) return stated;

  const timers = arr(urgency.countdown_timers).filter((timer) => timer?.visible === true);
  const deadlines = arr(urgency.deadlines);
  const scarcity = arr(urgency.scarcity_claims);

  const datedDeadline = deadlines.some((deadline) => /\d/.test(str(deadline?.date_text) ?? ""));
  const countedScarcity = scarcity.some(
    (claim) => str(claim?.kind) !== "limited_time" && /\d/.test(str(claim?.text) ?? ""),
  );

  if (timers.length > 0 || datedDeadline || countedScarcity) return "explicit";
  if (deadlines.length > 0 || scarcity.length > 0) return "language_only";
  return "none";
}

/**
 * Tracking statements, preferring the crawler's own and falling back to the
 * vendor list, which survives it.
 *
 * The statements are prose the crawler writes about the rendered page. When
 * they go, the vendor list is still there and still says the same thing, so
 * the evidence set the email is validated against does not quietly shrink by
 * two lines. Nothing here claims an absence the scripts collector cannot
 * support — "no vendor was identified" is about what was read, not about the
 * page.
 */
function trackingStatements(tracking: RawAnalysis["tracking"], vendors: string[]): string[] {
  if (Array.isArray(tracking?.statements)) return tracking.statements.filter(isNonEmptyString);
  if (!tracking || typeof tracking !== "object") return [];

  const lines: string[] = [];
  lines.push(
    vendors.length > 0
      ? `Tracking scripts on the rendered page: ${vendors.join(", ")}.`
      : "No tracking vendor was identified among the scripts that were read.",
  );
  if (tracking.has_analytics === true) lines.push("An analytics tag is present on the rendered page.");
  if (tracking.has_advertising_pixel === true) lines.push("An advertising pixel is present on the rendered page.");
  if (tracking.has_tag_manager === true) lines.push("A tag manager is present on the rendered page.");
  return lines;
}

/* ------------------------------- helpers -------------------------------- */

/**
 * An unrecognised severity becomes "low", not "informational". "Informational"
 * asserts that a finding does not matter, which is a stronger claim than a
 * missing field supports; "low" is the least committal severity that still
 * says something was observed.
 */
function severityOf(value: unknown): IssueSeverity {
  return isSeverity(value) ? value : "low";
}

function isSeverity(value: unknown): value is IssueSeverity {
  return typeof value === "string" && (SEVERITY_ORDER as string[]).includes(value);
}

function isStage(value: unknown): value is IssueStage {
  return typeof value === "string" && (STAGES as string[]).includes(value);
}

function isClaimType(value: unknown): value is ClaimType {
  return typeof value === "string" && (CLAIM_TYPES as string[]).includes(value);
}

function isEvidencePage(value: unknown): value is EvidencePage {
  return typeof value === "string" && (EVIDENCE_PAGES as string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function str(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function arr<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/** A determination only yields a value when the API actually detected one. */
function determined(value: Determination<string> | undefined): string | null {
  if (!value || value.status !== "detected") return null;
  return isNonEmptyString(value.value) ? value.value : null;
}

function confidenceOf(value: Determination<string> | undefined): number | null {
  return value && value.status === "detected" ? num(value.confidence) : null;
}

function valuePropClarity(value: RawAnalysis["hero"] extends undefined ? never : Determination<{ clarity?: string; statement?: string | null }> | undefined): string | null {
  if (!value || value.status !== "detected") return null;
  return str(value.value?.clarity);
}

function valuePropStatement(value: Determination<{ clarity?: string; statement?: string | null }> | undefined): string | null {
  if (!value || value.status !== "detected") return null;
  return str(value.value?.statement);
}

function offerClarity(value: Determination<{ clarity?: string; missing?: string[] }> | undefined): string | null {
  if (!value || value.status !== "detected") return null;
  return str(value.value?.clarity);
}

function offerMissing(value: Determination<{ clarity?: string; missing?: string[] }> | undefined): string[] {
  if (!value || value.status !== "detected") return [];
  return arr(value.value?.missing).filter(isNonEmptyString);
}
