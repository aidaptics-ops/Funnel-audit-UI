import type { NormalizedAudit, NormalizedIssue } from "../audit/normalize";
import type { ClientEmail, ClientProfile } from "../client-knowledge/types";
import type { IdentityResult } from "../identity/types";

/**
 * Assembles everything the model is allowed to know, and — just as importantly
 * — states plainly what was never observed.
 *
 * The rule the whole system turns on:
 *   historical emails  -> how this client sounds and what they look for
 *   the new audit      -> what is actually true of THIS funnel
 * The first never becomes evidence for the second.
 */

/** Findings that are real but rarely worth leading a cold email with. */
const LOW_VALUE_FOR_OUTREACH = new Set([
  "MISSING_CANONICAL",
  "BROKEN_HEADING_HIERARCHY",
  "MULTIPLE_H1",
  "IMAGES_MISSING_ALT",
  "MISSING_META_DESCRIPTION",
  "CONSOLE_ERRORS",
  "FAILED_REQUESTS",
]);

/** How many observations the email may draw on. Deliberately small. */
const MAX_OBSERVATIONS = 4;

export interface EmailContext {
  audit: NormalizedAudit;
  profile: ClientProfile | null;
  examples: ClientEmail[];
  /** The shortlist the email should choose 1–2 from. */
  observations: NormalizedIssue[];
  /** Every fact the email is permitted to assert, as flat strings. */
  evidence: string[];
  /** Things explicitly NOT observed. Used by both prompt and validator. */
  unobserved: string[];
  /**
   * True only when a human confirms they really performed the funnel's
   * conversion action (booked the call, bought the book). The audit never
   * does, so this gates the client's usual opening line.
   */
  operatorPerformedAction: boolean;
  /** Who the funnel belongs to, and whether we are sure enough to say so. */
  identity: IdentityResult | null;
}

export function buildEmailContext(input: {
  audit: NormalizedAudit;
  profile: ClientProfile | null;
  examples: ClientEmail[];
  operatorPerformedAction?: boolean;
  identity?: IdentityResult | null;
}): EmailContext {
  const { audit, profile, examples } = input;

  const observations = audit.issues
    .filter((issue) => !LOW_VALUE_FOR_OUTREACH.has(issue.id))
    .filter((issue) => issue.severity !== "informational")
    .slice(0, MAX_OBSERVATIONS);

  return {
    audit,
    profile,
    examples,
    observations,
    evidence: collectEvidence(audit, observations),
    unobserved: audit.observability.notes,
    operatorPerformedAction: input.operatorPerformedAction === true,
    identity: input.identity ?? null,
  };
}

/**
 * The permitted-claims set. If a statement cannot be traced to one of these
 * lines, the email should not be making it.
 */
function collectEvidence(audit: NormalizedAudit, observations: NormalizedIssue[]): string[] {
  const evidence: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (value && value.trim()) evidence.push(value.trim());
  };

  push(audit.pageTitle && `page title: ${audit.pageTitle}`);
  push(audit.headline && `headline: ${audit.headline}`);
  push(audit.subheadline && `subheadline: ${audit.subheadline}`);
  push(audit.brand && `brand: ${audit.brand}`);
  push(audit.funnelType && `funnel type: ${audit.funnelType}`);
  push(audit.conversionGoal && `conversion goal: ${audit.conversionGoal}`);
  push(audit.primaryCta && `primary CTA: ${audit.primaryCta}`);
  push(`${audit.ctaCount} CTA(s), ${audit.ctaAboveFoldCount} above the fold`);
  push(`${audit.forms.length} form(s) detected`);

  for (const form of audit.forms) {
    push(`form: ${form.provider}/${form.integration}, ${form.fieldCount} fields${form.aboveFold ? ", above the fold" : ""}`);
  }

  push(`social proof: ${audit.proof.testimonials} testimonials, ${audit.proof.logos} logos, ${audit.proof.ratings} ratings`);
  push(`pricing detected: ${audit.pricingDetected}`);
  push(`guarantee present: ${audit.guaranteePresent}`);
  push(`urgency detected: ${audit.urgencyDetected}${audit.urgencyQuality ? ` (${audit.urgencyQuality})` : ""}`);
  push(`analytics detected: ${audit.tracking.hasAnalytics}; ad pixel detected: ${audit.tracking.hasAdPixel}`);
  push(audit.tracking.vendors.length ? `tracking vendors: ${audit.tracking.vendors.join(", ")}` : null);
  push(`navigation items: ${audit.navItemCount}`);
  push(`${audit.videoCount} video(s); VSL: ${audit.isVsl}`);
  push(audit.offer.product && `offer product: ${audit.offer.product}`);
  push(audit.offer.audience && `offer audience: ${audit.offer.audience}`);
  push(audit.offer.clarity && `offer clarity: ${audit.offer.clarity}`);

  for (const copy of audit.supportingCopy) push(`page copy: ${copy}`);
  for (const message of audit.keyMessages) push(`key message: ${message}`);
  for (const testimonial of audit.testimonials) push(`testimonial on page: ${testimonial.text}`);
  for (const link of audit.brokenLinks) push(`broken link: ${link}`);

  for (const issue of observations) {
    push(`finding ${issue.id}: ${issue.title}`);
    for (const line of issue.evidence) push(`evidence for ${issue.id}: ${line}`);
    push(issue.impact && `impact of ${issue.id}: ${issue.impact}`);
  }

  return [...new Set(evidence)];
}

/**
 * Picks historical emails to show as style references.
 *
 * The default limit is high on purpose: with a library of 10-15 emails the
 * model should see all of them. The voice and the skeleton are far easier to
 * imitate from the whole set than from a topic-matched handful, and sending a
 * fixed set every time also keeps the prompt prefix stable for caching.
 * Topic-relevance ranking only kicks in once the library outgrows the limit.
 */
export function selectExamples(emails: ClientEmail[], observations: NormalizedIssue[], limit = 12): ClientEmail[] {
  if (emails.length <= limit) return emails;

  const terms = observations
    .flatMap((issue) => [issue.id, issue.title, issue.category])
    .join(" ")
    .toLowerCase()
    .match(/[a-z]{4,}/g);
  const keywords = new Set(terms ?? []);

  const scored = emails.map((email) => {
    const body = email.body.toLowerCase();
    let score = 0;
    for (const keyword of keywords) if (body.includes(keyword)) score += 1;
    return { email, score };
  });

  const relevant = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const chosen = relevant.slice(0, limit).map((entry) => entry.email);

  // Always include a couple of plain samples so tone is not skewed by topic.
  for (const email of emails) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(email)) chosen.push(email);
  }

  return chosen;
}
