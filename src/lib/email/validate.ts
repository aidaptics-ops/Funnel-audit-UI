import type { EmailContext } from "./context";
import {
  CURRENT_STATE_CLAIM,
  HEDGE,
  PROJECTED_RESULT,
  PROJECTION_WINDOW,
  MAX_VERBATIM_RUN,
  claimsConversionAction,
  findLongestReuse,
  isBoilerplate,
  stripBoilerplate,
} from "./voice";

/**
 * The programmatic half of the anti-hallucination guarantee.
 *
 * The prompt asks the model to behave; this checks whether it did. Prompts are
 * persuasion, and persuasion fails occasionally — so every generated email is
 * inspected against the evidence set before a human ever sees it.
 */

export interface GeneratedEmail {
  subject: string;
  email: string;
  angle: string;
  personalization_points: string[];
}

export type ViolationKind =
  | "invented_metric"
  | "unhedged_estimate"
  | "post_booking_claim"
  | "unobserved_business_fact"
  | "audit_report_tone"
  | "placeholder"
  | "copied_from_sample"
  | "unverified_action_claim"
  | "unverified_recipient_name"
  | "speculative_diagnosis";

export interface Violation {
  kind: ViolationKind;
  /** The sentence that triggered it, so a human can judge quickly. */
  quote: string;
  explanation: string;
  /** Hard violations force a corrective regeneration. */
  severity: "hard" | "soft";
}

export interface ValidationResult {
  violations: Violation[];
  hardViolations: Violation[];
}

/** Parses whatever the model returned into our shape, or returns null. */
export function parseGeneratedEmail(value: unknown): GeneratedEmail | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const subject = text(record.subject);
  const email = text(record.email) ?? text(record.body);
  if (!subject || !email) return null;

  return {
    subject,
    email,
    angle: text(record.angle) ?? "",
    personalization_points: Array.isArray(record.personalization_points)
      ? record.personalization_points.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [],
  };
}

/* ------------------------------- detectors -------------------------------- */

/** Numbers that imply performance data the audit cannot possibly know. */
const METRIC_PATTERNS: [RegExp, string][] = [
  [/\b\d{1,3}(?:\.\d+)?\s?%/g, "a percentage"],
  [/[$£€]\s?\d[\d,.]*\s?(?:k|m|million|thousand)?\b/gi, "a currency amount"],
  [/\b\d[\d,.]*\s?(?:k|m)\s+(?:visitors?|leads?|clicks?|sales?|users?)\b/gi, "a traffic or lead volume"],
  [/\b\d+\s?x\b/gi, "a multiplier"],
  [/\b(?:thousands|millions|hundreds)\s+of\s+(?:dollars|pounds|euros|leads|visitors|customers)\b/gi, "an implied volume"],
];

/**
 * Language describing the confirmation/thank-you/post-booking PAGE ITSELF —
 * what's on it, how it looks, what's missing from it.
 *
 * This is the half of the old combined rule that CAN stand down, and only
 * when this run genuinely read that page (see `pageStandsDown` below). Kept
 * narrow to phrases that name the page/screen explicitly — "confirmation
 * page", "thank-you page" — so it never accidentally exempts a claim about a
 * message that arrives after the page, which is `UNOBSERVED_STAGE_TOPIC`'s
 * job and never stands down.
 */
const OBSERVED_PAGE_TOPIC =
  /\b(confirmation pages?|thank[- ]?you pages?|post[- ]booking pages?|booking confirmation pages?|the (?:confirmation|booking|thank[- ]?you) screen)\b/i;

/**
 * Language about what happens AFTER the page — a confirmation EMAIL, a
 * follow-up sequence, a calendar invite, a reminder email, the call or
 * meeting itself, onboarding, a CRM entry, an SMS.
 *
 * This NEVER stands down, no matter how much of the post-booking page was
 * observed: reading a page does not mean anyone read the emails, texts or
 * calls that follow it. The negative lookaheads on `post[- ]booking` and
 * `booking confirmation` exist so "post-booking page" / "booking confirmation
 * page" are judged only by `OBSERVED_PAGE_TOPIC` above, not double-counted
 * here as well.
 */
const UNOBSERVED_STAGE_TOPIC =
  /\b(after (?:they|you|someone|people)\s+(?:book|submit|sign up|opt in|register)|post[- ]booking(?!\s+pages?)|once (?:they|someone)\s+books?|confirmation emails?|follow[- ]?up (?:email|sequence)s?|nurture sequences?|calendar invites?|booking confirmation(?!\s+pages?)|after the form|reminder emails?|onboarding (?:sequence|email|process|flow)|entered into (?:the |your )?CRM|\bCRM\b|\bSMS\b|during the call\b|the call itself\b|the meeting itself\b|once (?:they'?re|you'?re) on the call\b)\b/i;

/** Wording that turns the topic into an assertion of a defect. */
const DEFECT_ASSERTION =
  /\b(is|are|isn'?t|aren'?t|was|were|no|nothing|missing|broken|fails?|failing|doesn'?t|don'?t|never|lacks?|there'?s no|you have no|leaves?)\b/i;

/**
 * Naming an opportunity at a later stage, rather than describing that stage.
 *
 * The audit stops at the landing page, so nothing may DESCRIBE a confirmation
 * page — but the client's real emails do raise those stages, and the
 * difference is what the sentence claims. "A missed opportunity on your call
 * confirmation page to pre-handle objections" says a technique is available
 * and unused; "your confirmation page is a bare calendar embed" says what the
 * page contains. The first is a recommendation anyone could make from the
 * funnel's shape. The second is a fact nobody here has.
 *
 * Deliberately NOT included: "the lack of", "there is no", "missing". Those
 * assert the contents of something unseen, which is the thing this rule
 * exists to stop, however confidently it is phrased.
 *
 * Also deliberately not included: "to pre-handle", "to pre-sell". Those are
 * the TOPIC, not the frame — they appear just as readily in "your confirmation
 * page does nothing to pre-handle objections", which is a description of a
 * page nobody loaded. An earlier version of this list contained them and let
 * that exact sentence through; the modals are likewise narrowed to action
 * verbs, so "you could add an FAQ there" passes and "you could be losing
 * people there" does not.
 */
const OPPORTUNITY_FRAME =
  /\b(?:missed opportunity|an opportunity|opportunity to|room to|worth (?:adding|sending|doing|building|recording)|(?:you |i )?(?:could|can|should|would)\s+(?:easily\s+)?(?:add|send|use|record|build|set up|include|put|show|drop|swap|reframe|repurpose))\b/i;

/** Business facts the audit has no access to. */
const BUSINESS_FACT =
  /\b(your (?:ad spend|budget|traffic|conversion rate|revenue|close rate|show[- ]?up rate|no[- ]?show rate|customer count|clients? list)|you'?re spending|you'?re getting \d|your team of)\b/i;

/**
 * Naming a metric is not the same as claiming to know its value.
 *
 * The client opens nearly every email by naming the number at risk — "something
 * pretty critical that is wrecking your show up rate", "could be spiking up
 * your cost per call and burning your ad spend". He asserts no figure; he says
 * which dial the problem moves. Flagging that rejected his own standing
 * opener, which is how this was found.
 *
 * So the exemption is scoped to the governing verb immediately before the
 * metric. "burning your ad spend" is an outcome; "given your traffic of 50k"
 * and "with your traffic that adds up fast" still assert a quantity, and are
 * still caught.
 */
const METRIC_AS_OUTCOME =
  /\b(?:wreck|hurt|kill|spike|spiking|drop|driv\w*\sdown|increase|improv\w*|boost|lift|tank|drain|burn|raise|lower|damag\w*|stunt|crush|cut|decreas\w*|affect|impact|save|protect|double|halve|fix|slash|erod\w*|shrink|grow|limit|cap|throttle|choke|suppress|depress|squeez\w*|hamper)(?:s|ed|ing)?\s+(?:\w+\s+){0,2}$/i;

/** How far back to look for that verb. Long enough for "spiking up your". */
const OUTCOME_WINDOW = 40;

const AUDIT_TONE =
  /\b(i (?:ran|performed|conducted) an? (?:audit|analysis|scan)|found \d+ (?:issues?|problems?|errors?)|here (?:are|is) the \d+|my (?:audit|report) (?:found|shows))\b/i;

/**
 * Wording that shows the sender guessing at the prospect's funnel.
 *
 * The client's whole positioning is that he looked and he knows. "You might
 * have an issue with..." reads as someone who did not look, which is worse
 * than saying less: it invites the reader to dismiss the whole email.
 *
 * The right response to uncertainty is to drop the claim, not to soften it —
 * so this is a hard violation and the corrective pass is told to remove the
 * sentence rather than rephrase it.
 *
 * This is NOT the hedging that makes a number acceptable. "I've seen this lift
 * show up rates by 5-10%" hedges a FIGURE, which is required, and is matched
 * by HEDGE in voice.ts instead. What is banned here is hedging the DIAGNOSIS.
 *
 * Note the deliberate absence of a bare "my guess is". Sample 12 contains "My
 * guess is you hear Sonny complain about people showing up with no trust" —
 * a guess about the reader's own experience, offered after the diagnosis has
 * already been stated flatly. Only "my guess is that <their funnel>" is
 * caught, which is the construction that hedges a finding.
 */
const SPECULATIVE_DIAGNOSIS =
  /\b(?:you might (?:have|be|not)|you may (?:have|be|not)|i suspect|i'?m guessing|i(?:'|’)?d guess|my guess is that|it could be that|it might be that|it may be that|chances are|odds are|presumably|i imagine (?:you|your)|perhaps you|maybe you|i'?d bet|my hunch|it wouldn'?t surprise me|if i had to guess|i(?:'|’)?m assuming)\b/i;

/**
 * Any short bracketed token, not just the obvious ones.
 *
 * The original list named [name], [company] and friends. A live Opus 5 draft
 * shipped "Doors Close [DATE] at [TIME]" straight past it — the placeholder
 * was real, it just was not on the list. Enumerating placeholder words is a
 * losing game, so this matches the SHAPE instead.
 */
const PLACEHOLDER = /\[[A-Za-z][A-Za-z0-9 ._/-]{1,24}\]|\{\{[^}]+\}\}/;

export function validateGeneratedEmail(email: GeneratedEmail, context: EmailContext): ValidationResult {
  const violations: Violation[] = [];
  const haystack = `${email.subject}\n${email.email}`;
  const evidenceBlob = context.evidence.join(" \n ").toLowerCase();

  // 1. Numbers.
  //
  // The client's own emails DO use numbers — but as hedged estimates ("I
  // believe your form is sitting below a 15% start rate") or as lifts drawn
  // from his own experience ("I've seen this increase show up rates by
  // 5-10%"). What he never does is state the prospect's current performance as
  // measured fact. That is the line enforced here:
  //   hedged estimate            -> allowed, flagged softly for review
  //   unhedged current-state claim -> hard violation
  //   number already in evidence -> allowed outright
  //   his own credentials ($750) -> allowed, it is boilerplate about himself
  for (const [pattern, label] of METRIC_PATTERNS) {
    for (const match of haystack.matchAll(pattern)) {
      const value = match[0].trim();
      if (evidenceBlob.includes(value.toLowerCase())) continue;

      const sentence = sentenceAround(haystack, match.index ?? 0);
      if (isBoilerplate(sentence)) continue;

      const hedged = HEDGE.test(sentence);
      const assertsCurrentState = CURRENT_STATE_CLAIM.test(sentence);

      // A figure the fix would REACH, rather than one the prospect is at now.
      // Checked against the words immediately before this number so it cannot
      // launder a present-tense claim elsewhere in the same sentence.
      const index = match.index ?? 0;
      const runUp = haystack.slice(Math.max(0, index - PROJECTION_WINDOW), index);
      const projected = !assertsCurrentState && PROJECTED_RESULT.test(runUp);

      if (assertsCurrentState && !hedged) {
        violations.push({
          kind: "invented_metric",
          quote: sentence,
          explanation: `States ${label} ("${value}") as the prospect's current performance. The audit cannot measure that. Either drop the number or mark it clearly as an estimate.`,
          severity: "hard",
        });
        continue;
      }

      if (!hedged && !projected) {
        violations.push({
          kind: "invented_metric",
          quote: sentence,
          explanation: `Contains ${label} ("${value}") that is not in the observed evidence and is not presented as an estimate.`,
          severity: "hard",
        });
        continue;
      }

      violations.push({
        kind: "unhedged_estimate",
        quote: sentence,
        explanation: projected
          ? `Projects ${label} ("${value}") as the result of the fix. That is the client's own style, but it is a claim about the future — check you stand behind it.`
          : `Uses ${label} ("${value}") as an estimate. That matches the client's style, but the number is not measured — check you are comfortable sending it.`,
        severity: "soft",
      });
    }
  }

  /*
   * 2. Post-conversion assertions.
   *
   * Split in two, because "the page was actually read" and "nobody read the
   * emails/texts/calls after it" are independent facts:
   *
   *   OBSERVED_PAGE_TOPIC   — the confirmation/thank-you/post-booking PAGE
   *                           itself. Stands down once this run genuinely
   *                           read it (see `pageStandsDown` below) — the
   *                           whole point of crawling it.
   *   UNOBSERVED_STAGE_TOPIC — a confirmation EMAIL, a follow-up sequence, a
   *                           calendar invite, a reminder, the call/meeting
   *                           itself, onboarding, a CRM entry, an SMS. NEVER
   *                           stands down: reading the page proves what is on
   *                           the page, not what happens in a message or a
   *                           conversation nobody here attended.
   *
   * `pageStandsDown` turns on `sawItHimself` alone — the pre-existing
   * condition from before the post-booking pipeline ever grew a second, crawl-
   * based way to satisfy it. That second way is gone: the only source of
   * post-booking evidence is the operator's own screenshot, so there is
   * nothing left for a second condition to add.
   *
   * Everything else still applies: invented metrics, business facts he cannot
   * know, and hedged diagnoses are all judged the same way as before — seeing
   * the page proves what is on it, not what the prospect's numbers are.
   */
  const sawItHimself = (context.suppliedPages ?? []).length > 0;
  const pageStandsDown = sawItHimself;

  for (const sentence of sentences(haystack)) {
    const isQuestion = sentence.trim().endsWith("?");
    if (isQuestion) continue;
    if (!DEFECT_ASSERTION.test(sentence)) continue;
    // Raising the stage as an opportunity is allowed and is how the client
    // actually writes; describing what is on it (or in it) is not.
    if (OPPORTUNITY_FRAME.test(sentence)) continue;

    if (UNOBSERVED_STAGE_TOPIC.test(sentence)) {
      violations.push({
        kind: "post_booking_claim",
        quote: sentence.trim(),
        explanation:
          "Describes a confirmation email, a follow-up message, the call itself, or another stage no audit — however much of the page it read — ever attends. Raise it as an opportunity instead of stating what it contains.",
        severity: "hard",
      });
      continue;
    }

    if (!pageStandsDown && OBSERVED_PAGE_TOPIC.test(sentence)) {
      violations.push({
        kind: "post_booking_claim",
        quote: sentence.trim(),
        explanation:
          "Describes what is on a page the audit never reached — it submitted no form and booked nothing. Raise the stage as an opportunity (\"a missed opportunity on your confirmation page to pre-handle objections\") rather than stating what that page currently contains.",
        severity: "hard",
      });
    }
  }

  // 3. Business facts the audit cannot see.
  for (const sentence of sentences(haystack)) {
    const at = sentence.search(BUSINESS_FACT);
    if (at === -1) continue;
    // Naming the dial a fix moves is the client's own opener; claiming to know
    // where that dial currently sits is not.
    const before = sentence.slice(Math.max(0, at - OUTCOME_WINDOW), at);
    if (METRIC_AS_OUTCOME.test(before)) continue;
    violations.push({
      kind: "unobserved_business_fact",
      quote: sentence.trim(),
      explanation:
        "States traffic, spend, revenue or a conversion figure as something known. The audit has none of it. Naming the metric a fix would move is fine; claiming to know its current level is not.",
      severity: "hard",
    });
  }

  // 4. Guessing out loud.
  //
  // Placed after the evidence rules on purpose: a sentence that both speculates
  // AND invents will be reported under both, and the corrective pass needs to
  // hear that the fix is to delete the claim, not to make it sound surer.
  for (const sentence of sentences(haystack)) {
    const speculation = sentence.match(SPECULATIVE_DIAGNOSIS);
    if (!speculation) continue;
    violations.push({
      kind: "speculative_diagnosis",
      quote: sentence.trim(),
      explanation: `Hedges the diagnosis ("${speculation[0]}"). The email has to read as someone who looked, not someone guessing. If the evidence does not support the claim, cut it — do not soften it. Hedging a NUMBER is different and still allowed.`,
      severity: "hard",
    });
  }

  // 5. Reads like an automated audit notification.
  for (const sentence of sentences(haystack)) {
    if (!AUDIT_TONE.test(sentence)) continue;
    violations.push({
      kind: "audit_report_tone",
      quote: sentence.trim(),
      explanation: "Reads like an automated audit report rather than a personal observation.",
      severity: "soft",
    });
  }

  // 6. Unfilled placeholders.
  const placeholder = haystack.match(PLACEHOLDER);
  if (placeholder) {
    violations.push({
      kind: "placeholder",
      quote: sentenceAround(haystack, placeholder.index ?? 0),
      explanation: `Contains an unfilled placeholder ("${placeholder[0]}").`,
      severity: "hard",
    });
  }

  // 7. Verbatim reuse from another prospect's email.
  //    The skeleton is meant to be reused; a lifted observation is not.
  const reuse = findLongestReuse(email.email, context.examples);
  if (reuse.longestRun >= MAX_VERBATIM_RUN) {
    violations.push({
      kind: "copied_from_sample",
      quote: reuse.excerpt ?? "",
      explanation: `Reuses ${reuse.longestRun} consecutive words from a previous email${
        reuse.sampleSubject ? ` ("${reuse.sampleSubject}")` : ""
      }. The observations must be written for THIS funnel, not lifted from another prospect.`,
      severity: "hard",
    });
  }

  // 8. Claiming to have performed the conversion action.
  //    The client really does book the call or buy the book. The audit never
  //    does — it renders one page and submits nothing.
  if (!context.operatorPerformedAction) {
    const claim = claimsConversionAction(stripBoilerplate(haystack));
    if (claim) {
      violations.push({
        kind: "unverified_action_claim",
        quote: claim,
        explanation:
          "Claims to have booked, bought or signed up. The audit never submits a form or completes a purchase, so this is only true if you personally did it. Confirm it on the funnel, or open differently.",
        severity: "hard",
      });
    }
  }

  // 9. A greeting name that was never established.
  //
  // The samples all open "Hey Shayne," / "Hello Tim," so the model is under
  // heavy pressure to produce a name. Getting it wrong is the single most
  // damaging failure in the whole product: it proves the email was automated.
  // A name may only appear if identity resolution actually found it.
  const greetingName = greetingNameIn(email.email);
  if (greetingName) {
    const allowed = allowedNames(context);
    if (!allowed.has(greetingName.toLowerCase())) {
      violations.push({
        kind: "unverified_recipient_name",
        quote: firstLine(email.email),
        explanation: `Addresses the recipient as "${greetingName}", which identity resolution never established. Confirm the owner's name, or open without one.`,
        severity: "hard",
      });
    } else if (!context.identity?.safeToAddressByName) {
      violations.push({
        kind: "unverified_recipient_name",
        quote: firstLine(email.email),
        explanation: `Uses the name "${greetingName}", which is only a low-confidence guess. Confirm it before sending.`,
        severity: "soft",
      });
    }
  }

  return { violations, hardViolations: violations.filter((violation) => violation.severity === "hard") };
}

/** Every name the email is permitted to use. */
function allowedNames(context: EmailContext): Set<string> {
  const names = new Set<string>();
  const identity = context.identity;
  if (!identity) return names;

  const add = (value: string | null | undefined): void => {
    if (!value) return;
    names.add(value.toLowerCase());
    for (const token of value.split(/\s+/)) if (token.length > 1) names.add(token.toLowerCase());
  };

  // Only the resolved owner. Other candidates were rejected for a reason.
  add(identity.owner?.fullName);
  return names;
}

/**
 * The name in "Hey Shayne," / "Hi Dana -" / "Hello Tim" / "Brian,".
 *
 * The bare form matters more than it looks. The client's recent emails drop
 * the greeting word entirely and open on the name alone — and because this
 * function only understood "Hey <Name>", it returned null for every one of
 * them, which silently switched OFF the unverified-name check for the format
 * the generator is now being told to imitate. Addressing a stranger by the
 * wrong name is the single most damaging thing this product can do, so the
 * guard has to cover the shape the emails actually use.
 */
export function greetingNameIn(body: string): string | null {
  const first = firstLine(body);
  const match =
    first.match(/^\s*(?:hey|hi|hello|good morning|good afternoon)\s+([A-Z][A-Za-z'’-]{1,30})\b/i) ??
    // "Brian," on a line of its own. One capitalised word, a comma, nothing else.
    first.match(/^\s*([A-Z][A-Za-z'’-]{1,30})\s*[,–—-]\s*$/);
  const name = match?.[1];
  if (!name) return null;
  // "Hey there" / "Hi team" are not names, and neither is a bare "Hey,".
  if (/^(there|team|folks|all|guys|everyone|friend|hey|hi|hello|thanks|cheers|best)$/i.test(name)) return null;
  return name;
}

function firstLine(body: string): string {
  return (body.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim();
}

/** Turned into a corrective instruction for a second attempt. */
export function correctionInstruction(violations: Violation[]): string {
  const lines = violations.map(
    (violation) => `- ${violation.explanation}\n  You wrote: "${truncate(violation.quote, 160)}"`,
  );
  return [
    "Your previous attempt broke the rules:",
    ...lines,
    "",
    "Rewrite the email. Remove every unsupported claim rather than rephrasing it. If that leaves you with less to say, say less — a shorter, wholly accurate email is the correct outcome.",
    "Return only the JSON object.",
  ].join("\n");
}

/* -------------------------------- helpers -------------------------------- */

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim() !== "");
}

function sentenceAround(text: string, index: number): string {
  const before = text.lastIndexOf(".", index);
  const after = text.indexOf(".", index);
  const start = before === -1 ? Math.max(0, index - 80) : before + 1;
  const end = after === -1 ? Math.min(text.length, index + 80) : after + 1;
  return text.slice(start, end).trim();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
