import { ABSENCE_SEARCH_ROOTS, completenessKeyFor, isFieldComplete, type RenderedEvidence } from "./evidence";
import type { EvidenceCitation, FunnelAnalysisResult, FunnelFinding } from "./schema";
import type { IssueSeverity } from "../audit/types";

/**
 * THE SAFETY PROPERTY.
 *
 * Everything upstream of this file is a model being asked to be careful.
 * Nothing downstream of it re-checks anything. So this is the single place
 * where "the model said so" becomes "the page said so", and every rule here
 * exists because of a specific way that can go wrong.
 *
 * The landing page has a structured capture behind it — a dotted-path index
 * and a completeness ledger — so a citation against it is checked exactly as
 * before. The post-booking "page" is never crawled at all: the only evidence
 * that can ever exist for it is an operator's own photograph, which has no
 * DOM and nothing to index. So a citation against it cannot be text-matched,
 * and is instead trusted wholesale once a screenshot genuinely exists — the
 * same trust the pre-existing manual-upload feature already extends via its
 * caption, with zero mechanical verification. The one thing a photograph can
 * never do is prove an ABSENCE, so that half is refused unconditionally,
 * screenshots or not.
 *
 * A finding survives only when ALL of these hold:
 *
 *   1. it carries at least one citation that VERIFIES — for the landing page,
 *      the quoted text is actually present in the value of the exact QUOTABLE
 *      field it names; for the post-booking page, a screenshot of it has
 *      actually been supplied;
 *   2. if it is about the post-booking page, or cites it, at least one
 *      screenshot of that page has been supplied for this run;
 *   3. if it claims something is ABSENT, it may never touch the post-booking
 *      page at all — a photograph can prove something is present, never that
 *      it is absent. Over the landing page, it must name the roots it
 *      searched, every one of those roots must be marked complete in the
 *      page's ledger, every field it cites must be complete too, and at least
 *      one verified citation must actually come from inside the space it says
 *      it searched.
 *
 * Anything else goes to `dropped` with a machine-readable reason, and is kept
 * rather than deleted: a human looking at the run should be able to see what
 * was thrown away and why, which is also the only way anybody notices the day
 * this starts throwing away good findings.
 */

/**
 * The shortest quote that may be matched as a SUBSTRING of a longer field.
 *
 * The attack this defends against is a model citing `visible_text.text` — a
 * page's entire prose — and quoting "the", or citing `buttons[0].text` and
 * quoting "Book". Both verify trivially, and a verified citation is the whole
 * licence this system grants. Twenty-four characters is roughly a four-word
 * English phrase; below that, a substring hit inside a long field is more
 * plausibly a coincidence than a citation.
 *
 * It is not a floor on quote length, because that would make short fields
 * uncitable and a page's most important evidence is often eight characters
 * long ("Book a call", "Register"). Instead a shorter quote must match the
 * cited field's value in FULL — an exact equality after normalisation.
 *
 * That equality is only safe alongside QUOTABLE_LEAVES below. On its own it
 * moved the "matches anything" hazard from long fields to short ones: the
 * index is full of paths whose entire value is `true`, `button` or `200`, and
 * a four-character exact match on one of those bought a wholly invented
 * finding its verified citation for free.
 */
export const MIN_SUBSTRING_QUOTE_CHARS = 24;

/**
 * The leaf names a citation may point at.
 *
 * A citation is meant to be the page's own words, and the only fields that
 * have words are the ones that carry text an author wrote or an address a
 * browser resolved. Everything else in the inventory — `visible`, `required`,
 * `total`, `field_count`, `http_status`, `tag`, `type`, `position` — is a
 * count, a flag or a two-word enum. Those exist for the model to REASON from;
 * quoting one proves nothing, because `headings[0].visible` is "true" on
 * essentially every page in the world and would therefore verify essentially
 * every claim anybody cared to attach to it.
 *
 * An allowlist rather than a denylist, deliberately. A field this list forgets
 * becomes uncitable, which costs a finding; a field a denylist forgets becomes
 * a free licence, which costs the truth. The first failure is visible in a
 * `field_not_quotable` line, and the second is invisible until it is in
 * somebody's inbox.
 */
const QUOTABLE_LEAVES: ReadonlySet<string> = new Set([
  // Words a person wrote on the page.
  "text", "label", "placeholder", "alt", "title", "content", "submit_text",
  "heading_near", "options", "json_ld", "window_globals_present", "page_errors",
  "note", "reason", "inline_snippet",
  // Names and addresses: identifiers a claim can genuinely rest on.
  "name", "id", "selector", "form_selector", "class_name", "allow", "rel",
  "href", "src", "host", "url", "final", "requested", "content_type", "action",
  "action_host", "source", "autocomplete", "charset",
  // The two raw-markup sections.
  "head", "body_skeleton",
]);

/**
 * Renderings that are structure, not evidence, whatever field they sit in.
 *
 * `buttons[0].href` is quotable and is `null` on a scripted button; `alt` is
 * quotable and is `""` on a decorative image. Neither of those values is
 * something a finding may rest on, so the shape of the value refuses even when
 * the name of the field allows.
 */
const UNQUOTABLE_VALUES: ReadonlySet<string> = new Set(["null", "true", "false", '""']);

export type CitationFailure =
  /** The citation names the post-booking page and no screenshot exists yet. */
  | "page_not_observed"
  /** No such dotted path exists in what the model was shown. */
  | "unknown_field"
  /** Pointed at the completeness ledger rather than at any evidence. */
  | "ledger_not_citable"
  /** A count, a flag or an enum: structure to reason from, not evidence to quote. */
  | "field_not_quotable"
  /** Shorter than the substring floor and not an exact match of the field. */
  | "quote_too_short"
  /** The field exists; the quoted text is not in it. */
  | "quote_not_found";

export type DropReason =
  | "no_citations"
  | "no_verified_citation"
  /** About the post-booking page, and no screenshot of it has been supplied. */
  | "post_booking_not_observed"
  /** An absence claim that touches the post-booking page — a photograph can never prove absence. */
  | "absence_over_screenshot"
  /** An absence claim that never said where it looked. */
  | "absence_without_search_space"
  | "absence_over_incomplete_evidence"
  /** An absence claim whose evidence comes from outside the space it searched. */
  | "absence_not_anchored";

export interface CitationCheck {
  citation: EvidenceCitation;
  verified: boolean;
  failure: CitationFailure | null;
}

export interface VerifiedFinding extends FunnelFinding {
  /** Only the citations that verified. Nothing downstream may quote the rest. */
  citations: EvidenceCitation[];
  /** What was discarded from this finding, kept so the UI can show it. */
  rejectedCitations: CitationCheck[];
}

export interface DroppedFinding {
  finding: FunnelFinding;
  reason: DropReason;
  /** One human-readable sentence. Never a stack trace, never an internal path. */
  detail: string;
  citations: CitationCheck[];
}

export interface VerificationResult {
  kept: VerifiedFinding[];
  dropped: DroppedFinding[];
}

export interface VerificationIndexes {
  landing: RenderedEvidence;
  /**
   * How many screenshots the operator has supplied of the page after
   * conversion, at the moment this run is being verified.
   *
   * There is no structured capture of that page to index — a photograph has
   * no DOM — so this count, not a `RenderedEvidence`, is the entire evidence
   * this file has for it.
   */
  suppliedPostBookingCount: number;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

export function verifyFindings(
  result: FunnelAnalysisResult,
  indexes: VerificationIndexes,
): VerificationResult {
  const kept: VerifiedFinding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of result.findings) {
    const checks = finding.citations.map((citation) => checkCitation(citation, indexes));

    /*
     * Does this finding touch the post-booking page at all?
     *
     * Keying this on `stage === "post_booking"` alone was not enough. A model
     * that labels a claim about that page `relationship` — or `landing` —
     * walked straight past it, because the only other requirement is that ONE
     * citation verifies and a landing-page quote satisfies that. The
     * unverifiable post-booking citation beside it was quietly demoted into
     * `rejectedCitations` and ignored, leaving a sentence about a page nobody
     * saw propped up by a quote from a page that was.
     *
     * So all three doors are shut: the stage, the relationship stage (with one
     * page there is nothing to relate it to — `computeRelationship` returns
     * null for every comparison there is no crawl to make), and any citation
     * pointing at the post-booking page. A citation naming it is not a weak
     * citation; it is evidence about what the finding is really about.
     */
    const touchesPostBooking =
      finding.stage === "post_booking" ||
      finding.stage === "relationship" ||
      finding.citations.some((citation) => citation.page === "post_booking");

    /*
     * RULE 3's post-booking half, checked first and unconditionally.
     *
     * A photograph can prove something is PRESENT. It can never prove
     * something is ABSENT — you cannot rule out a form existing just because
     * it is not visible in one screenshot — so this refuses regardless of how
     * many screenshots exist, before the ordinary "has a screenshot been
     * supplied at all" gate below even runs.
     */
    if (finding.claimType === "absence" && touchesPostBooking) {
      dropped.push({
        finding,
        reason: "absence_over_screenshot",
        detail:
          "It claims something is absent from the page after conversion. A photograph can show what is on a " +
          "page; it can never prove something is not there, however many screenshots exist.",
        citations: checks,
      });
      continue;
    }

    if (touchesPostBooking && indexes.suppliedPostBookingCount === 0) {
      dropped.push({
        finding,
        reason: "post_booking_not_observed",
        detail:
          "This finding is about the page after the conversion step, and no screenshot of it has been " +
          "supplied for this run.",
        citations: checks,
      });
      continue;
    }

    if (finding.citations.length === 0) {
      dropped.push({
        finding,
        reason: "no_citations",
        detail: "The finding quoted nothing from either page.",
        citations: checks,
      });
      continue;
    }

    const verified = checks.filter((check) => check.verified);
    if (verified.length === 0) {
      dropped.push({
        finding,
        reason: "no_verified_citation",
        detail: `None of its ${checks.length} citation(s) could be found in the evidence they named.`,
        citations: checks,
      });
      continue;
    }

    // A post-booking absence claim was already refused above, so any absence
    // claim reaching here is entirely about the landing page.
    if (finding.claimType === "absence") {
      const refusal = checkAbsence(finding, verified, indexes);
      if (refusal) {
        dropped.push({ finding, reason: refusal.reason, detail: refusal.detail, citations: checks });
        continue;
      }
    }

    kept.push({
      ...finding,
      citations: verified.map((check) => check.citation),
      rejectedCitations: checks.filter((check) => !check.verified),
    });
  }

  return { kept: kept.sort(byRank), dropped: dropped.sort((left, right) => cmp(left.finding.id, right.finding.id)) };
}

/**
 * One citation, checked against the evidence available for the page it names.
 *
 * For the landing page that is `index.get(citation.field)` — the ONE field it
 * names, never searched for across the brief. A model that lifts a real
 * headline and files it under `forms[0].fields[2].label` has produced a true
 * sentence attached to a false claim, and only the pairing catches that.
 *
 * For the post-booking page there is no field to check at all: an uploaded
 * screenshot carries no DOM and nothing indexed. Trust is extended wholesale,
 * once a screenshot genuinely exists — exactly the trust the pre-existing
 * manual-upload feature's own caption already grants, with zero mechanical
 * verification. (An absence claim never reaches here for that page: the hard
 * rule in `verifyFindings` drops those first, unconditionally.)
 */
export function checkCitation(citation: EvidenceCitation, indexes: VerificationIndexes): CitationCheck {
  const fail = (failure: CitationFailure): CitationCheck => ({ citation, verified: false, failure });

  if (citation.page === "post_booking") {
    return indexes.suppliedPostBookingCount > 0
      ? { citation, verified: true, failure: null }
      : fail("page_not_observed");
  }

  const page = indexes.landing;
  if (!page.captured) return fail("page_not_observed");

  // The ledger is printed for the model to reason WITH, never to quote FROM.
  // Quoting "links | 1200 | 1387 | false" as the evidence that a page has no
  // links is the exact inversion this whole mechanism exists to prevent.
  if (rootOf(citation.field) === "completeness") return fail("ledger_not_citable");

  const value = page.index.get(citation.field);
  if (value === undefined) return fail("unknown_field");
  if (!isQuotable(citation.field, value)) return fail("field_not_quotable");

  const haystack = normalise(value);
  const needle = normalise(citation.quote);
  if (needle === "") return fail("quote_too_short");

  if (needle.length < MIN_SUBSTRING_QUOTE_CHARS) {
    return needle === haystack ? { citation, verified: true, failure: null } : fail("quote_too_short");
  }

  return haystack.includes(needle)
    ? { citation, verified: true, failure: null }
    : fail("quote_not_found");
}

/**
 * RULE 3's landing half — the only place this system is allowed to say a
 * LANDING page has no X. (The post-booking half is refused outright, before
 * this ever runs — a photograph can never prove an absence, so every citation
 * reaching this function is against the landing page.)
 *
 * Three questions, in order, and every one of them mechanical:
 *
 *   WHERE DID YOU LOOK? An absence claim carries `absence_over`, the roots the
 *   model says it searched. Without it there is nothing to check. The version
 *   this replaces asked only that every CITED field be complete, which meant
 *   citing any complete root, however irrelevant, bought the strongest
 *   permission in the system: "there is not a single testimonial anywhere on
 *   this page", cited to `request_count`, passed.
 *
 *   WAS THAT PLACE COLLECTED IN FULL? Every named root must be a collection
 *   this capture accounts for, and must be marked complete. A root nobody
 *   accounted for is not complete: silence is not evidence that a page holds
 *   nothing.
 *
 *   IS YOUR EVIDENCE FROM THERE? At least one verified citation must resolve
 *   into the space that was searched. Otherwise the claim and the proof are
 *   about different parts of the page, and only the prose connects them.
 *
 * The cited-field check stays alongside all of that, and stays deliberately
 * over EVERY cited field rather than only the verified ones: a model that
 * reached for one incomplete field while writing an absence claim has already
 * shown it was reasoning over a list it could not see the end of.
 */
function checkAbsence(
  finding: FunnelFinding,
  verified: CitationCheck[],
  indexes: VerificationIndexes,
): { reason: DropReason; detail: string } | null {
  const incomplete = finding.citations.find((citation) => !isFieldComplete(citation.field, indexes.landing.completeness));
  if (incomplete) {
    return {
      reason: "absence_over_incomplete_evidence",
      detail:
        `It claims something is absent over "${incomplete.field}", which the capture's ` +
        "completeness ledger does not mark as fully collected.",
    };
  }

  const roots = finding.absenceOver;
  if (roots.length === 0) {
    return {
      reason: "absence_without_search_space",
      detail: "It claims something is absent without naming anywhere it looked for it.",
    };
  }

  for (const root of roots) {
    if (!ABSENCE_SEARCH_ROOTS.has(root)) {
      return {
        reason: "absence_over_incomplete_evidence",
        detail:
          `It says it searched "${root}", which is not a collection this capture accounts for, so ` +
          "nothing there can show that something is missing.",
      };
    }
    if (indexes.landing.completeness.get(root) !== true) {
      return {
        reason: "absence_over_incomplete_evidence",
        detail:
          `It says it searched "${root}", which the capture's completeness ledger does not mark ` +
          "as fully collected, so the end of that list was never seen.",
      };
    }
  }

  const anchored = verified.some((check) => {
    const key = completenessKeyFor(check.citation.field, indexes.landing.completeness);
    return key !== null && roots.some((root) => key === root || key.startsWith(`${root}.`));
  });
  if (!anchored) {
    return {
      reason: "absence_not_anchored",
      detail:
        `None of its verified quotes come from ${roots.join(", ")} — the place it says it looked ` +
        "— so nothing ties the evidence to the claim.",
    };
  }

  return null;
}

/**
 * Whitespace collapsed, case folded, typography flattened.
 *
 * A model copying from a rendered page reliably gives back a straight
 * apostrophe where the page had a curly one, "..." where the page had "…", and
 * a hyphen where the page had an em dash. None of those are a different quote,
 * and rejecting them would train the next person to loosen the matcher into
 * something that accepts anything.
 *
 * NFKC first, so a full-width or ligature form folds onto its plain
 * equivalent, then the specific characters NFKC leaves alone.
 */
export function normalise(text: string): string {
  return (text ?? "")
    .normalize("NFKC")
    // Zero-width and soft-hyphen characters survive a copy-paste invisibly.
    .replace(/[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    // Every space-ish character, including the non-breaking space a page uses
    // between a number and its unit, becomes one plain space.
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * May this field be quoted at all?
 *
 * Decided by its leaf name — the last dotted segment once array indices are
 * gone, so `forms[0].fields[2].label` is `label` and `json_ld[3]` is `json_ld`
 * — and then by the shape of what it actually rendered.
 */
export function isQuotable(field: string, value: string): boolean {
  const leaf = field
    .replace(/\[\d+\]/g, "")
    .split(".")
    .filter(Boolean)
    .at(-1);
  if (leaf === undefined || !QUOTABLE_LEAVES.has(leaf)) return false;
  return !UNQUOTABLE_VALUES.has(value.trim());
}

function rootOf(field: string): string {
  return field.replace(/\[\d+\]/g, "").split(".")[0] ?? "";
}

/**
 * A total order, so two runs over identical input produce identical output.
 *
 * Weight first because that is what the ranking means, then severity, then id
 * — the last one is arbitrary but it is a tiebreak, and a tiebreak that is
 * arbitrary and stable beats one that is meaningful and unstable.
 */
function byRank(left: FunnelFinding, right: FunnelFinding): number {
  if (left.commercialWeight !== right.commercialWeight) return right.commercialWeight - left.commercialWeight;
  const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severity !== 0) return severity;
  return cmp(left.id, right.id);
}

function cmp(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
