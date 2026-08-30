import type { EmailContext } from "./context";
import {
  CURRENT_STATE_CLAIM,
  HEDGE,
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
  | "unverified_recipient_name";

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

/** Claims about what happens after conversion — never observed by the audit. */
const POST_CONVERSION_TOPIC =
  /\b(after (?:they|you|someone|people)\s+(?:book|submit|sign up|opt in|register)|post[- ]booking|once (?:they|someone)\s+books?|confirmation (?:page|email)|thank[- ]?you page|follow[- ]?up (?:email|sequence)|nurture sequence|calendar invite|booking confirmation|after the form)\b/i;

/** Wording that turns the topic into an assertion of a defect. */
const DEFECT_ASSERTION =
  /\b(is|are|isn'?t|aren'?t|was|were|no|nothing|missing|broken|fails?|failing|doesn'?t|don'?t|never|lacks?|there'?s no|you have no|leaves?)\b/i;

/** Business facts the audit has no access to. */
const BUSINESS_FACT =
  /\b(your (?:ad spend|budget|traffic|conversion rate|revenue|close rate|show[- ]?up rate|no[- ]?show rate|customers?|clients? list)|you'?re spending|you'?re getting \d|your team of)\b/i;

const AUDIT_TONE =
  /\b(i (?:ran|performed|conducted) an? (?:audit|analysis|scan)|found \d+ (?:issues?|problems?|errors?)|here (?:are|is) the \d+|my (?:audit|report) (?:found|shows))\b/i;

const PLACEHOLDER = /\[(?:name|first ?name|company|brand|your name|x)\]|\{\{[^}]+\}\}/i;

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

      if (assertsCurrentState && !hedged) {
        violations.push({
          kind: "invented_metric",
          quote: sentence,
          explanation: `States ${label} ("${value}") as the prospect's current performance. The audit cannot measure that. Either drop the number or mark it clearly as an estimate.`,
          severity: "hard",
        });
        continue;
      }

      if (!hedged) {
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
        explanation: `Uses ${label} ("${value}") as an estimate. That matches the client's style, but the number is not measured — check you are comfortable sending it.`,
        severity: "soft",
      });
    }
  }

  // 2. Post-conversion assertions. Questions are fine; claims are not.
  if (!context.audit.observability.postBookingObserved) {
    for (const sentence of sentences(haystack)) {
      if (!POST_CONVERSION_TOPIC.test(sentence)) continue;
      const isQuestion = sentence.trim().endsWith("?");
      if (isQuestion) continue;
      if (!DEFECT_ASSERTION.test(sentence)) continue;
      violations.push({
        kind: "post_booking_claim",
        quote: sentence.trim(),
        explanation:
          "States something about what happens after a form submission or booking. The audit never submitted a form or booked anything, so this cannot be evidenced. Ask it as a question instead.",
        severity: "hard",
      });
    }
  }

  // 3. Business facts the audit cannot see.
  for (const sentence of sentences(haystack)) {
    if (!BUSINESS_FACT.test(sentence)) continue;
    violations.push({
      kind: "unobserved_business_fact",
      quote: sentence.trim(),
      explanation: "Refers to traffic, spend, revenue or customer data that the audit does not have.",
      severity: "hard",
    });
  }

  // 4. Reads like an automated audit notification.
  for (const sentence of sentences(haystack)) {
    if (!AUDIT_TONE.test(sentence)) continue;
    violations.push({
      kind: "audit_report_tone",
      quote: sentence.trim(),
      explanation: "Reads like an automated audit report rather than a personal observation.",
      severity: "soft",
    });
  }

  // 5. Unfilled placeholders.
  const placeholder = haystack.match(PLACEHOLDER);
  if (placeholder) {
    violations.push({
      kind: "placeholder",
      quote: sentenceAround(haystack, placeholder.index ?? 0),
      explanation: `Contains an unfilled placeholder ("${placeholder[0]}").`,
      severity: "hard",
    });
  }

  // 6. Verbatim reuse from another prospect's email.
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

  // 7. Claiming to have performed the conversion action.
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

  // 8. A greeting name that was never established.
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

/** The name in "Hey Shayne," / "Hi Dana -" / "Hello Tim". */
export function greetingNameIn(body: string): string | null {
  const first = firstLine(body);
  const match = first.match(/^\s*(?:hey|hi|hello|good morning|good afternoon)\s+([A-Z][A-Za-z'’-]{1,30})\b/i);
  const name = match?.[1];
  if (!name) return null;
  // "Hey there" / "Hi team" are not names.
  if (/^(there|team|folks|all|guys|everyone|friend)$/i.test(name)) return null;
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
