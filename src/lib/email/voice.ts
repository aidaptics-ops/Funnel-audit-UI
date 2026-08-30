import type { ClientEmail } from "../client-knowledge/types";

/**
 * Rules derived from the client's own emails, as opposed to the evidence rules
 * in validate.ts.
 *
 * Reading the real library makes one thing obvious: these emails are a fixed
 * skeleton plus two original observations.
 *
 *   Hey [Name], I just [did the conversion action] and noticed a problem…
 *   The first thing I noticed is [observation] → [fix] → [why]
 *   The second thing I noticed is [observation] → [fix] → [why]
 *   There's another 5 low hanging fruits… happy to break it down in a loom audit.
 *   People like Alex Neilan, Dior Ray and Gav Kwok paid me $750… free for you.
 *   Best, Vlad
 *
 * So "don't copy the samples" is too blunt. The skeleton SHOULD be reused —
 * it is the client's standing offer and his signature. Only the observations
 * must be original and evidenced. These helpers separate the two.
 */

/**
 * Sentences the client reuses verbatim in every email on purpose. Matching
 * text is excluded from the plagiarism check and from the invented-metric
 * check (the $750 is a fact about the client, not a claim about the prospect).
 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  /there'?s (?:a |another )?\d*\s*(?:other )?low hanging fruits?[^.]*\./i,
  /i'?m happy to break it down[^.]*\./i,
  /(?:people|clients) like [^.]*paid me \$?\d[^.]*\./i,
  /this audit is that clients like[^.]*\./i,
  /i'?m happy to shoot it over to you for free\.?/i,
  /happy to break it down even further in a short loom audit\.?/i,
];

/** Removes the client's standing boilerplate so only original prose remains. */
export function stripBoilerplate(text: string): string {
  let out = text;
  for (const pattern of BOILERPLATE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, "gi"), " ");
  }
  return out;
}

export function isBoilerplate(sentence: string): boolean {
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(sentence));
}

/* --------------------------- verbatim reuse ------------------------------ */

/** Longest run of consecutive words shared with any sample, after boilerplate. */
export interface ReuseReport {
  longestRun: number;
  excerpt: string | null;
  sampleSubject: string | null;
}

const WORD = /[a-z0-9']+/g;

function words(text: string): string[] {
  return (stripBoilerplate(text).toLowerCase().match(WORD) ?? []).filter(Boolean);
}

/**
 * Finds the longest verbatim word run the draft shares with any sample.
 *
 * A short overlap is unavoidable and fine — "the first thing I noticed is" is
 * the client's own phrasing and should be reused. A long one means the model
 * lifted an observation from another prospect's email, which is the failure
 * this catches.
 */
export function findLongestReuse(draft: string, samples: ClientEmail[]): ReuseReport {
  const draftWords = words(draft);
  if (draftWords.length === 0) return { longestRun: 0, excerpt: null, sampleSubject: null };

  let best: ReuseReport = { longestRun: 0, excerpt: null, sampleSubject: null };

  for (const sample of samples) {
    const sampleWords = words(sample.body);
    if (sampleWords.length === 0) continue;

    // Index every position of each word in the sample for a cheap scan.
    const positions = new Map<string, number[]>();
    sampleWords.forEach((word, index) => {
      const list = positions.get(word);
      if (list) list.push(index);
      else positions.set(word, [index]);
    });

    for (let start = 0; start < draftWords.length; start += 1) {
      for (const origin of positions.get(draftWords[start]!) ?? []) {
        let length = 0;
        while (
          start + length < draftWords.length &&
          origin + length < sampleWords.length &&
          draftWords[start + length] === sampleWords[origin + length]
        ) {
          length += 1;
        }
        if (length > best.longestRun) {
          best = {
            longestRun: length,
            excerpt: draftWords.slice(start, start + length).join(" "),
            sampleSubject: sample.subject ?? null,
          };
        }
      }
    }
  }

  return best;
}

/**
 * Where the line sits. Below this, overlap is shared phrasing (the skeleton);
 * above it, whole sentences have been lifted from another prospect's email.
 */
export const MAX_VERBATIM_RUN = 14;

/* ----------------------- claimed conversion action ----------------------- */

/**
 * The client opens by saying he actually did the thing — booked the call,
 * bought the book, signed up. That is true when HE does it. The audit never
 * does: it renders one page and never submits anything.
 *
 * So the model may not write that opener unless a human confirms they really
 * performed the action.
 */
const ACTION_CLAIM =
  /\bi (?:just )?(?:booked|bought|purchased|signed up|registered|opted in|applied|watched|joined|downloaded|ordered)\b/i;

export function claimsConversionAction(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (ACTION_CLAIM.test(sentence)) return sentence.trim();
  }
  return null;
}

/* ------------------------------ hedging ---------------------------------- */

/** Wording that presents a number as an estimate rather than a measurement. */
export const HEDGE =
  /\b(i believe|i'd guess|i would guess|i've seen|i have seen|in my experience|typically|usually|generally|often|around|roughly|about|approximately|likely|tends to|can|could|should|would|might|may|assume)\b/i;

/**
 * Wording that asserts the prospect's CURRENT measured performance. The audit
 * has no access to any of it, so an unhedged version of this is always wrong.
 */
export const CURRENT_STATE_CLAIM =
  /\b(you'?re losing|you are losing|you'?re burning|is costing you|costs you|you'?re spending|your (?:conversion|opt.?in|show.?up|close|closing|booking|start|completion|click.?through)\s*rate is|your (?:traffic|revenue|ad spend|budget) is)\b/i;
