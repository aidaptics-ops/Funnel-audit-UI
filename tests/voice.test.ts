import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parsePastedEmails } from "../src/lib/client-knowledge/ingest";
import { validateGeneratedEmail } from "../src/lib/email/validate";
import { findLongestReuse, stripBoilerplate } from "../src/lib/email/voice";
import type { EmailContext } from "../src/lib/email/context";
import type { ClientEmail } from "../src/lib/client-knowledge/types";

/**
 * These run against the client's REAL emails, so they encode his actual style
 * rather than my guess at it.
 */
const seedPath = join(dirname(fileURLToPath(import.meta.url)), "..", "seed", "client-emails.txt");
const SAMPLES: ClientEmail[] = parsePastedEmails(readFileSync(seedPath, "utf8"), { source: "seed" });

function context(overrides: Partial<EmailContext> = {}): EmailContext {
  return {
    audit: {
      observability: {
        scope: "single_landing_page",
        postBookingObserved: false,
        formSubmissionObserved: false,
        bookingStepVisible: true,
        notes: [],
      },
    },
    profile: null,
    examples: SAMPLES,
    observations: [],
    evidence: ["headline: Learn How to Flip Your First House", "1 form(s) detected", "pricing detected: false"],
    unobserved: ["Nothing after conversion was observed."],
    operatorPerformedAction: false,
    ...overrides,
  } as unknown as EmailContext;
}

const email = (body: string) => ({ subject: "Quick note", email: body, angle: "", personalization_points: [] });

describe("the seed library", () => {
  it("parses all eleven of the client's emails", () => {
    assert.equal(SAMPLES.length, 11);
    for (const sample of SAMPLES) {
      assert.ok(sample.body.length > 200, "each sample should be a full email");
    }
  });

  it("recognises the standing offer as boilerplate, not as content", () => {
    const withOffer = SAMPLES.find((sample) => /low hanging fruits/i.test(sample.body))!;
    const stripped = stripBoilerplate(withOffer.body);
    assert.doesNotMatch(stripped, /low hanging fruits/i);
    assert.doesNotMatch(stripped, /paid me \$750/i);
    // The actual observations must survive the strip.
    assert.ok(stripped.length > 300);
  });
});

describe("copy-paste detection", () => {
  it("flags an observation lifted verbatim from another prospect's email", () => {
    // A real paragraph from the Bill email, reused wholesale.
    const lifted =
      "Hey Dana — I was going through your page.\n\n" +
      "The second thing I noticed is that you're framing your bonuses, or \"gifts\" as something they'll receive for signing up. " +
      "I would reframe these as attendance bonuses.\n\nBest,";
    const result = validateGeneratedEmail(email(lifted), context());
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.ok(kinds.includes("copied_from_sample"), `expected copy detection, got ${kinds.join(",")}`);
  });

  it("does NOT flag the skeleton and the standing offer", () => {
    // Every structural phrase the client reuses on purpose.
    const skeleton = [
      "Hey Dana — I was going through your opt-in page and noticed a couple of things.",
      "",
      "The first thing I noticed is your form asks for a phone number before anyone knows what the call covers.",
      "",
      "The second thing I noticed is there are no testimonials anywhere on the page.",
      "",
      "There's another 5 low hanging fruits I spotted stunting your conversions and draining your returns on ad spend, I'm happy to break it down even further in a short loom audit.",
      "",
      "People like Alex Neilan, Dior Ray, and Gav Kwok paid me $750 for a similar audit but I'm happy to shoot it over to you for free.",
      "",
      "Best,",
    ].join("\n");

    const result = validateGeneratedEmail(email(skeleton), context());
    const kinds = result.hardViolations.map((violation) => violation.kind);
    assert.equal(kinds.includes("copied_from_sample"), false, `skeleton was flagged: ${JSON.stringify(result.hardViolations)}`);
    assert.equal(kinds.includes("invented_metric"), false, "the $750 credential is the client's own fact");
  });

  it("measures the longest shared run directly", () => {
    const lifted = SAMPLES[0]!.body.split("\n").find((line) => line.length > 200)!;
    assert.ok(findLongestReuse(lifted, SAMPLES).longestRun > 14);
    assert.ok(findLongestReuse("A completely unrelated sentence about badgers.", SAMPLES).longestRun < 5);
  });
});

describe("claimed conversion action", () => {
  const opener = "Hey Dana, I just booked a call with your team and noticed a problem with your page.";

  it("blocks the claim when the operator did not convert", () => {
    const result = validateGeneratedEmail(email(opener), context());
    assert.ok(result.hardViolations.some((violation) => violation.kind === "unverified_action_claim"));
  });

  it("allows it once the operator confirms they did", () => {
    const result = validateGeneratedEmail(email(opener), context({ operatorPerformedAction: true }));
    assert.equal(result.hardViolations.some((violation) => violation.kind === "unverified_action_claim"), false);
  });

  it("allows an opener that makes no such claim", () => {
    const result = validateGeneratedEmail(
      email("Hey — I was going through your opt-in page and noticed a couple of things."),
      context(),
    );
    assert.deepEqual(result.hardViolations, []);
  });

  it("blocks a first name that identity resolution never established", () => {
    // No identity on the context, so "Dana" came from nowhere.
    const result = validateGeneratedEmail(
      email("Hey Dana — I was going through your opt-in page."),
      context(),
    );
    assert.ok(result.hardViolations.some((violation) => violation.kind === "unverified_recipient_name"));
  });
});

describe("numbers, the way this client actually uses them", () => {
  it("blocks an unhedged claim about their current performance", () => {
    for (const body of [
      "You're losing 40% of visitors at the form.",
      "This is costing you $10,000 a month.",
      "Your conversion rate is 2%.",
    ]) {
      const result = validateGeneratedEmail(email(body), context());
      assert.ok(result.hardViolations.length > 0, `should have blocked: ${body}`);
    }
  });

  it("allows a hedged estimate, but flags it for review", () => {
    const result = validateGeneratedEmail(
      email("Your application form, which I believe is sitting below a 15% start rate, is draining budget."),
      context(),
    );
    assert.deepEqual(result.hardViolations, [], "a hedged estimate is the client's own style");
    assert.ok(result.violations.some((violation) => violation.kind === "unhedged_estimate"));
  });

  it("allows an experience-attributed lift", () => {
    const result = validateGeneratedEmail(
      email("I've seen this small shift increase show up rates by 5-10% because of the sunken cost effect."),
      context(),
    );
    assert.deepEqual(result.hardViolations, []);
  });

  it("still allows a number that is genuinely on the page", () => {
    const ctx = context({ evidence: ["page copy: 50% off today only"] });
    const result = validateGeneratedEmail(email("The page says 50% off but nothing states when it ends."), ctx);
    assert.deepEqual(result.hardViolations, []);
  });
});

describe("post-booking, with a client who talks about it constantly", () => {
  it("still blocks an unevidenced claim even though he raises it in most emails", () => {
    const result = validateGeneratedEmail(
      email("Your call confirmation page does nothing to pre-handle objections."),
      context(),
    );
    assert.ok(result.hardViolations.some((violation) => violation.kind === "post_booking_claim"));
  });

  it("allows him to raise it as a question", () => {
    const result = validateGeneratedEmail(
      email("Out of curiosity, what does your call confirmation page do to pre-handle objections?"),
      context(),
    );
    assert.deepEqual(result.hardViolations, []);
  });
});
