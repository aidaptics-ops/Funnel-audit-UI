import { evidenceText, type NormalizedAudit, type NormalizedIssue } from "../audit/normalize";
import type { RawScreenshot } from "../audit/types";
import { renderRelationship, type RelationshipBlock } from "../analysis/evidence";
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

/**
 * Below this, a finding is SEO housekeeping, not a commercial defect worth a
 * cold email — a broken canonical tag, a missing meta description, a console
 * warning. It replaces a table of hardcoded finding ids (`MISSING_CANONICAL`,
 * `IMAGES_MISSING_ALT`, ...) that only ever matched the crawler's own fixed
 * vocabulary; a finding from the analysis model has no id from that
 * vocabulary to match, so the table quietly stopped filtering anything the
 * moment model findings arrived. `commercialWeight` is the value both paths
 * actually agree on — it is on every `NormalizedIssue` regardless of which
 * path produced it — so it is what the cut lives on now.
 *
 * Picked to land exactly where the old table drew its own line: 5 and 10 (the
 * housekeeping ids) fall below it, 20 (the lowest weight NOT on that list)
 * clears it.
 */
const MIN_COMMERCIAL_WEIGHT = 15;

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
   * The audit used to stop at the landing page, so the stages after it were
   * where most of the client's best material lived — pre-call consumption,
   * what the confirmation step is used for, whether the answers a form
   * collects are reused. Some of those can now be OBSERVED (see
   * `postBookingFindings`); the ones that still cannot are supplied here as
   * pre-anchored angles rather than left to the model, so the confident tone
   * the client wants rests on a real signal instead of on the model's
   * willingness to sound sure.
   */
  downstream: DownstreamAngle[];
  /**
   * True only when a human confirms they really performed the funnel's
   * conversion action (booked the call, bought the book). Neither the audit
   * nor a crawled post-booking page ever does that — both reach that page by
   * navigating straight to its address — so this gates the client's usual
   * opening line on a human's word alone.
   */
  operatorPerformedAction: boolean;
  /** Who the funnel belongs to, and whether we are sure enough to say so. */
  identity: IdentityResult | null;
  /**
   * What the landing page actually looks like, top to bottom.
   *
   * Everything else in this object is a reading of the markup, and the markup
   * is wrong about the things that matter most often: a button whose click is
   * handled in JavaScript has no href and reads as "leads nowhere", proof
   * baked into an image counts as zero testimonials. The pictures are what let
   * the model disagree with its own evidence list.
   */
  landingImages: LlmImage[];
  /**
   * Pages the operator photographed himself by actually going through the
   * funnel.
   *
   * Their presence changes what the email is ALLOWED to say about them: they
   * are first-hand evidence of a real conversion, which a crawled
   * post-booking screenshot — reached by typing an address — is not.
   */
  suppliedImages: LlmImage[];
  /** Findings about the page after the conversion step, with verified citations. */
  postBookingFindings: NormalizedIssue[];
  /** The model's own account of how the two pages relate, when it ran. */
  relationshipSummary: string | null;
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
  /** The rendered landing page. */
  screenshot?: RawScreenshot | null;
  /** Operator-supplied screenshots of stages the audit cannot reach. */
  supplied?: { label: string; mediaType: string; data: string }[];
  /** The model's summary of how the two pages relate, when the analysis ran. */
  relationshipSummary?: string | null;
  /** The mechanical comparison of the two pages, when the analysis ran. */
  relationship?: RelationshipBlock | null;
}): EmailContext {
  const { audit, profile, examples } = input;
  const relationshipSummary = input.relationshipSummary ?? null;
  const relationship = input.relationship ?? null;

  // Any post-booking-tagged fact in `audit.issues` already survived
  // `verify.ts`, which only keeps one when a screenshot genuinely existed at
  // analysis time — there is no crawled page whose fidelity could later be
  // downgraded, so nothing here needs to re-check that trust.
  const citesPostBooking = (issue: NormalizedIssue): boolean =>
    issue.evidence.some((line) => line.page === "post_booking");

  const observations = audit.issues
    .filter((issue) => issue.severity !== "informational")
    .filter((issue) => issue.commercialWeight >= MIN_COMMERCIAL_WEIGHT)
    .slice(0, MAX_OBSERVATIONS);

  return {
    audit,
    profile,
    examples,
    observations,
    evidence: collectEvidence(audit, observations, relationship),
    unobserved: audit.observability.notes,
    downstream: downstreamAngles(audit),
    // Neither the audit nor the mere existence of a run can earn the client's
    // usual opening line — only a human's word, or a photograph he took
    // himself, can.
    operatorPerformedAction: input.operatorPerformedAction === true || (input.supplied ?? []).length > 0,
    identity: input.identity ?? null,
    landingImages: toImages(input.screenshot),
    suppliedImages: toSupplied(input.supplied ?? []),
    postBookingFindings: audit.issues.filter(citesPostBooking),
    relationshipSummary,
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
 * The landing page's strips, captioned with where on the page each one is.
 *
 * The fold marker matters: "no CTA above the fold" is a real finding and the
 * model can only check it if it knows which pixels a visitor sees first.
 */
function toImages(screenshot: RawScreenshot | null | undefined): LlmImage[] {
  const strips = (screenshot?.strips ?? []).filter((strip) => strip?.data);
  if (strips.length === 0) return [];

  const shown = strips.slice(0, MAX_STRIPS);
  const continues = screenshot?.truncated || strips.length > shown.length;

  return shown.map((strip, index) => ({
    data: strip.data,
    mediaType: strip.media_type || "image/jpeg",
    caption:
      `SCREENSHOT ${index + 1} of ${shown.length} — the rendered page from ${strip.offset_y}px ` +
      `to ${strip.offset_y + strip.height}px down` +
      (index === 0 ? " (a visitor sees roughly the first 900px before scrolling)" : "") +
      (index === shown.length - 1 && continues ? ". The page continues below this point." : "."),
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
 * established by reading the page; "your confirmation page is bare" is not —
 * UNLESS the confirmation page really was read, which is what
 * `postBooking.status === "observed"` means, and is exactly the one case
 * carved out below.
 *
 * These are angles, not findings. The prompt says so, and the email still has
 * to earn its place with an observation from the page itself.
 */
export function downstreamAngles(audit: NormalizedAudit): DownstreamAngle[] {
  const angles: DownstreamAngle[] = [];
  const goal = `${audit.conversionGoal ?? ""} ${audit.funnelType ?? ""} ${audit.pageType ?? ""} ${audit.primaryCta ?? ""}`;

  // Every other angle in this function is about a stage that is STILL unseen
  // regardless of what happened to the confirmation step (emails, sequences,
  // the call itself, calendar invites, the wait before an event). Only the
  // one angle below whose entire premise is "a confirmation step exists but
  // we cannot see it" stops being true once the operator has actually
  // supplied a screenshot of it — asserting it anyway would be a lie of
  // omission, not a safe generalisation.
  const confirmationStepUnseen = !audit.observability.postBookingObserved;

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
    if (confirmationStepUnseen) {
      angles.push({
        angle:
          "the confirmation step after a booking is an unused slot for pre-handling objections and transferring trust to whoever runs the call",
        anchor: audit.observability.bookingStepVisible
          ? "a scheduler is visibly present on the page, so a confirmation step exists by construction"
          : `the conversion goal is "${audit.conversionGoal ?? "booking a call"}", so a confirmation step exists by construction`,
      });
    }
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

/** Which page (or relation between pages) one evidence line describes. */
type EvidenceTag = "landing" | "post-booking" | "relationship";

/**
 * The permitted-claims set. If a statement cannot be traced to one of these
 * lines, the email should not be making it.
 *
 * Every line is prefixed with which page it describes. That tag is what lets
 * a human — and, indirectly, `validate.ts`'s post-booking guardrail — tell a
 * fact about the landing page from a fact about the page after it, which used
 * to be a single undifferentiated list.
 */
function collectEvidence(
  audit: NormalizedAudit,
  observations: NormalizedIssue[],
  relationship: RelationshipBlock | null,
): string[] {
  const evidence: string[] = [];
  const push = (tag: EvidenceTag, value: string | null | undefined | false): void => {
    if (value && value.trim()) evidence.push(`[${tag}] ${value.trim()}`);
  };

  // Everything below is read straight off `audit`'s own fields, which are the
  // crawler's and the model's account of the LANDING page.
  push("landing", audit.pageTitle && `page title: ${audit.pageTitle}`);
  push("landing", audit.headline && `headline: ${audit.headline}`);
  push("landing", audit.subheadline && `subheadline: ${audit.subheadline}`);
  push("landing", audit.brand && `brand: ${audit.brand}`);
  push("landing", audit.funnelType && `funnel type: ${audit.funnelType}`);
  push("landing", audit.conversionGoal && `conversion goal: ${audit.conversionGoal}`);
  push("landing", audit.primaryCta && `primary CTA: ${audit.primaryCta}`);
  push("landing", `${audit.ctaCount} CTA(s), ${audit.ctaAboveFoldCount} above the fold`);
  push("landing", `${audit.forms.length} form(s) detected`);

  for (const form of audit.forms) {
    push(
      "landing",
      `form: ${form.provider}/${form.integration}, ${form.fieldCount} fields${form.aboveFold ? ", above the fold" : ""}`,
    );
  }

  push("landing", `social proof: ${audit.proof.testimonials} testimonials, ${audit.proof.logos} logos, ${audit.proof.ratings} ratings`);
  push("landing", `pricing detected: ${audit.pricingDetected}`);
  push("landing", `guarantee present: ${audit.guaranteePresent}`);
  push("landing", `urgency detected: ${audit.urgencyDetected}${audit.urgencyQuality ? ` (${audit.urgencyQuality})` : ""}`);
  push("landing", `analytics detected: ${audit.tracking.hasAnalytics}; ad pixel detected: ${audit.tracking.hasAdPixel}`);
  push("landing", audit.tracking.vendors.length ? `tracking vendors: ${audit.tracking.vendors.join(", ")}` : null);
  push("landing", `navigation items: ${audit.navItemCount}`);
  push("landing", `${audit.videoCount} video(s); VSL: ${audit.isVsl}`);
  push("landing", audit.offer.product && `offer product: ${audit.offer.product}`);
  push("landing", audit.offer.audience && `offer audience: ${audit.offer.audience}`);
  push("landing", audit.offer.clarity && `offer clarity: ${audit.offer.clarity}`);

  for (const copy of audit.supportingCopy) push("landing", `page copy: ${copy}`);
  for (const message of audit.keyMessages) push("landing", `key message: ${message}`);
  for (const testimonial of audit.testimonials) push("landing", `testimonial on page: ${testimonial.text}`);
  for (const link of audit.brokenLinks) push("landing", `broken link: ${link}`);

  /*
   * Findings.
   *
   * A finding that carries verified citations (every finding the analysis
   * model produces, once `verify.ts` is done with it) contributes lines built
   * ONLY from those citations — the quote, exactly as verified, plus the field
   * path it was checked against. Never the finding's `title`, `description` or
   * `impact`: those are the model's own free prose, unverified, and
   * `validate.ts`'s METRIC_AS_OUTCOME rule trusts any number that "literally
   * appears" in this list. Putting a model-authored sentence in here would let
   * a model-authored number license itself.
   *
   * A finding with no citations at all is the legacy, pre-analysis path
   * (`normalizeLegacyIssues` in `audit/normalize.ts`) — crawler-authored text
   * with nothing to zip a field path against. That is kept working exactly as
   * it always has.
   */
  for (const issue of observations) {
    if (issue.citations.length > 0) {
      issue.evidence.forEach((line, index) => {
        const field = issue.citations[index];
        if (!field) return;
        const tag: EvidenceTag = line.page === "post_booking" ? "post-booking" : "landing";
        push(tag, `"${evidenceText(line)}" (${field})`);
      });
    } else {
      push("landing", `finding ${issue.id}: ${issue.title}`);
      for (const line of issue.evidence) push("landing", evidenceText(line));
      push("landing", issue.impact && `impact of ${issue.id}: ${issue.impact}`);
    }
  }

  /*
   * There is no structured capture of the page after conversion — only ever
   * an operator's own photograph — so there is nothing mechanical here to add
   * about its contents. `postBookingFindings` (built above, in
   * `buildEmailContext`) carries the model's citations against it instead,
   * and `prompt.ts` puts those in their own dedicated section.
   *
   * The relationship block still has something to say, even with no
   * post-booking page to compare against: `landing_registrable_domain` and
   * `landing_tracking_ids` are facts about the landing page alone, and the
   * comparison fields simply come back null — an honest "nothing to compare",
   * not a faked answer.
   *
   * `relationshipSummary` is deliberately NOT pushed here. It is the analysis
   * model's own free two-to-three-sentence prose (requested as open-ended
   * narrative, never citation-checked by `verify.ts`), and this array is the
   * exact set `validate.ts`'s METRIC_PATTERNS check trusts any number to
   * "license itself" against merely by appearing in it — the same invariant
   * this file documents above for a finding's title/description/impact.
   * Putting a model-authored sentence here would reopen that hole. It still
   * reaches the model, just narratively: `prompt.ts` prints
   * `context.relationshipSummary` directly in its own "How the two pages
   * relate" line, which is fine — the bug was only ever its presence in the
   * machine-checked evidence set.
   */
  if (relationship) {
    for (const line of relationshipLines(relationship)) push("relationship", line);
  }

  return [...new Set(evidence)];
}

/** `renderRelationship`'s lines, with the uninformative ones dropped. */
function relationshipLines(block: RelationshipBlock): string[] {
  return renderRelationship(block)
    .split("\n")
    .filter((line) => {
      const value = line.slice(line.indexOf(": ") + 2);
      return value !== "" && value !== "null" && value !== "(none)";
    });
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
