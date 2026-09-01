import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { downstreamAngles } from "../src/lib/email/context";
import type { NormalizedAudit } from "../src/lib/audit/normalize";

/**
 * The angles the email may raise about stages the audit never reached.
 *
 * The safety property under test is narrow and important: every angle must be
 * an opportunity anchored to something the page actually showed, and none of
 * them may assert a measured fact about the prospect. Get that wrong and the
 * generator has a licence to invent, phrased confidently.
 */
function audit(overrides: Partial<NormalizedAudit> = {}): NormalizedAudit {
  return {
    conversionGoal: null,
    funnelType: null,
    pageType: null,
    primaryCta: null,
    ctaCount: 2,
    videoCount: 1,
    pricingDetected: false,
    forms: [],
    offer: { product: null, audience: null, clarity: null },
    observability: {
      scope: "landing_only",
      postBookingObserved: false,
      formSubmissionObserved: false,
      postBookingStatus: "not_supplied",
      bookingStepVisible: false,
      notes: [],
    },
    ...overrides,
  } as unknown as NormalizedAudit;
}

describe("downstream angles", () => {
  it("offers pre-call material when the funnel books a call", () => {
    const angles = downstreamAngles(audit({ conversionGoal: "book a strategy call" }));
    assert.ok(angles.some((entry) => /pre-call/i.test(entry.angle)));
    assert.ok(angles.some((entry) => /confirmation step/i.test(entry.angle)));
  });

  it("suppresses only the confirmation-step angle once a screenshot has been supplied", () => {
    // Its whole premise — "a confirmation step exists but we cannot see it" —
    // is false the moment the operator has photographed that page. Asserting
    // it anyway would be a lie of omission.
    const angles = downstreamAngles(
      audit({
        conversionGoal: "book a strategy call",
        observability: { postBookingObserved: true } as never,
      }),
    );
    assert.ok(angles.some((entry) => /pre-call/i.test(entry.angle)), "the pre-call angle is unrelated and should stay");
    assert.equal(
      angles.some((entry) => /confirmation step/i.test(entry.angle)),
      false,
      "the confirmation-step angle's premise is now false and must be dropped",
    );
  });

  it("keeps the confirmation-step angle when no screenshot has been supplied yet", () => {
    const angles = downstreamAngles(
      audit({
        conversionGoal: "book a strategy call",
        observability: { postBookingObserved: false } as never,
      }),
    );
    assert.ok(angles.some((entry) => /confirmation step/i.test(entry.angle)));
  });

  it("recognises a booking funnel from a visible scheduler alone", () => {
    // The goal text can be anything; a scheduler on the page settles it.
    const angles = downstreamAngles(
      audit({
        conversionGoal: "get started",
        observability: {
          scope: "landing_only",
          postBookingObserved: false,
          formSubmissionObserved: false,
          postBookingStatus: "not_supplied",
          bookingStepVisible: true,
          notes: [],
        },
      }),
    );
    assert.ok(angles.length > 0);
    assert.ok(angles.some((entry) => /scheduler is visibly present/i.test(entry.anchor)));
  });

  it("stays quiet on a funnel with no stage after the page", () => {
    // The client raises no downstream angle on a plain content page, and
    // manufacturing one is exactly the invention this is meant to avoid.
    assert.deepEqual(downstreamAngles(audit({ conversionGoal: "read the article" })), []);
  });

  it("raises the form's answers only when there are enough to be worth reusing", () => {
    const few = downstreamAngles(audit({ forms: [{ fieldCount: 2, provider: "custom" }] } as never));
    assert.equal(few.some((entry) => /answers this form collects/i.test(entry.angle)), false);

    const many = downstreamAngles(audit({ forms: [{ fieldCount: 9, provider: "typeform" }] } as never));
    assert.ok(many.some((entry) => /answers this form collects/i.test(entry.angle)));
    assert.ok(many.some((entry) => /9-field typeform form/i.test(entry.anchor)));
  });

  it("never asserts a measured fact about the prospect", () => {
    const every = [
      ...downstreamAngles(audit({ conversionGoal: "book a call" })),
      ...downstreamAngles(audit({ conversionGoal: "buy the course", pricingDetected: true })),
      ...downstreamAngles(audit({ conversionGoal: "register for the webinar" })),
      ...downstreamAngles(audit({ forms: [{ fieldCount: 6, provider: "ghl" }] } as never)),
    ];
    assert.ok(every.length > 0, "expected some angles to check");

    for (const entry of every) {
      // No percentages, money or counts presented as the prospect's numbers.
      assert.doesNotMatch(entry.angle, /\d+\s?%|[$£€]\s?\d/, `angle carries a figure: ${entry.angle}`);
      // No claim about the contents of a page nobody loaded.
      assert.doesNotMatch(
        entry.angle,
        /\byour (?:confirmation|thank[- ]?you) page (?:is|does|has|lacks)\b/i,
        `angle describes an unseen page: ${entry.angle}`,
      );
    }
  });

  it("anchors every angle to something the audit actually saw", () => {
    for (const entry of downstreamAngles(audit({ conversionGoal: "book a call", ctaCount: 3 }))) {
      assert.ok(entry.anchor.trim().length > 20, `angle has no real anchor: ${entry.angle}`);
    }
  });
});
