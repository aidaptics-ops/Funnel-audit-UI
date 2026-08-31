import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parsePastedEmails } from "../src/lib/client-knowledge/ingest";
import { greetingNameIn, validateGeneratedEmail } from "../src/lib/email/validate";
import { claimsConversionAction, findLongestReuse, stripBoilerplate } from "../src/lib/email/voice";
import type { EmailContext } from "../src/lib/email/context";
import type { ClientEmail, ClientProfile } from "../src/lib/client-knowledge/types";

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
  // A floor, not an exact count. The client adds emails to this file over
  // time, and a test that has to be edited every time one arrives is a test
  // that will eventually be deleted instead.
  it("parses every email in the seed file as a whole sample", () => {
    assert.ok(SAMPLES.length >= 16, `expected at least 16 samples, got ${SAMPLES.length}`);
    for (const sample of SAMPLES) {
      assert.ok(sample.body.length > 200, "each sample should be a full email");
    }
    // Separator handling is the thing that actually breaks on a new paste: a
    // sample that swallowed the next one would be several times normal length.
    for (const sample of SAMPLES) {
      assert.ok(sample.body.length < 6000, `sample looks like two emails merged: ${sample.body.slice(0, 60)}`);
    }
  });

  /**
   * The whole library has to survive the validator.
   *
   * This is the regression that prompted it: the client's later emails open
   * with a credential line carrying a percentage, close with a projected
   * result, and name the metric their fix moves. All three tripped hard
   * violations, which meant the generator was forbidden from writing in the
   * voice it was being asked to imitate. Any future paste that breaks this
   * should fail here rather than silently in production.
   */
  it("does not hard-reject the client's own emails", () => {
    const failures: string[] = [];
    for (const sample of SAMPLES) {
      // examples: [] because a sample is trivially a verbatim match for
      // itself; this test is about the evidence rules, not copy detection.
      const result = validateGeneratedEmail(
        email(sample.body),
        context({ operatorPerformedAction: true, examples: [] }),
      );
      for (const violation of result.hardViolations) {
        // The greeting rule needs a resolved identity, which a raw sample has
        // no way to carry. Every other rule must pass on his real writing.
        if (violation.kind === "unverified_recipient_name") continue;
        failures.push(`${sample.body.split("\n")[0]} → ${violation.kind}: ${violation.quote.slice(0, 90)}`);
      }
    }
    assert.deepEqual(failures, []);
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

/**
 * The newer register, which is now the dominant one in the library.
 *
 * Every case here was a real, verified failure before these tests existed:
 * the greeting guard and the conversion-action guard both returned null on
 * the bare-name / pronoun-less openers he now uses, which meant the two
 * highest-stakes checks in the product were silently switched off for the
 * exact format the generator is told to imitate.
 */
describe("the newer register", () => {
  it("reads the name out of a bare greeting", () => {
    assert.equal(greetingNameIn("Brian,\n\nJust booked a call..."), "Brian");
    assert.equal(greetingNameIn("Rob,\n\nJust got to the end..."), "Rob");
    assert.equal(greetingNameIn("Hey Andrew,\n\nI just booked..."), "Andrew");
  });

  it("does not mistake a bare greeting word for a name", () => {
    for (const opener of ["Hey,\n\nquick note", "Hi there,\n\nquick note", "Thanks,\n\nVlad"]) {
      assert.equal(greetingNameIn(opener), null, `should not be a name: ${JSON.stringify(opener)}`);
    }
  });

  it("catches an invented name in the bare format", () => {
    // The most damaging failure the product has: addressing a stranger by a
    // name nobody established. It has to fire whichever greeting shape is used.
    const result = validateGeneratedEmail(email("Brian,\n\nI was going through your page."), context());
    assert.ok(result.hardViolations.some((violation) => violation.kind === "unverified_recipient_name"));
  });

  it("catches a conversion claim with the pronoun dropped", () => {
    for (const opener of [
      "Just booked a strategy call with your team...",
      "Just bought the Daily Profits system...",
      "Just got to the end of your application...",
      "I just signed up for your workshop.",
    ]) {
      assert.ok(claimsConversionAction(opener), `should be caught: ${opener}`);
    }
  });

  it("does not fire on an innocent sentence that starts with the same verb", () => {
    assert.equal(claimsConversionAction("Signed up members get a discount on the page."), null);
  });

  it("lets a faithful copy of the new skeleton through the plagiarism check", () => {
    // The standing lines are meant to repeat. Before the boilerplate patterns
    // covered them, a draft that imitated the new voice correctly shared a
    // 29-word run with the library and was rejected as copied — so the better
    // the imitation, the surer the rejection.
    const draft = [
      "Dana,",
      "",
      "Just booked a call with your team...",
      "",
      "And I noticed you're doing a lot of things right, but I found something pretty critical that is wrecking your show up rate...",
      "",
      "(I work with offer owners increase their show up rate past 85% and decrease their cost per live call, so I have a good idea of what converts best)",
      "",
      "The first thing I noticed is the lack of an FAQ section on your page.",
      "",
      "The second problem I saw is the lack of pre-call consumption material.",
      "",
      "These 2 tweaks might sound simple but they will get you closer to a 85% show rate, but there's 5 others things too, and if you fix all of them... you would decrease your CAC while increasing your personal margins.",
      "",
      "i can break everything down in detail with a video if you want. Founders like Alex Neilan, Dior Ray, and Gav Kwok paid me $750 for a similar audit but I'm happy to shoot it over to you for free.",
      "",
      "let me know,",
      "-Vlad",
    ].join("\n");

    const reuse = findLongestReuse(draft, SAMPLES);
    assert.ok(reuse.longestRun < 14, `longest shared run was ${reuse.longestRun}: ${reuse.excerpt}`);
  });
});

describe("raising a stage the audit never reached", () => {
  it("allows an absence that the rendered page itself evidences", () => {
    // His own sentence, in all five recent emails. It names a missing category
    // of asset without locating it on any page nobody opened.
    const result = validateGeneratedEmail(
      email("The second problem I saw is the lack of pre-call consumption material."),
      context(),
    );
    assert.deepEqual(result.hardViolations, []);
  });

  it("allows a later stage raised as an opportunity", () => {
    // examples: [] isolates the downstream rule. This sentence is close to one
    // of his own, so the copy detector fires on it too — correctly, and for a
    // different reason than the one under test here.
    const result = validateGeneratedEmail(
      email("The second thing I noticed is a missed opportunity on your call confirmation page to pre-handle objections."),
      context({ examples: [] }),
    );
    assert.deepEqual(result.hardViolations, []);
  });

  it("still blocks a description of what is on that page", () => {
    for (const body of [
      "Your confirmation page is just a bare calendar embed.",
      "Your follow-up email doesn't reference their answers.",
      "After they book, there's nothing telling them what to prepare.",
    ]) {
      const result = validateGeneratedEmail(email(body), context());
      assert.ok(
        result.hardViolations.some((violation) => violation.kind === "post_booking_claim"),
        `should have been blocked: ${body}`,
      );
    }
  });
});

describe("guessing out loud", () => {
  it("rejects a hedged diagnosis outright", () => {
    for (const body of [
      "You might have a problem with your confirmation flow.",
      "I suspect your form is losing people.",
      "It could be that your headline is too vague.",
      "I'm guessing there is no FAQ below the fold.",
      "Chances are your prospects never see the testimonials.",
    ]) {
      const result = validateGeneratedEmail(email(body), context());
      assert.ok(
        result.hardViolations.some((violation) => violation.kind === "speculative_diagnosis"),
        `should have been rejected: ${body}`,
      );
    }
  });

  it("still allows a hedged NUMBER, which is a different thing entirely", () => {
    // Hedging the magnitude is required; hedging the finding is banned.
    const result = validateGeneratedEmail(
      email("I've seen this lift show up rates by 5-10% because the objection is already handled."),
      context(),
    );
    assert.deepEqual(result.hardViolations, []);
  });
});

/**
 * The committed profile is what a fresh deploy uses before anyone presses
 * Refresh, so it has to stay in step with the library it claims to describe.
 * When these fail the fix is to regenerate it — see docs/CLIENT-VOICE.md.
 */
describe("the committed profile", () => {
  const profile = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "seed", "client-profile.json"), "utf8"),
  ) as ClientProfile;

  it("was derived from the whole library", () => {
    assert.equal(
      profile.sampleCount,
      SAMPLES.length,
      `the profile describes ${profile.sampleCount} emails but the library holds ${SAMPLES.length}. Regenerate it: POST /api/client-profile, then copy the result into seed/client-profile.json.`,
    );
  });

  it("fills every field the prompt reads", () => {
    // A field added to the schema but never populated reaches the prompt as
    // "unknown", which is silent — the email just gets quietly worse.
    const empty = Object.entries(profile.diagnostic)
      .filter(([, value]) => value === null || (Array.isArray(value) && value.length === 0))
      .map(([key]) => key);
    assert.deepEqual(empty, [], `empty diagnostic fields: ${empty.join(", ")}`);
    assert.ok(profile.writing.tone && profile.writing.sign_off_style);
  });

  it("captured the newer register, not just the original eleven", () => {
    const blob = JSON.stringify(profile).toLowerCase();
    assert.match(blob, /let me know/, "the newer sign-off should appear somewhere in the profile");
    assert.match(blob, /pre-?call consumption|downstream|confirmation/, "the downstream habit should be described");
  });
});
