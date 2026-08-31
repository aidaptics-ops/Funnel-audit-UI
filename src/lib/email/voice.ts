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
  // "Founders like" is the later phrasing; the earlier emails say "people"
  // or "clients". Same standing line, same $750, so the same exemption.
  /(?:people|clients|founders|guys) like [^.]*paid me \$?\d[^.]*\./i,
  /this audit is that clients like[^.]*\./i,
  /i'?m happy to shoot it over to you for free\.?/i,
  /happy to break it down even further in a short loom audit\.?/i,
  /i can break everything down in detail with a video[^.]*\./i,

  /*
   * The credential parenthetical, which opens every recent email:
   *   "(I work with offer owners increase their show up rate past 85% ...,
   *    so I have a good idea of what converts best)"
   *
   * It carries a percentage, so without this the invented-metric rule rejects
   * it as a fabricated measurement — but the number describes what the CLIENT
   * achieves for his own clients, not what the prospect is currently doing.
   * Verified against the real library: samples 12 and 15 were hard-rejected
   * on this line alone before it was listed here.
   */
  /\((?:i (?:work with|help)|i'?ve (?:worked|helped))[^)]{0,200}\)/i,

  /*
   * The closing projection: "These 2 tweaks might sound simple but they get
   * you to a 10-15% view to booked call ... but there's 5 others things too".
   *
   * A forward-looking claim about what his fix achieves, drawn from his own
   * track record. It is not a measurement of the prospect's current state,
   * which is the thing the metric rule exists to catch.
   */
  /these \d+ tweaks[^.]*\./i,
  /but there'?s \d+ others? things? too[^.]*\./i,

  /*
   * The bridge, present verbatim in all five recent emails:
   *   "And I noticed you're doing a lot of things right, but I found something
   *    pretty critical that is wrecking your show up rate..."
   *
   * Without it a draft that correctly imitates the new skeleton shares a
   * 29-word run with the library and is hard-rejected as plagiarism — so the
   * more faithfully the model followed the voice, the more certainly it was
   * thrown away. Measured, not guessed.
   */
  /and i noticed you'?re doing a lot of things right[^.]*\./i,
  /you would decrease your cac while increasing your personal margins\.?/i,

  /*
   * His standing explanation of the podcast-VSL play, which samples 11, 12 and
   * 16 reproduce almost word for word. It is a description of a technique, not
   * an observation about a prospect, so repeating it is correct.
   */
  /a superior way to educate and pre-?sell prospects before the call[^.]*\./i,
  /host this podcast with your sales rep[^.]*\./i,
  /all you need is your top \d+-?\d* objections[^.]*\./i,
  /this will do a few things at once[^.]*\./i,
  /it will transfer trust to the sales rep[^.]*\./i,
  /your prospects will actually watch the podcast[^.]*\./i,
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
/*
 * Two shapes, because the client uses two.
 *
 * "I just booked a call with your team." is the older one. The recent emails
 * drop the pronoun — "Just booked a strategy call with Sonny...", "Just bought
 * the Daily Profits system..." — and the first pattern misses all of them,
 * which meant the generator could open with a conversion the operator never
 * performed and nothing would catch it. That is a lie in the first line of a
 * cold email, so the second shape is anchored to the start of a sentence and
 * requires the "just" the client always writes, which keeps it off innocent
 * sentences like "Signed up members get a discount".
 */
const ACTION_CLAIM =
  /\bi (?:just )?(?:booked|bought|purchased|signed up|registered|opted in|applied|watched|joined|downloaded|ordered)\b|^\s*just\s+(?:booked|bought|purchased|signed up|registered|opted in|applied|watched|joined|downloaded|ordered|got to the end)\b/i;

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

/**
 * Wording that puts a number in the FUTURE rather than the present.
 *
 * "This will lift your opt in rate by 3-5%" and "stunting you from hitting a
 * 4-5% conversion rate" are the client's own sentences. Neither states what
 * the prospect's rate is today — they state what it could be, from his
 * experience of doing this before. The invented-metric rule was rejecting
 * both, which meant his real emails could not have been written by his own
 * generator.
 *
 * Tested against the text immediately BEFORE the number, so the projection
 * has to govern that specific figure. "You're losing 40% of visitors" is
 * still a present-tense measurement and still fails.
 */
export const PROJECTED_RESULT =
  // The trailing range fragment matters: the percentage pattern matches the
  // SECOND half of "3-5%", so the run-up handed to this regex ends "...by 3-".
  // Without it the client's commonest form of projection was still rejected.
  /\b(?:lift|lifts|lifting|raise|raises|raising|increase|increases|increasing|boost|boosts|boosting|bump|bumps|bumping|improve|improves|improving|hit|hitting|reach|reaching|climb|climbing|closer to|up to|past|beyond|to a|by)\s+(?:a |an |about |around |roughly |over )?(?:\d{1,3}(?:\.\d+)?\s?[-–—]\s?)?$/i;

/** How far back to look for it. Long enough for "from hitting a ". */
export const PROJECTION_WINDOW = 45;
