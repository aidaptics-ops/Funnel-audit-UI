import type { Determination, IssueSeverity, RawAnalysis, RawObservedIssue } from "./types";

/**
 * Turns a raw audit response into a compact, total shape the UI and the AI
 * context builder can rely on. Every read is defensive: a missing section, a
 * null value or an "unknown" determination must never throw.
 */

export interface NormalizedIssue {
  id: string;
  severity: IssueSeverity;
  category: string;
  title: string;
  description: string;
  evidence: string[];
  recommendation: string;
  impact: string | null;
  confidence: number | null;
  /** Our own ranking of how worth mentioning this is in cold outreach. */
  commercialWeight: number;
}

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
   * The audit renders exactly ONE page. It never submits a form, never books,
   * never follows a scheduler. Anything past the first conversion action is
   * unobserved by construction.
   */
  scope: "single_landing_page";
  postBookingObserved: false;
  formSubmissionObserved: false;
  /** True only when a booking/scheduler step is visibly present on the page. */
  bookingStepVisible: boolean;
  notes: string[];
}

const SEVERITY_ORDER: IssueSeverity[] = ["critical", "high", "medium", "low", "informational"];

/**
 * How much a finding is worth raising in a first cold email.
 * High = a prospect or customer would feel it. Low = housekeeping.
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

export function normalizeAudit(
  raw: RawAnalysis,
  meta: { jobId: string | null; requestedUrl: string },
): NormalizedAudit {
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

  const hasScheduler =
    ctas.some((cta) => cta.destinationKind === "scheduler") ||
    arr(raw.forms).some((form) => /calendly|savvycal|acuity|hubspot|cal\.com/i.test(str(form?.provider) ?? ""));

  const issues = arr(raw.observed_issues)
    .map(normalizeIssue)
    .filter((issue): issue is NormalizedIssue => issue !== null)
    .sort((left, right) => right.commercialWeight - left.commercialWeight);

  const issueCounts = SEVERITY_ORDER.reduce(
    (acc, severity) => {
      acc[severity] = issues.filter((issue) => issue.severity === severity).length;
      return acc;
    },
    {} as Record<IssueSeverity, number>,
  );

  const identity = funnel.business_identity ?? {};

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
    urgencyQuality: str(raw.urgency?.evidence_quality),

    videoCount: num(summary.videos?.dom_count) ?? arr(raw.videos).length,
    isVsl: raw.vsl?.determination?.status === "detected",

    tracking: {
      vendors: arr(raw.tracking?.detected)
        .map((vendor) => str(vendor?.vendor))
        .filter(isNonEmptyString),
      hasAnalytics: bool(raw.tracking?.has_analytics),
      hasAdPixel: bool(raw.tracking?.has_advertising_pixel),
      statements: arr(raw.tracking?.statements).filter(isNonEmptyString),
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

    observability: buildObservability(hasScheduler, forms.length > 0),
  };
}

/**
 * The audit never goes past the landing page. Stating that explicitly — rather
 * than leaving it implied — is what stops the AI inventing what happens after
 * a form is submitted or a call is booked.
 */
function buildObservability(hasScheduler: boolean, hasForm: boolean): Observability {
  const notes = [
    "The audit rendered exactly one page. It did not fill or submit any form.",
    "No confirmation page, thank-you page, email sequence or booking flow was visited.",
    "Nothing about what happens AFTER a visitor converts was observed.",
  ];

  if (hasScheduler) {
    notes.push("A scheduler/booking widget is visibly present on the page, but it was never opened or used.");
  }
  if (hasForm) {
    notes.push("A form is present and its fields were read, but it was never filled in or submitted.");
  }

  return {
    scope: "single_landing_page",
    postBookingObserved: false,
    formSubmissionObserved: false,
    bookingStepVisible: hasScheduler,
    notes,
  };
}

function normalizeIssue(raw: RawObservedIssue | undefined): NormalizedIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.id);
  if (!id) return null;

  const severity = isSeverity(raw.severity) ? raw.severity : "informational";
  const evidence = arr(raw.evidence).filter(isNonEmptyString);
  // The audit guarantees evidence on every issue; if it is missing, the finding
  // is not usable as outreach material and we drop it rather than guess.
  if (evidence.length === 0) return null;

  const base = COMMERCIAL_WEIGHT[id] ?? 30;
  return {
    id,
    severity,
    category: str(raw.category) ?? "other",
    title: str(raw.title) ?? id,
    description: str(raw.description) ?? "",
    evidence,
    recommendation: str(raw.recommendation) ?? "",
    impact: str(raw.impact),
    confidence: num(raw.confidence),
    commercialWeight: Math.max(0, base + SEVERITY_BONUS[severity]),
  };
}

/* ------------------------------- helpers -------------------------------- */

function isSeverity(value: unknown): value is IssueSeverity {
  return typeof value === "string" && (SEVERITY_ORDER as string[]).includes(value);
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
