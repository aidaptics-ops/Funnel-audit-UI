import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGeneratedEmail, validateGeneratedEmail } from "../src/lib/email/validate";
import type { EmailContext } from "../src/lib/email/context";

/**
 * These test the mechanism that stops the AI asserting things the audit never
 * saw. The prompt asks the model to behave; this is what checks that it did.
 */

function context(overrides: Partial<EmailContext> = {}): EmailContext {
  return {
    audit: {
      observability: {
        scope: "landing_only",
        postBookingObserved: false,
        formSubmissionObserved: false,
        postBookingStatus: "not_supplied",
        bookingStepVisible: true,
        notes: [],
      },
    },
    profile: null,
    examples: [],
    observations: [],
    evidence: ["headline: Book your free audit", "3 CTA(s), 1 above the fold", "pricing detected: false"],
    unobserved: ["Nothing after conversion was observed."],
    ...overrides,
  } as unknown as EmailContext;
}

function email(body: string, subject = "Quick note") {
  return { subject, email: body, angle: "", personalization_points: [] };
}

describe("invented metrics", () => {
  it("rejects a percentage that is not in the evidence", () => {
    const result = validateGeneratedEmail(email("You're losing 40% of visitors at the form."), context());
    assert.equal(result.hardViolations.length, 1);
    assert.equal(result.hardViolations[0]!.kind, "invented_metric");
  });

  it("rejects unhedged money and multiplier claims", () => {
    for (const body of [
      "This is costing you $10,000 a month.",
      "This will get you 3x more bookings.",
      "That gap costs thousands of dollars every month.",
    ]) {
      const result = validateGeneratedEmail(email(body), context());
      assert.ok(result.hardViolations.length > 0, `should have flagged: ${body}`);
    }
  });

  it("allows the same figure when it is hedged, but flags it for review", () => {
    // The client genuinely writes this way ("I've seen this lift show up rates
    // by 5-10%"), so a hedged prediction is style, not a fabricated measurement.
    const result = validateGeneratedEmail(email("You could get 3x more bookings from this."), context());
    assert.deepEqual(result.hardViolations, []);
    assert.ok(result.violations.some((violation) => violation.kind === "unhedged_estimate"));
  });

  it("allows a number that genuinely appears in the evidence", () => {
    const ctx = context({ evidence: ["social proof: 0 testimonials", "form has 7 fields", "50% off is on the page"] });
    const result = validateGeneratedEmail(email("The page says 50% off but the button says Submit."), ctx);
    assert.equal(result.hardViolations.length, 0);
  });
});

describe("post-booking claims", () => {
  it("rejects an assertion about what happens after booking", () => {
    for (const body of [
      "After they book, there's no confirmation of what to prepare.",
      "Your thank-you page is missing the next steps.",
      "There is no follow-up email once someone books.",
    ]) {
      const result = validateGeneratedEmail(email(body), context());
      const kinds = result.hardViolations.map((violation) => violation.kind);
      assert.ok(kinds.includes("post_booking_claim"), `should have flagged: ${body}`);
    }
  });

  it("allows the same topic raised as a question", () => {
    const result = validateGeneratedEmail(
      email("Out of curiosity, what happens after someone books — do they get anything to prepare with?"),
      context(),
    );
    assert.equal(result.hardViolations.length, 0);
  });

  it("allows a plain observation about the visible booking step", () => {
    const result = validateGeneratedEmail(
      email("The booking widget sits below three scrolls of copy."),
      context(),
    );
    assert.equal(result.hardViolations.length, 0);
  });
});

describe("unobserved business facts", () => {
  it("rejects claims about traffic, spend and conversion rate", () => {
    for (const body of [
      "Your ad spend is going to waste here.",
      "With your traffic that adds up fast.",
      "Your conversion rate is probably suffering.",
    ]) {
      const result = validateGeneratedEmail(email(body), context());
      assert.ok(result.hardViolations.length > 0, `should have flagged: ${body}`);
    }
  });
});

describe("tone and placeholders", () => {
  it("flags audit-report phrasing as a soft violation", () => {
    const result = validateGeneratedEmail(email("I ran an audit and found 8 issues on your page."), context());
    const kinds = result.violations.map((violation) => violation.kind);
    assert.ok(kinds.includes("audit_report_tone") || kinds.includes("invented_metric"));
  });

  it("rejects an unfilled placeholder", () => {
    const result = validateGeneratedEmail(email("Hi [Name], quick thought on your page."), context());
    assert.ok(result.hardViolations.some((violation) => violation.kind === "placeholder"));
  });

  it("passes a clean, evidence-only email", () => {
    const result = validateGeneratedEmail(
      email("Hey — the headline promises a free audit but the button just says Submit. Worth a quick reply?"),
      context(),
    );
    assert.deepEqual(result.violations, []);
  });
});

describe("parsing model output", () => {
  it("accepts the documented shape", () => {
    const parsed = parseGeneratedEmail({
      subject: "s",
      email: "b",
      angle: "a",
      personalization_points: ["one", 2, ""],
    });
    assert.ok(parsed);
    assert.deepEqual(parsed!.personalization_points, ["one"]);
  });

  it("rejects output missing a subject or body", () => {
    assert.equal(parseGeneratedEmail({ subject: "only" }), null);
    assert.equal(parseGeneratedEmail(null), null);
    assert.equal(parseGeneratedEmail("not an object"), null);
  });
});
