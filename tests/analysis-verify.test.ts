import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderPageEvidence } from "../src/lib/analysis/evidence";
import { parseFunnelAnalysis, type FunnelAnalysisResult } from "../src/lib/analysis/schema";
import {
  MIN_SUBSTRING_QUOTE_CHARS,
  checkCitation,
  normalise,
  verifyFindings,
  type VerificationIndexes,
} from "../src/lib/analysis/verify";
import type { RawEvidence } from "../src/lib/audit/types";

/**
 * The verifier is the only thing standing between a confident model and an
 * email that tells a stranger something untrue about their own business.
 *
 * Every test below is an attack. They are written as the ways this has to fail
 * rather than the ways it should pass, because the failure mode is silent: a
 * fabricated finding that survives verification looks exactly like a real one
 * all the way to the send button.
 */

const LANDING: RawEvidence = {
  title: "Acme — book a free strategy call",
  url: { requested: "https://acme.com/vsl", final: "https://acme.com/vsl/", http_status: 200 },
  html: { captured: true, truncated: false, head: "<title>Acme</title>", body_skeleton: "<main>" },
  visible_text: {
    text: "Book a free strategy call with our team and we will map your next twelve months.",
    characters: 80,
    truncated: false,
  },
  headings: [{ level: 1, text: "Don’t wait — it’s free, and it’s the last cohort this year", visible: true, position: "above_fold" }],
  paragraphs: { items: [{ text: "We have helped four hundred founders scale past seven figures." }], total: 600, truncated: true, cap: 1000 },
  buttons: { items: [{ text: "Book a call", tag: "button", href: null, visible: true, position: "above_fold" }], total: 1, truncated: false, cap: 800 },
  forms: [
    {
      index: 0,
      action_host: "hooks.acme.com",
      submit_text: "Get access",
      field_count: 1,
      fields: [{ tag: "input", type: "email", name: "email", label: "Work email", required: true }],
      hidden_inputs: [],
      embedded_iframes: [],
    },
  ],
  completeness: [
    { field: "headings", captured: 1, total: 1, complete: true, cap: null },
    { field: "paragraphs", captured: 1, total: 600, complete: false, cap: 1000 },
    { field: "buttons", captured: 1, total: 1, complete: true, cap: 800 },
    { field: "forms", captured: 1, total: 1, complete: true, cap: null },
    { field: "forms.fields", captured: 1, total: 1, complete: true, cap: null },
    { field: "visible_text", captured: 80, total: 80, complete: true, cap: 20000 },
    { field: "raw_html", captured: 1, total: 1, complete: true, cap: null },
  ],
};

const landingIndex = renderPageEvidence(LANDING, "landing");

/** A run with at least one operator-supplied post-booking screenshot. */
const WITH_SCREENSHOT: VerificationIndexes = { landing: landingIndex, suppliedPostBookingCount: 1 };
/** A run where none has been supplied yet. */
const LANDING_ONLY: VerificationIndexes = { landing: landingIndex, suppliedPostBookingCount: 0 };

/** Builds a result the way the parser would, so the coercion is exercised too. */
function analysis(...findings: Record<string, unknown>[]): FunnelAnalysisResult {
  const parsed = parseFunnelAnalysis({ findings });
  assert.ok(parsed, "fixture must parse");
  return parsed;
}

describe("a citation verifies against the field it names, and only that field", () => {
  it("keeps a finding whose quote is really in the field it cites", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "long-form-friction",
        citations: [{ page: "landing", field: "forms[0].fields[0].label", quote: "Work email" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(dropped.length, 0);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.citations.length, 1);
  });

  it("drops a fabricated quote", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "invented",
        citations: [{ page: "landing", field: "headings[0].text", quote: "Money-back guarantee within thirty days" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "no_verified_citation");
    assert.equal(dropped[0]?.citations[0]?.failure, "quote_not_found");
  });

  it("drops a REAL quote filed under the wrong field", () => {
    // The most dangerous case: every word of this is on the page. Only the
    // pairing is false, and only the pairing is checked.
    const check = checkCitation(
      { page: "landing", field: "forms[0].fields[0].label", quote: "Book a free strategy call with our team" },
      LANDING_ONLY,
    );
    assert.equal(check.verified, false);
    assert.equal(check.failure, "quote_not_found");
  });

  it("drops a citation whose path does not exist", () => {
    for (const field of ["testimonials[0].text", "forms[9].fields[0].label", "buttons[0].colour", ""]) {
      const check = checkCitation({ page: "landing", field, quote: "Book a call" }, LANDING_ONLY);
      assert.equal(check.verified, false, `${field} must not verify`);
      assert.equal(check.failure, "unknown_field");
    }
  });

  it("refuses to let the completeness ledger be cited as evidence", () => {
    // The inversion this whole mechanism exists to prevent: quoting the row
    // that says a list was cut short, as the proof of what is missing from it.
    const check = checkCitation(
      { page: "landing", field: "completeness[1].total", quote: "paragraphs | 1 | 600 | false | 1000" },
      LANDING_ONLY,
    );
    assert.equal(check.verified, false);
    assert.equal(check.failure, "ledger_not_citable");
  });

  it("drops a finding with no citations at all", () => {
    const { dropped } = verifyFindings(analysis({ id: "unsupported", citations: [] }), LANDING_ONLY);
    assert.equal(dropped[0]?.reason, "no_citations");
  });
});

describe("the minimum quote length", () => {
  it("refuses a short quote that merely occurs inside a long field", () => {
    for (const quote of ["a", "the", "team", "Book", "call with"]) {
      const check = checkCitation({ page: "landing", field: "visible_text.text", quote }, LANDING_ONLY);
      assert.equal(check.verified, false, `"${quote}" must not license a finding`);
      assert.equal(check.failure, "quote_too_short");
    }
  });

  it("accepts a short quote when it is the WHOLE value of the field", () => {
    // "Book a call" is eleven characters and is the entire button label. The
    // rule is not a floor on length; it is a ban on coincidental substrings.
    const check = checkCitation({ page: "landing", field: "buttons[0].text", quote: "Book a call" }, LANDING_ONLY);
    assert.equal(check.verified, true);
  });

  it("accepts a substring once it is long enough to mean something", () => {
    const quote = "Book a free strategy call";
    assert.ok(quote.length >= MIN_SUBSTRING_QUOTE_CHARS);
    assert.equal(checkCitation({ page: "landing", field: "visible_text.text", quote }, LANDING_ONLY).verified, true);
  });

  it("treats an empty or whitespace-only quote as too short", () => {
    assert.equal(checkCitation({ page: "landing", field: "buttons[0].text", quote: "   " }, LANDING_ONLY).failure, "quote_too_short");
  });
});

describe("normalisation", () => {
  it("folds case, whitespace, smart quotes, dashes and ellipses", () => {
    assert.equal(normalise("  Don’t   Wait — it’s  free "), "don't wait - it's free");
    assert.equal(normalise("A B C"), "a b c");
    assert.equal(normalise("wait…"), "wait...");
    assert.equal(normalise("soft­hyphen"), "softhyphen");
    assert.equal(normalise("“quoted”"), '"quoted"');
  });

  it("verifies a quote the model retyped with straight punctuation", () => {
    const check = checkCitation(
      { page: "landing", field: "headings[0].text", quote: "Don't wait - it's free, and it's the last cohort" },
      LANDING_ONLY,
    );
    assert.equal(check.verified, true);
  });
});

describe("absence claims need a complete field", () => {
  it("drops an absence claim made over a truncated list", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "no-social-proof",
        claim_type: "absence",
        absence_over: ["paragraphs"],
        citations: [
          {
            page: "landing",
            field: "paragraphs[0].text",
            quote: "We have helped four hundred founders scale past seven figures.",
          },
        ],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "absence_over_incomplete_evidence");
    assert.ok(dropped[0]?.detail.includes("paragraphs[0].text"));
    // The citation itself was fine — it is the CLAIM the evidence cannot carry.
    assert.equal(dropped[0]?.citations[0]?.verified, true);
  });

  it("keeps the same claim over a field the ledger marks complete", () => {
    const { kept } = verifyFindings(
      analysis({
        id: "single-cta",
        claim_type: "absence",
        absence_over: ["buttons"],
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 1);
  });

  it("drops an absence claim that reached for one incomplete field alongside a good one", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "mixed-support",
        claim_type: "absence",
        absence_over: ["buttons"],
        citations: [
          { page: "landing", field: "buttons[0].text", quote: "Book a call" },
          { page: "landing", field: "paragraphs[0].text", quote: "We have helped four hundred founders scale" },
        ],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "absence_over_incomplete_evidence");
  });

  it("still allows a PRESENCE claim over the same truncated list", () => {
    const { kept } = verifyFindings(
      analysis({
        id: "proof-is-unattributed",
        claim_type: "presence",
        citations: [
          {
            page: "landing",
            field: "paragraphs[0].text",
            quote: "We have helped four hundred founders scale past seven figures.",
          },
        ],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 1);
  });
});

describe("the post-booking page — an operator's screenshot, never a crawl", () => {
  it("drops a post-booking finding when no screenshot has been supplied", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "bare-confirmation",
        stage: "post_booking",
        citations: [{ page: "post_booking", field: "screenshot", quote: "just a bare calendar embed" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "post_booking_not_observed");
  });

  it("keeps that finding once a screenshot has been supplied, with no text match required", () => {
    const { kept } = verifyFindings(
      analysis({
        id: "bare-confirmation",
        stage: "post_booking",
        citations: [{ page: "post_booking", field: "screenshot", quote: "just a bare calendar embed" }],
      }),
      WITH_SCREENSHOT,
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.citations[0]?.quote, "just a bare calendar embed");
  });

  it("drops a landing-stage finding that cites the post-booking page anyway", () => {
    // A citation naming the post-booking page is not a weak citation to be
    // demoted and forgotten; it says what the finding is really about.
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "smuggled",
        stage: "landing",
        citations: [{ page: "post_booking", field: "screenshot", quote: "nothing prepares them for the call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "post_booking_not_observed");
    assert.equal(dropped[0]?.citations[0]?.failure, "page_not_observed");
  });

  it("drops a finding propped up by a landing quote while talking about the unsupplied page", () => {
    // The whole attack: label it "relationship", attach one real landing
    // quote, and the post-booking citation that cannot verify is quietly
    // demoted while the claim about the unseen page survives on the other one.
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "dead-end",
        stage: "relationship",
        claim_type: "relationship",
        title: "The confirmation page is a dead end with no next step",
        citations: [
          { page: "landing", field: "buttons[0].text", quote: "Book a call" },
          { page: "post_booking", field: "screenshot", quote: "nothing links back" },
        ],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "post_booking_not_observed");
  });

  it("drops a relationship finding outright when no screenshot exists", () => {
    // There is no crawl of a second page at all, so a "relationship" finding
    // is only ever grounded once a screenshot exists.
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "no-tracking-continuity",
        stage: "relationship",
        claim_type: "relationship",
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "post_booking_not_observed");
  });

  it("still allows a relationship finding once a screenshot exists", () => {
    const { kept } = verifyFindings(
      analysis({
        id: "tracking-carries",
        stage: "relationship",
        claim_type: "relationship",
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      WITH_SCREENSHOT,
    );
    assert.equal(kept.length, 1);
  });
});

describe("absence claims may never rest on the post-booking page", () => {
  it("refuses an absence finding staged as post_booking, however many screenshots exist", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "no-faq",
        stage: "post_booking",
        claim_type: "absence",
        citations: [{ page: "post_booking", field: "screenshot", quote: "nothing on this page" }],
      }),
      WITH_SCREENSHOT,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "absence_over_screenshot");
  });

  it("refuses an absence finding that merely cites the post-booking page from another stage", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "no-next-step",
        stage: "relationship",
        claim_type: "absence",
        citations: [
          { page: "landing", field: "buttons[0].text", quote: "Book a call" },
          { page: "post_booking", field: "screenshot", quote: "no link back to the site" },
        ],
      }),
      WITH_SCREENSHOT,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "absence_over_screenshot");
  });

  it("still allows an ordinary landing-page absence claim, unaffected by the post-booking ban", () => {
    const { kept } = verifyFindings(
      analysis({
        id: "no-guarantee",
        claim_type: "absence",
        absence_over: ["buttons"],
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      WITH_SCREENSHOT,
    );
    assert.equal(kept.length, 1);
  });
});

describe("what survives, and in what order", () => {
  it("keeps only the citations that verified, and records the rest", () => {
    const { kept } = verifyFindings(
      analysis({
        id: "partly-supported",
        citations: [
          { page: "landing", field: "buttons[0].text", quote: "Book a call" },
          { page: "landing", field: "headings[0].text", quote: "Rated five stars by nine hundred clients" },
        ],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept[0]?.citations.length, 1);
    assert.equal(kept[0]?.citations[0]?.field, "buttons[0].text");
    assert.equal(kept[0]?.rejectedCitations.length, 1);
    assert.equal(kept[0]?.rejectedCitations[0]?.failure, "quote_not_found");
  });

  it("orders by weight, then severity, then id — and never by luck", () => {
    const result = analysis(
      { id: "c-low", commercial_weight: 10, severity: "critical", citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }] },
      { id: "a-heavy", commercial_weight: 90, severity: "low", citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }] },
      { id: "b-tied", commercial_weight: 50, severity: "high", citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }] },
      { id: "a-tied", commercial_weight: 50, severity: "high", citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }] },
      { id: "z-tied", commercial_weight: 50, severity: "critical", citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }] },
    );

    const order = verifyFindings(result, LANDING_ONLY).kept.map((finding) => finding.id);
    assert.deepEqual(order, ["a-heavy", "z-tied", "a-tied", "b-tied", "c-low"]);
  });

  it("produces byte-identical output for identical input", () => {
    const build = () =>
      analysis(
        { id: "one", commercial_weight: 50, citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }] },
        { id: "two", commercial_weight: 50, citations: [{ page: "landing", field: "headings[0].text", quote: "nowhere on the page" }] },
        { id: "three", commercial_weight: 50, claim_type: "absence", absence_over: ["paragraphs"], citations: [{ page: "landing", field: "paragraphs[0].text", quote: "We have helped four hundred founders" }] },
      );

    const first = verifyFindings(build(), LANDING_ONLY);
    const second = verifyFindings(build(), LANDING_ONLY);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(first.kept.map((entry) => entry.id), ["one"]);
    assert.deepEqual(first.dropped.map((entry) => entry.reason), [
      "absence_over_incomplete_evidence",
      "no_verified_citation",
    ]);
  });
});

describe("only fields that carry words may be quoted", () => {
  it("refuses a boolean, a count and an enum, whatever claim they are attached to", () => {
    // Every one of these verifies as an exact whole-value match on three to
    // six characters. "At least one citation verifies" is the entire licence
    // this system grants, and it must not be obtainable from a field that
    // reads "true" on every page ever published.
    for (const field of [
      "headings[0].visible",
      "visible_text.characters",
      "buttons[0].tag",
      "paragraphs.total",
      "url.http_status",
      "forms[0].fields[0].required",
      "forms[0].field_count",
    ]) {
      const value = landingIndex.index.get(field);
      assert.ok(value !== undefined, `${field} must be in the index for this test to mean anything`);
      const check = checkCitation({ page: "landing", field, quote: value }, LANDING_ONLY);
      assert.equal(check.verified, false, `${field} must not be citable`);
      assert.equal(check.failure, "field_not_quotable");
    }
  });

  it("gives a wholly invented finding nothing to stand on", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "invented",
        severity: "high",
        commercial_weight: 90,
        title: "Your page hides the offer and has no working checkout",
        citations: [{ page: "landing", field: "headings[0].visible", quote: "true" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "no_verified_citation");
  });

  it("still accepts the fields that carry the page's own words", () => {
    for (const [field, quote] of [
      ["buttons[0].text", "Book a call"],
      ["forms[0].fields[0].label", "Work email"],
      ["forms[0].action_host", "hooks.acme.com"],
      ["title", "Acme - book a free strategy call"],
    ] as [string, string][]) {
      assert.equal(checkCitation({ page: "landing", field, quote }, LANDING_ONLY).verified, true, field);
    }
  });

  it("refuses a quotable field whose value is null or empty", () => {
    // buttons[0].href is null on a scripted button. "null" is not evidence.
    const check = checkCitation({ page: "landing", field: "buttons[0].href", quote: "null" }, LANDING_ONLY);
    assert.equal(check.verified, false);
    assert.equal(check.failure, "field_not_quotable");
  });
});

describe("an absence claim must say where it looked", () => {
  it("drops an absence claim that names nowhere", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "no-guarantee",
        claim_type: "absence",
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "absence_without_search_space");
  });

  it("drops an absence claim whose evidence comes from outside the space it searched", () => {
    // "No testimonials", searched over headings, proved with a button label.
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "no-testimonials",
        claim_type: "absence",
        absence_over: ["headings"],
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "absence_not_anchored");
  });

  it("drops an absence claim that names a root the ledger never accounted for", () => {
    const { dropped } = verifyFindings(
      analysis({
        id: "no-testimonials",
        claim_type: "absence",
        absence_over: ["buttons", "testimonials"],
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(dropped[0]?.reason, "absence_over_incomplete_evidence");
    assert.ok(dropped[0]?.detail.includes("testimonials"));
  });

  it("drops an absence claim that names a truncated root, even when its own quote is fine", () => {
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "no-social-proof",
        claim_type: "absence",
        absence_over: ["buttons", "paragraphs"],
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "absence_over_incomplete_evidence");
  });

  it("refuses a scalar as a search space, however complete it looks", () => {
    // request_count is a single number. Nothing could ever have been found in
    // it, so searching it is not a search.
    const { kept, dropped } = verifyFindings(
      analysis({
        id: "no-testimonials",
        claim_type: "absence",
        absence_over: ["request_count"],
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 0);
    assert.equal(dropped[0]?.reason, "absence_over_incomplete_evidence");
  });

  it("keeps an absence claim that searched a complete root and quoted from inside it", () => {
    const { kept } = verifyFindings(
      analysis({
        id: "one-way-out",
        claim_type: "absence",
        absence_over: ["buttons"],
        citations: [{ page: "landing", field: "buttons[0].text", quote: "Book a call" }],
      }),
      LANDING_ONLY,
    );
    assert.equal(kept.length, 1);
  });
});
