/**
 * How likely is this person to be the person who decides about the funnel?
 *
 * The old code treated every name a provider returned as equal, so a support
 * rep and the founder were interchangeable and whichever came back first won.
 * That is the main reason owner discovery kept missing.
 *
 * Scoring is deliberately title-first. A provider's own "decision maker" flag
 * and seniority band help, but they are coarse: they mark a VP of Sales at a
 * 10,000-person company as a decision maker, which is true for buying software
 * and false for "who owns this funnel". The title is what actually separates an
 * owner from an employee.
 */

export interface ScoreInput {
  title: string | null;
  seniority?: string | null;
  department?: string | null;
  decisionMaker?: boolean | null;
  /** Head-count band, when the provider gives one ("1-10", "10K-50K"). */
  companySize?: string | null;
}

export interface OwnerScore {
  score: number;
  /** Plain-language reason, shown to the operator beside the candidate. */
  rationale: string;
  /** True when the title alone identifies an owner rather than an employee. */
  isOwnerTitle: boolean;
}

/**
 * Ordered strongest first. The first match wins, so "co-founder" must be
 * tested before "founder" would swallow it, and "vice president" before
 * "president".
 */
const TITLE_TIERS: { pattern: RegExp; points: number; owner: boolean; label: string }[] = [
  { pattern: /\b(co[-\s]?founder|cofounder)\b/i, points: 100, owner: true, label: "co-founder" },
  { pattern: /\bfounder\b/i, points: 100, owner: true, label: "founder" },
  { pattern: /\b(owner|proprietor|sole trader)\b/i, points: 100, owner: true, label: "owner" },
  { pattern: /\b(ceo|chief executive)\b/i, points: 92, owner: true, label: "CEO" },
  // Before "president": first match wins, and "Vice President" contains it.
  // A lookahead cannot help here — the "vice" sits to the LEFT of the match.
  { pattern: /\b(vice president|vp|svp|evp)\b/i, points: 40, owner: false, label: "VP" },
  { pattern: /\bpresident\b/i, points: 84, owner: true, label: "president" },
  { pattern: /\bmanaging (director|partner|member)\b/i, points: 80, owner: true, label: "managing director" },
  { pattern: /\b(principal|partner)\b/i, points: 66, owner: true, label: "principal" },
  { pattern: /\bchief \w+ officer\b|\bc[toimfrp]o\b/i, points: 58, owner: false, label: "C-level" },
  { pattern: /\b(head of|director)\b/i, points: 34, owner: false, label: "director" },
  { pattern: /\b(lead|manager|coach)\b/i, points: 18, owner: false, label: "manager" },
];

/**
 * Roles that exist to talk to strangers. Reaching them is easy and useless —
 * they are not who decides, and a cold email to them dies there.
 */
const FRONT_DESK = /\b(support|customer success|sales development|sdr|bdr|recruit|assistant|intern|receptionist)\b/i;

/** A company small enough that its "CEO" really is the person who owns it. */
const SMALL_COMPANY = /^(1-10|11-50|1 ?- ?10|11 ?- ?50)$/i;

export function scoreOwner(input: ScoreInput): OwnerScore {
  const title = (input.title ?? "").trim();
  const reasons: string[] = [];
  let score = 0;
  let isOwnerTitle = false;

  const tier = TITLE_TIERS.find((entry) => entry.pattern.test(title));
  if (tier) {
    score += tier.points;
    isOwnerTitle = tier.owner;
    reasons.push(tier.label);
  } else if (title) {
    reasons.push("no owner-shaped title");
  } else {
    reasons.push("no title given");
  }

  // At a small company the chief executive IS the owner; at a large one the
  // title says nothing about who owns the marketing funnel.
  if (tier?.owner && input.companySize && SMALL_COMPANY.test(input.companySize.trim())) {
    score += 15;
    reasons.push("small company");
  }

  if (input.decisionMaker === true) {
    score += 20;
    reasons.push("flagged decision maker");
  }

  const seniority = (input.seniority ?? "").toLowerCase();
  if (seniority === "executive") {
    score += 16;
    reasons.push("executive");
  } else if (seniority === "senior") {
    score += 6;
  }

  const department = (input.department ?? "").toLowerCase();
  if (department === "executive") {
    score += 14;
    reasons.push("executive team");
  } else if (department === "management") {
    score += 8;
  }

  // A front-desk role is a dead end even when its seniority looks impressive.
  if (FRONT_DESK.test(title)) {
    score -= 45;
    reasons.push("front-desk role");
  }

  return { score: Math.max(0, score), rationale: reasons.join(" · "), isOwnerTitle };
}

/** The bar a title must clear to be treated as the business owner. */
export const OWNER_SCORE_BAR = 80;

/** Enough to be worth showing and contacting, without being the owner. */
export const CONTACTABLE_SCORE_BAR = 30;
