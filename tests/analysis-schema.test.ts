import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampWeight, parseFunnelAnalysis, slugify } from "../src/lib/analysis/schema";

/**
 * The parser is the boundary between "a model said something" and "this app
 * has data". Everything it is given is untrusted, so every test here feeds it
 * something a model has plausibly produced rather than something well formed.
 */

describe("parseFunnelAnalysis on malformed output", () => {
  it("returns null for anything that is not an analysis object", () => {
    for (const value of [null, undefined, "", "not json", 42, true, [], [{ id: "x" }]]) {
      assert.equal(parseFunnelAnalysis(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });

  it("returns null when findings is missing or not an array", () => {
    assert.equal(parseFunnelAnalysis({}), null);
    assert.equal(parseFunnelAnalysis({ findings: null }), null);
    assert.equal(parseFunnelAnalysis({ findings: "none" }), null);
    assert.equal(parseFunnelAnalysis({ findings: { "0": {} } }), null);
  });

  it("accepts an empty findings array as a real answer", () => {
    // "I looked and found nothing worth raising" is a legitimate result and
    // must not be confused with a parse failure, which would spend a second
    // call trying to repair a perfectly good reply.
    const result = parseFunnelAnalysis({ findings: [] });
    assert.ok(result);
    assert.deepEqual(result.findings, []);
  });

  it("skips junk entries inside the findings array without losing the good ones", () => {
    const result = parseFunnelAnalysis({
      findings: [null, 5, "nope", [], { id: "real-one", citations: [] }],
    });
    assert.ok(result);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.id, "real-one");
  });

  it("never throws on deeply wrong shapes", () => {
    assert.doesNotThrow(() =>
      parseFunnelAnalysis({
        findings: [{ id: {}, citations: "yes", severity: [], commercial_weight: {} }],
        classification: "clear",
        unverifiable_notes: [1, null, "kept"],
      }),
    );
  });

  it("keeps only the string notes", () => {
    const result = parseFunnelAnalysis({ findings: [], unverifiable_notes: [1, null, "kept", "  "] });
    assert.deepEqual(result?.unverifiableNotes, ["kept"]);
  });
});

describe("finding coercion", () => {
  function finding(overrides: Record<string, unknown> = {}) {
    const result = parseFunnelAnalysis({ findings: [{ id: "a-finding", ...overrides }] });
    return result?.findings[0];
  }

  it("clamps the commercial weight into 0-100", () => {
    assert.equal(clampWeight(4000), 100);
    assert.equal(clampWeight(-5), 0);
    assert.equal(clampWeight(66.6), 67);
    assert.equal(clampWeight("high"), 0);
    assert.equal(clampWeight(Number.NaN), 0);
    assert.equal(clampWeight(Number.POSITIVE_INFINITY), 0);
    assert.equal(finding({ commercial_weight: 5000 })?.commercialWeight, 100);
  });

  it("degrades an unknown severity to low rather than to informational", () => {
    // "informational" asserts the finding does not matter, which is a stronger
    // claim than a missing field can support.
    assert.equal(finding({ severity: "catastrophic" })?.severity, "low");
    assert.equal(finding({ severity: 3 })?.severity, "low");
    assert.equal(finding({})?.severity, "low");
    assert.equal(finding({ severity: "critical" })?.severity, "critical");
  });

  it("defaults an unknown claim type to presence, never to absence", () => {
    assert.equal(finding({ claim_type: "guess" })?.claimType, "presence");
    assert.equal(finding({})?.claimType, "presence");
    assert.equal(finding({ claim_type: "absence" })?.claimType, "absence");
  });

  it("defaults an unknown stage to landing", () => {
    assert.equal(finding({ stage: "email" })?.stage, "landing");
    assert.equal(finding({ stage: "post_booking" })?.stage, "post_booking");
  });

  it("drops citations that point at nothing or quote nothing", () => {
    const parsed = finding({
      citations: [
        { page: "landing", field: "buttons[0].text", quote: "Book a call" },
        { page: "landing", field: "", quote: "orphan" },
        { page: "landing", field: "buttons[1].text" },
        "a bare string",
        null,
      ],
    });
    assert.equal(parsed?.citations.length, 1);
    assert.equal(parsed?.citations[0]?.field, "buttons[0].text");
  });

  it("defaults a citation's page from the finding's stage", () => {
    const landing = finding({ citations: [{ field: "title", quote: "x" }] });
    assert.equal(landing?.citations[0]?.page, "landing");

    const post = finding({ stage: "post_booking", citations: [{ field: "title", quote: "x" }] });
    assert.equal(post?.citations[0]?.page, "post_booking");
  });

  it("reads the stated search space, in either casing, with indices stripped", () => {
    // The roots are what makes an absence claim checkable at all, so a model
    // that answers with a path rather than a root is met halfway rather than
    // refused — but nothing is invented for one that answers with nothing.
    const parsed = parseFunnelAnalysis({
      findings: [
        { id: "a", absence_over: ["paragraphs[3].text", "visible_text", "paragraphs", "  ", 7] },
        { id: "b", absenceOver: ["images"] },
        { id: "c" },
        { id: "d", absence_over: "paragraphs" },
      ],
    });
    assert.deepEqual(parsed?.findings[0]?.absenceOver, ["paragraphs.text", "visible_text", "paragraphs"]);
    assert.deepEqual(parsed?.findings[1]?.absenceOver, ["images"]);
    assert.deepEqual(parsed?.findings[2]?.absenceOver, []);
    assert.deepEqual(parsed?.findings[3]?.absenceOver, []);
  });

  it("accepts camelCase keys as well as snake_case", () => {
    const parsed = finding({ claimType: "absence", commercialWeight: 40 });
    assert.equal(parsed?.claimType, "absence");
    assert.equal(parsed?.commercialWeight, 40);
  });
});

describe("finding ids", () => {
  it("slugifies whatever the model called it", () => {
    assert.equal(slugify("No Pre-Call Material!"), "no-pre-call-material");
    assert.equal(slugify("  Café  Offer  "), "cafe-offer");
    assert.equal(slugify("!!!"), "");
  });

  it("makes ids unique within the run, because they are React keys", () => {
    const result = parseFunnelAnalysis({
      findings: [{ id: "weak cta" }, { id: "Weak CTA" }, { id: "weak-cta" }],
    });
    const ids = result?.findings.map((entry) => entry.id) ?? [];
    assert.deepEqual(ids, ["weak-cta", "weak-cta-2", "weak-cta-3"]);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("falls back to the title, then to a positional id", () => {
    const result = parseFunnelAnalysis({
      findings: [{ title: "The offer is unclear" }, {}],
    });
    assert.equal(result?.findings[0]?.id, "the-offer-is-unclear");
    assert.equal(result?.findings[1]?.id, "finding-2");
  });
});

describe("the rest of the result", () => {
  it("coerces the classification defensively", () => {
    const result = parseFunnelAnalysis({
      findings: [],
      classification: {
        funnel_type: "vsl",
        value_proposition: { clarity: "vague", statement: "  " },
        is_vsl: "yes",
        booking_step_visible: true,
      },
    });
    assert.equal(result?.classification.funnelType, "vsl");
    assert.equal(result?.classification.valueProposition.clarity, "vague");
    assert.equal(result?.classification.valueProposition.statement, null);
    // "yes" is not true. Anything but a real boolean stays false.
    assert.equal(result?.classification.isVsl, false);
    assert.equal(result?.classification.bookingStepVisible, true);
    assert.equal(result?.classification.pageType, null);
  });
});
