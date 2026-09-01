import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildObservability,
  evidenceText,
  normalizeAudit,
  normalizeLegacyIssues,
  type AuditFinding,
} from "../src/lib/audit/normalize";
import type { RawAnalysis } from "../src/lib/audit/types";

/**
 * The first test of this file, written while restructuring it.
 *
 * Roughly twenty-five landing-derived scalars are read by the prompt builder,
 * the evidence set and the sheet writer, and until now none of them had a test.
 * That is the actual risk in this change: a rename or a moved default here is
 * silent, and surfaces as an email that quietly stopped mentioning the offer.
 */

/**
 * A response with every section a real one carries, so the scalars below are
 * asserted against a shape the API actually produces rather than an empty
 * object that would pass on defaults alone.
 */
function rawAnalysis(overrides: Partial<RawAnalysis> = {}): RawAnalysis {
  return {
    schema_version: "2.0",
    analyzed_at: "2026-01-02T03:04:05.000Z",
    duration_ms: 18_400,
    funnel: {
      requested_url: "https://example.com/vsl",
      final_url: "https://example.com/vsl/",
      domain: "example.com",
      brand_name: { status: "detected", value: "Acme Coaching", confidence: 0.9 },
      funnel_type: { status: "detected", value: "vsl", confidence: 0.82 },
      page_type_classification: { page_type: "landing_page", confidence: 0.7 },
      primary_conversion_goal: { status: "detected", value: "book_a_call", confidence: 0.75 },
      business_identity: {
        organization_names: ["Acme Coaching LLC"],
        contact_emails: ["hello@example.com"],
        contact_phones: ["+1 555 0100"],
      },
    },
    page: {
      title: "Book a free strategy call",
      meta_description: "Learn how we do it.",
      final_url: "https://example.com/vsl/",
    },
    hero: {
      headline: "Scale past six figures",
      subheadline: "Without hiring a team",
      supporting_copy: ["Proven with 200 clients", "  ", "No retainers"],
      value_proposition: {
        status: "detected",
        value: { clarity: "clear", statement: "We scale coaching offers" },
        confidence: 0.8,
      },
    },
    copy: { word_count: 812, key_messages: ["Scale without hiring", ""] },
    videos: [{ provider: "youtube" }],
    vsl: { determination: { status: "detected", value: { video_index: 0 }, confidence: 0.9 } },
    ctas: [
      { text: "Book a call", above_fold: true, is_primary: true, destination: { kind: "scheduler" } },
      { text: "Learn more", above_fold: false, is_primary: false, destination: { kind: "anchor" } },
    ],
    forms: [
      {
        provider: "custom",
        integration: "unknown",
        field_count: 4,
        cta_text: "Apply now",
        location: { above_fold: false },
      },
    ],
    testimonials: [
      { text: "Changed my business", name: "Dana" },
      { text: "", name: "Nobody" },
    ],
    social_proof: {
      testimonial_count: 2,
      client_logos: [{}, {}, {}],
      ratings: [{}],
      numeric_claims: [{ text: "200 clients" }],
    },
    offer: {
      product: { status: "detected", value: "Coaching programme", confidence: 0.8 },
      audience: { status: "detected", value: "Coaches", confidence: 0.7 },
      mechanism: { status: "unknown", reason: "no mechanism stated" },
      benefits: ["More clients", ""],
      guarantee_present: false,
      clarity: { status: "detected", value: { clarity: "partial", missing: ["price"] }, confidence: 0.6 },
    },
    pricing: { detected: true },
    guarantees: { detected: true },
    urgency: { detected: true, evidence_quality: "explicit" },
    navigation: { nav_item_count: 5 },
    links: { broken: [{ url: "https://example.com/dead", status: 404 }, { url: "" }] },
    tracking: {
      detected: [{ vendor: "google_analytics" }, { vendor: "meta_pixel" }, {}],
      has_analytics: true,
      has_advertising_pixel: true,
      statements: ["Google Analytics is present on the rendered page."],
    },
    summary: {
      ctas: { total: 2, above_fold: 1, primary_text: "Book a call" },
      videos: { dom_count: 1 },
    },
    observed_issues: [
      {
        id: "NO_CTA_ABOVE_FOLD",
        severity: "high",
        category: "cta",
        title: "No CTA above the fold",
        description: "The first screen carries no call to action.",
        evidence: ["fold height 812px; first CTA at y=1420"],
        recommendation: "Move one CTA above the fold.",
        impact: "Visitors must scroll before they can act.",
        confidence: 0.8,
      },
    ],
    ...overrides,
  };
}

const META = { jobId: "job-1", requestedUrl: "https://example.com/vsl" };

describe("landing scalars", () => {
  const audit = normalizeAudit(rawAnalysis(), META);

  it("carries the run's own identity", () => {
    assert.equal(audit.jobId, "job-1");
    assert.equal(audit.schemaVersion, "2.0");
    assert.equal(audit.analyzedAt, "2026-01-02T03:04:05.000Z");
    assert.equal(audit.durationMs, 18_400);
  });

  it("carries the funnel identity", () => {
    assert.equal(audit.requestedUrl, "https://example.com/vsl");
    assert.equal(audit.finalUrl, "https://example.com/vsl/");
    assert.equal(audit.domain, "example.com");
    assert.equal(audit.brand, "Acme Coaching");
    assert.equal(audit.funnelType, "vsl");
    assert.equal(audit.funnelTypeConfidence, 0.82);
    assert.equal(audit.pageType, "landing_page");
    assert.equal(audit.conversionGoal, "book_a_call");
  });

  it("carries the page's own words", () => {
    assert.equal(audit.pageTitle, "Book a free strategy call");
    assert.equal(audit.metaDescription, "Learn how we do it.");
    assert.equal(audit.headline, "Scale past six figures");
    assert.equal(audit.subheadline, "Without hiring a team");
    assert.deepEqual(audit.valueProposition, { clarity: "clear", statement: "We scale coaching offers" });
    // Blank entries are dropped rather than shipped as empty evidence lines.
    assert.deepEqual(audit.supportingCopy, ["Proven with 200 clients", "No retainers"]);
    assert.deepEqual(audit.keyMessages, ["Scale without hiring"]);
    assert.equal(audit.wordCount, 812);
  });

  it("carries the offer, and leaves an undetermined part null", () => {
    assert.equal(audit.offer.product, "Coaching programme");
    assert.equal(audit.offer.audience, "Coaches");
    assert.equal(audit.offer.mechanism, null);
    assert.deepEqual(audit.offer.benefits, ["More clients"]);
    assert.equal(audit.offer.clarity, "partial");
    assert.deepEqual(audit.offer.missing, ["price"]);
  });

  it("carries the CTAs and prefers the summary's counts", () => {
    assert.equal(audit.ctas.length, 2);
    assert.deepEqual(audit.ctas[0], {
      text: "Book a call",
      aboveFold: true,
      isPrimary: true,
      destinationKind: "scheduler",
    });
    assert.equal(audit.primaryCta, "Book a call");
    assert.equal(audit.ctaCount, 2);
    assert.equal(audit.ctaAboveFoldCount, 1);
  });

  it("carries the forms and the scheduler heuristic", () => {
    assert.deepEqual(audit.forms, [
      { provider: "custom", integration: "unknown", fieldCount: 4, aboveFold: false, ctaText: "Apply now" },
    ]);
    // Kept deliberately: the model's classification does not exist on a run
    // whose analysis call failed, and a booking funnel reading as a
    // non-booking one is worse than a heuristic that occasionally misses.
    assert.equal(audit.hasScheduler, true);
  });

  it("recognises a scheduler from the form provider alone", () => {
    const audit = normalizeAudit(
      rawAnalysis({
        ctas: [{ text: "Get started", destination: { kind: "anchor" } }],
        forms: [{ provider: "calendly", field_count: 2 }],
      }),
      META,
    );
    assert.equal(audit.hasScheduler, true);
  });

  it("reports no scheduler when nothing points at one", () => {
    const audit = normalizeAudit(
      rawAnalysis({ ctas: [{ text: "Buy now", destination: { kind: "checkout" } }], forms: [] }),
      META,
    );
    assert.equal(audit.hasScheduler, false);
  });

  it("carries proof, media and the technical scalars", () => {
    assert.deepEqual(audit.proof, { testimonials: 2, logos: 3, ratings: 1, numericClaims: 1 });
    assert.deepEqual(audit.testimonials, [{ text: "Changed my business", name: "Dana" }]);
    assert.equal(audit.pricingDetected, true);
    assert.equal(audit.guaranteePresent, true);
    assert.equal(audit.urgencyDetected, true);
    assert.equal(audit.urgencyQuality, "explicit");
    assert.equal(audit.videoCount, 1);
    assert.equal(audit.isVsl, true);
    assert.deepEqual(audit.tracking.vendors, ["google_analytics", "meta_pixel"]);
    assert.equal(audit.tracking.hasAnalytics, true);
    assert.equal(audit.tracking.hasAdPixel, true);
    assert.deepEqual(audit.tracking.statements, ["Google Analytics is present on the rendered page."]);
    assert.equal(audit.navItemCount, 5);
    assert.deepEqual(audit.brokenLinks, ["https://example.com/dead"]);
    assert.deepEqual(audit.contact, {
      emails: ["hello@example.com"],
      phones: ["+1 555 0100"],
      organizations: ["Acme Coaching LLC"],
    });
  });

  it("survives a response with nothing in it", () => {
    const empty = normalizeAudit({}, META);
    assert.equal(empty.finalUrl, "https://example.com/vsl");
    assert.equal(empty.domain, "");
    assert.equal(empty.brand, null);
    assert.equal(empty.urgencyQuality, null);
    assert.deepEqual(empty.tracking.statements, []);
    assert.deepEqual(empty.issues, []);
    assert.equal(empty.observability.scope, "landing_only");
  });
});

describe("crawler verdicts that a later API build stops emitting", () => {
  it("prefers the stated urgency quality while the API still sends one", () => {
    const audit = normalizeAudit(
      rawAnalysis({ urgency: { detected: true, evidence_quality: "language_only", countdown_timers: [] } }),
      META,
    );
    assert.equal(audit.urgencyQuality, "language_only");
  });

  it("re-derives explicit urgency from a running timer", () => {
    const audit = normalizeAudit(
      rawAnalysis({ urgency: { detected: true, countdown_timers: [{ text: "02:14", visible: true }] } }),
      META,
    );
    assert.equal(audit.urgencyQuality, "explicit");
  });

  it("does not count a hidden timer or an undated deadline as explicit", () => {
    const audit = normalizeAudit(
      rawAnalysis({
        urgency: {
          detected: true,
          countdown_timers: [{ text: "02:14", visible: false }],
          deadlines: [{ text: "Doors close Friday", date_text: "Friday" }],
        },
      }),
      META,
    );
    assert.equal(audit.urgencyQuality, "language_only");
  });

  it("counts a dated deadline as explicit", () => {
    const audit = normalizeAudit(
      rawAnalysis({
        urgency: { detected: true, deadlines: [{ text: "Doors close March 3", date_text: "March 3" }] },
      }),
      META,
    );
    assert.equal(audit.urgencyQuality, "explicit");
  });

  it("reports none when the section is there and holds nothing", () => {
    const audit = normalizeAudit(rawAnalysis({ urgency: { detected: false } }), META);
    assert.equal(audit.urgencyQuality, "none");
  });

  it("rebuilds tracking statements from the vendor list when they are gone", () => {
    const audit = normalizeAudit(
      rawAnalysis({
        tracking: {
          detected: [{ vendor: "google_analytics" }],
          has_analytics: true,
          has_advertising_pixel: false,
        },
      }),
      META,
    );
    assert.deepEqual(audit.tracking.vendors, ["google_analytics"]);
    assert.equal(audit.tracking.statements.length, 2);
    assert.match(audit.tracking.statements[0]!, /google_analytics/);
    assert.match(audit.tracking.statements[1]!, /analytics tag/i);
  });

  it("keeps an explicitly empty statements list empty", () => {
    // Present-but-empty is the API saying "nothing to say", and inventing a
    // line there would change today's evidence set.
    const audit = normalizeAudit(
      rawAnalysis({ tracking: { detected: [{ vendor: "meta_pixel" }], statements: [] } }),
      META,
    );
    assert.deepEqual(audit.tracking.statements, []);
  });
});

describe("the legacy observed_issues fallback", () => {
  it("is used when no findings are supplied", () => {
    const audit = normalizeAudit(rawAnalysis(), META);
    assert.equal(audit.issues.length, 1);
    assert.equal(audit.issues[0]!.id, "NO_CTA_ABOVE_FOLD");
    assert.equal(audit.issues[0]!.stage, "landing");
    assert.equal(audit.issues[0]!.claimType, "presence");
    assert.deepEqual(audit.issues[0]!.citations, []);
    // The crawler's own weight table, unchanged: this path is the ONLY path
    // until the analysis call is wired through, and the first four issues are
    // the only ones the email may draw on.
    assert.equal(audit.issues[0]!.commercialWeight, 95);
    assert.deepEqual(audit.issues[0]!.evidence, [
      { text: "fold height 812px; first CTA at y=1420", page: "landing" },
    ]);
    assert.deepEqual(audit.issueCounts, { critical: 0, high: 1, medium: 0, low: 0, informational: 0 });
  });

  it("stands aside as soon as findings are available", () => {
    const audit = normalizeAudit(rawAnalysis(), {
      ...META,
      findings: [{ id: "CLAUDE_ONE", evidence: ["the confirmation page 404s"], commercial_weight: 90 }],
    });
    assert.deepEqual(audit.issues.map((issue) => issue.id), ["CLAUDE_ONE"]);
  });

  it("orders by commercial weight, exactly as it does in production today", () => {
    // The ordering is load-bearing: email/context.ts takes the first four and
    // the sheet records the first three. Re-sorting by severity alone drops a
    // tempered OFFER_CLARITY_UNCLEAR below every routine medium and opens the
    // email on a missing viewport tag.
    const issues = normalizeLegacyIssues([
      { id: "MISSING_TITLE", severity: "medium", evidence: ["a"] },
      { id: "MISSING_VIEWPORT_META", severity: "medium", evidence: ["b"] },
      { id: "OFFER_CLARITY_UNCLEAR", severity: "low", evidence: ["c"] },
      { id: "NO_VISIBLE_SOCIAL_PROOF", severity: "medium", evidence: ["d"] },
    ]);
    assert.deepEqual(issues.map((issue) => issue.id), [
      "OFFER_CLARITY_UNCLEAR",
      "NO_VISIBLE_SOCIAL_PROOF",
      "MISSING_VIEWPORT_META",
      "MISSING_TITLE",
    ]);
  });

  it("gives an unlisted issue the default weight plus its severity bonus", () => {
    const issues = normalizeLegacyIssues([
      { id: "SOMETHING_NEW", severity: "critical", evidence: ["a"] },
      { id: "SOMETHING_ELSE", severity: "informational", evidence: ["b"] },
    ]);
    assert.deepEqual(issues.map((issue) => issue.commercialWeight), [55, 10]);
  });

  it("drops an issue with no evidence at all", () => {
    // The strongest filter in this file: a finding nobody can point at is not
    // outreach material, and guessing what backed it is how emails invent.
    const issues = normalizeLegacyIssues([
      { id: "KEEP", severity: "high", evidence: ["a real observation"] },
      { id: "NO_EVIDENCE", severity: "critical" },
      { id: "BLANK_EVIDENCE", severity: "critical", evidence: ["", "   "] },
    ]);
    assert.deepEqual(issues.map((issue) => issue.id), ["KEEP"]);
  });

  it("drops an issue with no id, and a non-object", () => {
    const issues = normalizeLegacyIssues([
      { severity: "high", evidence: ["orphan"] },
      undefined as never,
      { id: "KEEP", severity: "high", evidence: ["real"] },
    ]);
    assert.deepEqual(issues.map((issue) => issue.id), ["KEEP"]);
  });

  it("degrades an unrecognised severity to informational, as it always has", () => {
    // Deliberately NOT the model path's "low". Severity decides both the
    // weight bonus and whether email/context.ts filters the issue out at all,
    // so changing it here would change which observations a live email is
    // built from — for a fallback that is doing all the work today.
    const issues = normalizeLegacyIssues([{ id: "ODD", severity: "catastrophic", evidence: ["seen"] }]);
    assert.equal(issues[0]!.severity, "informational");
  });

  it("falls back to the id when the issue carries no title", () => {
    const issues = normalizeLegacyIssues([{ id: "NO_TITLE", severity: "low", evidence: ["seen"] }]);
    assert.equal(issues[0]!.title, "NO_TITLE");
    assert.equal(issues[0]!.category, "other");
    assert.equal(issues[0]!.description, "");
    assert.equal(issues[0]!.impact, null);
  });
});

describe("model findings", () => {
  function findings(...items: AuditFinding[]): AuditFinding[] {
    return items;
  }

  it("clamps the commercial weight into 0-100", () => {
    const audit = normalizeAudit(rawAnalysis(), {
      ...META,
      findings: findings(
        { id: "OVER", evidence: ["a"], commercial_weight: 4000 },
        { id: "UNDER", evidence: ["b"], commercial_weight: -12 },
        { id: "MID", evidence: ["c"], commercial_weight: 61.4 },
        { id: "ABSENT", evidence: ["d"] },
      ),
    });
    const byId = new Map(audit.issues.map((issue) => [issue.id, issue.commercialWeight]));
    assert.equal(byId.get("OVER"), 100);
    assert.equal(byId.get("UNDER"), 0);
    assert.equal(byId.get("MID"), 61);
    assert.equal(byId.get("ABSENT"), 0);
    // And the order follows the weight, highest first.
    assert.deepEqual(audit.issues.map((issue) => issue.id), ["OVER", "MID", "UNDER", "ABSENT"]);
  });

  it("degrades an unrecognised severity to low", () => {
    const audit = normalizeAudit(rawAnalysis(), {
      ...META,
      findings: findings({ id: "ODD", severity: "showstopper", evidence: ["seen"] }),
    });
    assert.equal(audit.issues[0]!.severity, "low");
  });

  it("drops a finding with no evidence", () => {
    const audit = normalizeAudit(rawAnalysis(), {
      ...META,
      findings: findings({ id: "EMPTY", severity: "critical", evidence: [] }, { id: "KEPT", evidence: ["x"] }),
    });
    assert.deepEqual(audit.issues.map((issue) => issue.id), ["KEPT"]);
  });

  it("keeps the stage, claim type and citations, and tags evidence by page", () => {
    const audit = normalizeAudit(rawAnalysis(), {
      ...META,
      findings: findings({
        id: "DEAD_CONFIRMATION",
        stage: "post_booking",
        claim_type: "absence",
        severity: "critical",
        category: "conversion",
        title: "The confirmation page 404s",
        evidence: [
          "http_status 404",
          { text: "the CTA points at /thanks", page: "landing" },
          { text: "title reads Page Not Found", page: "post_booking" },
        ],
        citations: ["raw_evidence.url.http_status", "raw_evidence.links.items[3]"],
        commercial_weight: 98,
      }),
    });
    const issue = audit.issues[0]!;
    assert.equal(issue.stage, "post_booking");
    assert.equal(issue.claimType, "absence");
    assert.deepEqual(issue.citations, ["raw_evidence.url.http_status", "raw_evidence.links.items[3]"]);
    // A bare string inherits the finding's own stage; a tagged one keeps its tag.
    assert.deepEqual(issue.evidence.map((line) => line.page), ["post_booking", "landing", "post_booking"]);
    assert.deepEqual(issue.evidence.map(evidenceText), [
      "http_status 404",
      "the CTA points at /thanks",
      "title reads Page Not Found",
    ]);
  });

  it("defaults an unrecognised stage, claim type and evidence page to landing", () => {
    const audit = normalizeAudit(rawAnalysis(), {
      ...META,
      findings: findings({
        id: "ODD",
        stage: "somewhere_else",
        claim_type: "vibes",
        evidence: [{ text: "seen", page: "elsewhere" }],
      }),
    });
    assert.equal(audit.issues[0]!.stage, "landing");
    assert.equal(audit.issues[0]!.claimType, "presence");
    assert.deepEqual(audit.issues[0]!.evidence, [{ text: "seen", page: "landing" }]);
  });
});

describe("observability", () => {
  it("reports landing_only when no screenshot has been supplied", () => {
    const observability = buildObservability(false, false, 0);
    assert.equal(observability.scope, "landing_only");
    assert.equal(observability.postBookingObserved, false);
    assert.equal(observability.postBookingStatus, "not_supplied");
    assert.ok(observability.notes.some((note) => /No screenshot of the page after conversion/.test(note)));
    assert.ok(observability.notes.some((note) => /AFTER a visitor converts/.test(note)));
  });

  it("opens the guardrail once at least one screenshot has been supplied", () => {
    const observability = buildObservability(false, false, 2);
    assert.equal(observability.scope, "landing_and_post_booking");
    assert.equal(observability.postBookingObserved, true);
    assert.equal(observability.postBookingStatus, "supplied");
    assert.ok(observability.notes.some((note) => /operator supplied 2 screenshot/.test(note)));
    // The old unconditional claim must be gone: it is false on this run.
    assert.equal(
      observability.notes.some((note) => /No confirmation page, thank-you page/.test(note)),
      false,
    );
  });

  it("never reports a form as submitted, whatever else happened", () => {
    for (const count of [0, 1]) {
      const observability = buildObservability(true, true, count);
      assert.equal(observability.formSubmissionObserved, false);
      assert.ok(observability.notes.some((note) => /submitted nothing/.test(note)));
    }
  });

  it("names the scheduler and the form when they are visible", () => {
    const observability = buildObservability(true, true, 0);
    assert.equal(observability.bookingStepVisible, true);
    assert.ok(observability.notes.some((note) => /scheduler\/booking widget/.test(note)));
    assert.ok(observability.notes.some((note) => /never filled in or submitted/.test(note)));
  });

  it("is derived from how many screenshots exist at normalisation time", () => {
    const audit = normalizeAudit(rawAnalysis(), { ...META, suppliedScreenshotCount: 1 });
    assert.equal(audit.observability.scope, "landing_and_post_booking");
    assert.equal(audit.observability.postBookingObserved, true);
    assert.equal(audit.observability.postBookingStatus, "supplied");
  });
});
