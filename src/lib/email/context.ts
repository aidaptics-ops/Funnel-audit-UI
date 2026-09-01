import type { NormalizedAudit, NormalizedIssue } from "../audit/normalize";
import type { RawScreenshot } from "../audit/types";
import type { LlmImage } from "../llm/types";
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
   * Later funnel stages worth raising, each tied to something actually seen.
   *
   * The audit stops at the landing page, so the stages after it are where most
   * of the client's best material lives — pre-call consumption, what the
   * confirmation step is used for, whether the answers a form collects are
   * reused. Those cannot be OBSERVED, but the opportunity can be established
   * from the funnel's shape, which is observed.
   *
   * Supplied as pre-anchored angles rather than left to the model, so the
   * confident tone the client wants rests on a real signal instead of on the
   * model's willingness to sound sure.
   */
  downstream: DownstreamAngle[];
  /**
   * True only when a human confirms they really performed the funnel's
   * conversion action (booked the call, bought the book). The audit never
   * does, so this gates the client's usual opening line.
   */
  operatorPerformedAction: boolean;
  /** Who the funnel belongs to, and whether we are sure enough to say so. */
  identity: IdentityResult | null;
  /**
   * What the page actually looks like, top to bottom.
   *
   * Everything else in this object is a reading of the markup, and the markup
   * is wrong about the things that matter most often: a button whose click is
   * handled in JavaScript has no href and reads as "leads nowhere", proof
   * baked into an image counts as zero testimonials. The pictures are what let
   * the model disagree with its own evidence list.
   */
  screenshots: LlmImage[];
  /**
   * Pages the operator photographed himself, and what he called them.
   *
   * Their presence changes what the email is ALLOWED to say. The rule against
   * describing a confirmation page exists because the audit could never reach
   * one; a screenshot of it removes that premise, so the rule stands down for
   * this run rather than blocking the very observation it was asked for.
   */
  suppliedPages: string[];
}

export function buildEmailContext(input: {
  audit: NormalizedAudit;
  profile: ClientProfile | null;
  examples: ClientEmail[];
  operatorPerformedAction?: boolean;
  identity?: IdentityResult | null;
  screenshot?: RawScreenshot | null;
  /** Operator-supplied screenshots of stages the audit cannot reach. */
  supplied?: { label: string; mediaType: string; data: string }[];
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
    downstream: downstreamAngles(audit),
    // A screenshot of the page you only reach BY converting is itself the
    // confirmation that the operator converted, so the opening line the client
    // always uses ("Just booked a call with your team...") is earned.
    operatorPerformedAction: input.operatorPerformedAction === true || (input.supplied ?? []).length > 0,
    identity: input.identity ?? null,
    screenshots: [...toImages(input.screenshot), ...toSupplied(input.supplied ?? [])],
    suppliedPages: (input.supplied ?? []).map((page) => page.label),
  };
}

/**
 * The operator's own screenshots, marked as such.
 *
 * Labelled differently from the rendered strips on purpose: the model has to
 * know these are a stage it could not otherwise see, so it can describe them
 * instead of falling back to the careful opportunity-only phrasing.
 */
function toSupplied(pages: { label: string; mediaType: string; data: string }[]): LlmImage[] {
  return pages.map((page, index) => ({
    data: page.data,
    mediaType: page.mediaType,
    caption:
      `OPERATOR SCREENSHOT ${index + 1} of ${pages.length} — "${page.label}". ` +
      "The operator went through this funnel himself and photographed this page. " +
      "It is a real page he saw, so you may describe what is on it.",
  }));
}

/** How many strips are worth sending. Each is roughly 2,700 input tokens. */
const MAX_STRIPS = 5;

/**
 * The strips, captioned so the model knows where on the page it is looking.
 *
 * The fold marker matters: "no CTA above the fold" is a real finding and the
 * model can only check it if it knows which pixels a visitor sees first.
 */
function toImages(screenshot: RawScreenshot | null | undefined): LlmImage[] {
  const strips = (screenshot?.strips ?? []).filter((strip) => strip?.data);
  if (strips.length === 0) return [];

  const shown = strips.slice(0, MAX_STRIPS);
  return shown.map((strip, index) => ({
    data: strip.data,
    mediaType: strip.media_type || "image/jpeg",
    caption:
      `SCREENSHOT ${index + 1} of ${shown.length} — the rendered page from ${strip.offset_y}px ` +
      `to ${strip.offset_y + strip.height}px down` +
      (index === 0 ? " (a visitor sees roughly the first 900px before scrolling)" : "") +
      (index === shown.length - 1 && (screenshot?.truncated || strips.length > shown.length)
        ? ". The page continues below this point."
        : "."),
  }));
}

export interface DownstreamAngle {
  /** The opportunity, in the terms the client uses. */
  angle: string;
  /** The observed fact that makes it defensible rather than a guess. */
  anchor: string;
}

/** Conversion goals whose funnel necessarily continues past this page. */
const BOOKING_GOAL = /\b(book|booking|call|consult|appointment|demo|strategy session|assessment|discovery|schedule)\b/i;
const PURCHASE_GOAL = /\b(buy|purchase|checkout|order|payment|enroll)\b/i;
const SIGNUP_GOAL = /\b(webinar|workshop|masterclass|training|register|registration|opt.?in|challenge|summit)\b/i;

/**
 * What the funnel's SHAPE licenses us to raise about its later stages.
 *
 * Every angle is paired with the observed signal it rests on, and every one is
 * phrased as an opportunity rather than as a description of a page nobody
 * loaded. That distinction is the whole safety property: "a pre-call asset is
 * not promoted anywhere on this page" is something the audit genuinely
 * established by reading the page; "your confirmation page is bare" is not.
 *
 * These are angles, not findings. The prompt says so, and the email still has
 * to earn its place with an observation from the page itself.
 */
export function downstreamAngles(audit: NormalizedAudit): DownstreamAngle[] {
  const angles: DownstreamAngle[] = [];
  const goal = `${audit.conversionGoal ?? ""} ${audit.funnelType ?? ""} ${audit.pageType ?? ""} ${audit.primaryCta ?? ""}`;

  const booking = audit.observability.bookingStepVisible || BOOKING_GOAL.test(goal);
  if (booking) {
    angles.push({
      // Phrased in his own vocabulary — "pre-call consumption material" is the
      // exact term he uses — so the model has his words to reach for rather
      // than a paraphrase it has to translate back.
      angle:
        "the lack of pre-call consumption material: nothing on this page promotes a podcast, a prep video or a case-study page for someone to consume before the call, and that gap is what shows up as a low show rate and a cold first call",
      anchor: `the whole page was read: ${audit.ctaCount} CTA(s), ${audit.videoCount} video(s), and its full copy, and none of it promotes pre-call material`,
    });
    angles.push({
      angle:
        "the confirmation step after a booking is an unused slot for pre-handling objections and transferring trust to whoever runs the call",
      anchor: audit.observability.bookingStepVisible
        ? "a scheduler is visibly present on the page, so a confirmation step exists by construction"
        : `the conversion goal is "${audit.conversionGoal ?? "booking a call"}", so a confirmation step exists by construction`,
    });
  }

  const form = audit.forms[0];
  if (form && form.fieldCount >= 3) {
    angles.push({
      angle:
        "the answers this form collects are the raw material for personalising every step after it, and almost nobody reuses them",
      anchor: `a ${form.fieldCount}-field ${form.provider} form is on the page and its fields were read`,
    });
  }

  if (PURCHASE_GOAL.test(goal) || audit.pricingDetected) {
    angles.push({
      angle:
        "the moment straight after a purchase is the highest-intent moment in the whole funnel and is usually spent on a receipt",
      anchor: audit.pricingDetected
        ? "pricing is on the page, so a purchase completes somewhere past it"
        : `the conversion goal is "${audit.conversionGoal ?? "a purchase"}"`,
    });
  }

  if (SIGNUP_GOAL.test(goal)) {
    angles.push({
      angle:
        "the gap between registering and the event itself is where attendance is won or lost, and a reminder that only restates the time does none of that work",
      anchor: `the funnel registers people for "${audit.offer.product ?? audit.conversionGoal ?? "an event"}", so there is a wait before it`,
    });
  }

  return angles;
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
