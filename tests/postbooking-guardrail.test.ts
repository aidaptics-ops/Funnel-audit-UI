import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateGeneratedEmail } from "../src/lib/email/validate";
import type { EmailContext } from "../src/lib/email/context";
import type { NormalizedIssue } from "../src/lib/audit/normalize";

/**
 * The TRUE branches of the post-booking guardrail split.
 *
 * `tests/guardrails.test.ts` and `tests/voice.test.ts` already cover the
 * FALSE branch (nothing supplied -> everything about the second page is
 * blocked). This file covers what changed: the page-description rule stands
 * down whenever the operator has supplied a screenshot (`sawItHimself`),
 * while the rule against describing anything AFTER the page — an email, a
 * call, a CRM entry — never does, no matter how many screenshots exist.
 */

function finding(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "pb-1",
    stage: "post_booking",
    claimType: "presence",
    severity: "medium",
    category: "confirmation",
    title: "No next-step guidance",
    description: "The confirmation page has nothing telling the visitor what to expect before the call.",
    evidence: [],
    citations: ["screenshot"],
    recommendation: "Add a short prep list.",
    impact: null,
    confidence: 0.8,
    commercialWeight: 20,
    ...overrides,
  } as NormalizedIssue;
}

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
    evidence: ["headline: Book your free audit", "[post-booking] no headings read"],
    unobserved: [],
    operatorPerformedAction: false,
    suppliedPages: [],
    postBookingFindings: [finding()],
    ...overrides,
  } as unknown as EmailContext;
}

const email = (body: string) => ({ subject: "Quick note", email: body, angle: "", personalization_points: [] });

describe("OBSERVED_PAGE_TOPIC stands down once a screenshot has been supplied", () => {
  it("allows a description of the confirmation page once the operator supplied a screenshot", () => {
    const result = validateGeneratedEmail(
      email("Your confirmation page is just a bare calendar embed with nothing else on it."),
      context({ suppliedPages: ["confirmation page"] }),
    );
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.ok(!kinds.includes("post_booking_claim"), `should not have flagged: ${kinds.join(",")}`);
  });

  it("still blocks the page description with no screenshot, whatever the findings say", () => {
    // A finding citing the post-booking page proves nothing on its own here —
    // `verify.ts` already required a screenshot to keep it in the first
    // place, but `validate.ts` deliberately does not re-derive trust from
    // that; it reads `suppliedPages` alone.
    const result = validateGeneratedEmail(
      email("Your confirmation page is just a bare calendar embed with nothing else on it."),
      context({ suppliedPages: [] }),
    );
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.ok(kinds.includes("post_booking_claim"), "should still be flagged with no supplied screenshot");
  });

  it("still allows raising the same topic as an opportunity rather than a description", () => {
    const result = validateGeneratedEmail(
      email("There's a missed opportunity on your confirmation page to pre-handle objections."),
      context({ suppliedPages: [] }),
    );
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.ok(!kinds.includes("post_booking_claim"), "the opportunity frame must still exempt this either way");
  });

  it("still allows the topic raised as a question", () => {
    const result = validateGeneratedEmail(
      email("Out of curiosity, is your confirmation page just a calendar embed?"),
      context({ suppliedPages: [] }),
    );
    assert.equal(result.hardViolations.length, 0);
  });
});

describe("UNOBSERVED_STAGE_TOPIC never stands down", () => {
  it("still rejects a claim about a confirmation email even with a screenshot supplied", () => {
    const result = validateGeneratedEmail(
      email("There is no follow-up email once someone books, and your confirmation email never even mentions the call."),
      context({ suppliedPages: ["confirmation page"] }),
    );
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.ok(kinds.includes("post_booking_claim"), "an email/sequence claim must stay blocked no matter what");
  });

  it("still rejects a claim about the call itself even with a screenshot supplied", () => {
    const result = validateGeneratedEmail(
      email("During the call itself there is nothing preparing them for the pitch."),
      context({ suppliedPages: ["confirmation page"] }),
    );
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.ok(kinds.includes("post_booking_claim"), "a claim about the call must stay blocked no matter what");
  });

  it("still rejects a claim about a CRM entry or reminder email even with a screenshot supplied", () => {
    for (const body of [
      "Nothing about their answers ever makes it into your CRM.",
      "There's no reminder email before the call.",
    ]) {
      const result = validateGeneratedEmail(email(body), context({ suppliedPages: ["confirmation page"] }));
      const kinds = result.hardViolations.map((violation) => violation.kind);
      assert.ok(kinds.includes("post_booking_claim"), `should still be flagged: ${body}`);
    }
  });

  it("still allows the same stage raised as an opportunity", () => {
    const result = validateGeneratedEmail(
      email("There's room to add a reminder email that actually references what they answered on the form."),
      context({ suppliedPages: ["confirmation page"] }),
    );
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.ok(!kinds.includes("post_booking_claim"), "OPPORTUNITY_FRAME must still exempt an unobserved-stage claim");
  });
});

describe("unrelated rules are unaffected by the split", () => {
  it("still rejects an invented metric on the supplied post-booking page", () => {
    const result = validateGeneratedEmail(
      email("Your confirmation page is losing 40% of visitors before they even see the calendar."),
      context({ suppliedPages: ["confirmation page"] }),
    );
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.ok(kinds.includes("invented_metric"), "seeing the page proves what is on it, not the prospect's numbers");
  });
});
