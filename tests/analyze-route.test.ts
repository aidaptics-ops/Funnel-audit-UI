import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppError } from "../src/lib/errors";
import type { AuditResult, RunAuditOptions } from "../src/lib/audit/client";
import type { RawAnalysis } from "../src/lib/audit/types";
import type { FunnelAnalysisInput, FunnelAnalysisOutcome } from "../src/lib/analysis/analyze";
import type { RenderedEvidence } from "../src/lib/analysis/evidence";
import type { FunnelAnalysisResult } from "../src/lib/analysis/schema";
import type { VerifiedFinding } from "../src/lib/analysis/verify";
import {
  EMAIL_BLOCKED_MESSAGE,
  decideEmailGate,
  guardFunnelUrl,
  runFunnelPipeline,
  type FunnelPipelineDeps,
} from "../src/lib/analysis/orchestrate";
import { normalizeFunnelUrl } from "../src/lib/url";

/**
 * What /api/analyze does, tested where the decisions actually live.
 *
 * The route module itself imports `server-only`, which throws the moment the
 * test runner loads it, so the decisions were lifted into `orchestrate.ts` and
 * the route reduced to wiring. These drive that module with fake effects.
 *
 * There is no second URL any more — the page after conversion is never
 * crawled. The only source of post-booking evidence is a screenshot count
 * `deps.suppliedPostBooking` reports, and that is what these pin: the gate
 * opens on it alone, a landing page failure is still fatal, and a model that
 * fails degrades loudly rather than quietly.
 */

const LANDING = "https://example.com/offer";

/* --------------------------------- fixtures ------------------------------- */

function landingAnalysis(overrides: Partial<RawAnalysis> = {}): RawAnalysis {
  return {
    funnel: { requested_url: LANDING, final_url: LANDING, domain: "example.com" },
    page: { title: "Book a call", final_url: LANDING, http_status: 200 },
    hero: { headline: "Book a strategy call" },
    observed_issues: [
      {
        id: "NO_GUARANTEE",
        severity: "medium",
        category: "offer",
        title: "No guarantee is offered",
        evidence: ["Nothing on the page reverses the buyer's risk."],
      },
    ],
    raw_evidence: {
      title: "Book a call",
      url: { requested: LANDING, final: LANDING, http_status: 200 },
      headings: [{ level: 1, text: "Book a strategy call" }],
    },
    ...overrides,
  };
}

function auditResult(analysis: RawAnalysis, url: string): AuditResult {
  return { jobId: "job-1", requestedUrl: url, analysis, elapsedMs: 10 };
}

function renderedEvidence(role: "landing" | "post_booking"): RenderedEvidence {
  return { role, captured: true, text: "", index: new Map(), completeness: new Map() };
}

function verifiedFinding(overrides: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    id: "headline-does-not-name-the-buyer",
    stage: "landing",
    claimType: "presence",
    title: "The headline does not say who this is for",
    description: "It promises a call without naming the person who should book it.",
    severity: "high",
    category: "copy",
    commercialWeight: 70,
    citations: [{ page: "landing", field: "headings[0].text", quote: "Book a strategy call" }],
    rejectedCitations: [],
    absenceOver: [],
    recommendation: "Name the audience in the first line.",
    impact: null,
    ...overrides,
  };
}

function analysisResult(overrides: Partial<FunnelAnalysisResult> = {}): FunnelAnalysisResult {
  return {
    findings: [],
    classification: {
      funnelType: "consultation_booking",
      pageType: "landing",
      conversionGoal: "book a call",
      primaryCta: "Book a strategy call",
      valueProposition: { clarity: "clear", statement: "A strategy call for founders." },
      offerClarity: "clear",
      isVsl: false,
      bookingStepVisible: true,
    },
    relationshipSummary: "Nothing to compare — no post-booking capture exists.",
    unverifiableNotes: [],
    ...overrides,
  };
}

function outcome(overrides: Partial<FunnelAnalysisOutcome> = {}): FunnelAnalysisOutcome {
  return {
    result: analysisResult(),
    verification: { kept: [verifiedFinding()], dropped: [] },
    landingEvidence: renderedEvidence("landing"),
    relationship: {} as FunnelAnalysisOutcome["relationship"],
    repaired: false,
    ...overrides,
  };
}

/** Records every call, so the ORDER and the COUNT can be asserted. */
interface Harness {
  deps: FunnelPipelineDeps<{ identity: string }>;
  analysed: FunnelAnalysisInput[];
}

function harness(
  options: {
    landing?: RawAnalysis;
    analysis?: FunnelAnalysisOutcome | null;
    screenshots?: number;
  } = {},
): Harness {
  const analysed: FunnelAnalysisInput[] = [];

  return {
    analysed,
    deps: {
      async runAudit(url: string, opts: RunAuditOptions): Promise<AuditResult> {
        assert.equal(opts.captureProfile, "full", "the landing page is captured in full");
        return auditResult(options.landing ?? landingAnalysis(), url);
      },
      async analyzeFunnel(input: FunnelAnalysisInput): Promise<FunnelAnalysisOutcome | null> {
        analysed.push(input);
        return options.analysis === undefined ? outcome() : options.analysis;
      },
      async suppliedPostBooking() {
        return Array.from({ length: options.screenshots ?? 0 }, (_, index) => ({
          label: `screenshot ${index + 1}`,
          mediaType: "image/png",
          data: "",
        }));
      },
      async identity(): Promise<{ identity: string }> {
        return { identity: "acme" };
      },
    },
  };
}

const landing = () => normalizeFunnelUrl(LANDING);

/* --------------------------------- the URL --------------------------------- */

describe("the landing URL is guarded", () => {
  it("refuses a private host", () => {
    assert.throws(() => guardFunnelUrl("http://127.0.0.1/offer"), (error: AppError) => error.code === "private_host");
    assert.throws(
      () => guardFunnelUrl("http://build.internal/offer"),
      (error: AppError) => error.code === "private_host",
    );
    // A bare "localhost" never reaches the private-host check: normalisation
    // refuses a hostname with no dot in it first. Same refusal, earlier.
    assert.throws(() => guardFunnelUrl("http://localhost:3000"), (error: AppError) => error.code === "invalid_url");
  });

  it("refuses the usual attacks", () => {
    for (const [bad, code] of [
      ["http://192.168.1.5/offer", "private_host"],
      ["http://metadata.google.internal/", "private_host"],
      ["javascript:alert(1)", "unsupported_scheme"],
      ["https://user:pass@example.com/offer", "credentials_not_allowed"],
      ["not a url", "invalid_url"],
    ] as const) {
      assert.throws(
        () => guardFunnelUrl(bad),
        (error: AppError) => error.code === code,
        `${bad} should be refused as ${code}`,
      );
    }
  });

  it("normalises a bare domain", () => {
    assert.equal(guardFunnelUrl("example.com/offer").href, "https://example.com/offer");
  });
});

/* --------------------------------- the gate ------------------------------- */

describe("the email gate", () => {
  it("blocks with no screenshot supplied", async () => {
    const h = harness({ screenshots: 0 });
    const run = await runFunnelPipeline(h.deps, landing());

    assert.equal(run.gate.allowed, false);
    assert.equal(run.gate.reason, "post_booking_evidence_required");
    assert.equal(run.gate.message, EMAIL_BLOCKED_MESSAGE);
    assert.ok(run.reasons.includes(EMAIL_BLOCKED_MESSAGE));
    // The run itself still completed and still has its findings.
    assert.equal(run.auditStatus, "complete");
    assert.ok(run.audit.issues.length > 0);
  });

  it("passes once the operator has supplied a screenshot", async () => {
    const h = harness({ screenshots: 1 });
    const run = await runFunnelPipeline(h.deps, landing());
    assert.equal(run.gate.allowed, true);
    assert.equal(run.gate.suppliedScreenshots, 1);
  });

  it("is the same decision, reachable by the route with no pipeline", () => {
    assert.equal(decideEmailGate(0).allowed, false);
    assert.equal(decideEmailGate(0).reason, "post_booking_evidence_required");
    assert.equal(decideEmailGate(0).message, EMAIL_BLOCKED_MESSAGE);
    assert.equal(decideEmailGate(1).allowed, true);
    assert.equal(decideEmailGate(2).allowed, true);
  });

  it("gives the same answer as the pipeline's own gate", async () => {
    const run = await runFunnelPipeline(harness({ screenshots: 3 }).deps, landing());
    assert.deepEqual(decideEmailGate(run.gate.suppliedScreenshots), run.gate);
  });
});

/* ------------------------------- the findings ----------------------------- */

describe("verified findings and the classification", () => {
  it("applies the model's findings, with the quotes as evidence", async () => {
    const run = await runFunnelPipeline(harness().deps, landing());

    assert.equal(run.audit.issues.length, 1);
    const issue = run.audit.issues[0]!;
    assert.equal(issue.id, "headline-does-not-name-the-buyer");
    assert.equal(issue.severity, "high");
    assert.equal(issue.commercialWeight, 70);
    assert.deepEqual(issue.evidence, [{ text: "Book a strategy call", page: "landing" }]);
    assert.deepEqual(issue.citations, ["headings[0].text"]);
    // The crawler's own issue is gone: the model path replaced it, it did not
    // get appended to it.
    assert.equal(run.audit.issues.some((entry) => entry.id === "NO_GUARANTEE"), false);
  });

  it("takes the classification and rebuilds what depends on it", async () => {
    const run = await runFunnelPipeline(harness().deps, landing());

    assert.equal(run.audit.funnelType, "consultation_booking");
    assert.equal(run.audit.conversionGoal, "book a call");
    assert.equal(run.audit.primaryCta, "Book a strategy call");
    assert.equal(run.audit.valueProposition.clarity, "clear");
    assert.equal(run.audit.offer.clarity, "clear");
    // The markup showed no scheduler; the model looked at the screenshot and
    // saw one. The observability notes have to follow, not just the flag.
    assert.equal(run.audit.hasScheduler, true);
    assert.equal(run.audit.observability.bookingStepVisible, true);
    assert.ok(run.audit.observability.notes.some((note) => note.includes("scheduler")));
  });

  it("carries the supplied-screenshot count into observability, alongside the classification", async () => {
    const run = await runFunnelPipeline(harness({ screenshots: 1 }).deps, landing());
    assert.equal(run.audit.observability.postBookingObserved, true);
    assert.equal(run.audit.observability.postBookingStatus, "supplied");
  });

  it("drops nothing the verifier already dropped", async () => {
    const h = harness({
      analysis: outcome({
        verification: {
          kept: [],
          dropped: [
            {
              finding: verifiedFinding({ id: "invented" }),
              reason: "no_verified_citation",
              detail: "None of its 1 citation(s) could be found in the evidence they named.",
              citations: [],
            },
          ],
        },
      }),
    });

    const run = await runFunnelPipeline(h.deps, landing());
    assert.equal(run.audit.issues.some((issue) => issue.id === "invented"), false);
  });

  it("sends the analysis call the operator's supplied screenshots, not a crawled second page", async () => {
    const h = harness({ screenshots: 2 });
    await runFunnelPipeline(h.deps, landing());
    assert.equal(h.analysed.length, 1);
    assert.equal(h.analysed[0]?.suppliedPostBooking.length, 2);
  });
});

/* ------------------------------- degrading -------------------------------- */

describe("degrading, explicitly", () => {
  it("falls back to the crawler's own issues when the analysis returns null", async () => {
    const h = harness({ analysis: null });
    const run = await runFunnelPipeline(h.deps, landing());

    assert.equal(run.degraded, "analysis_unavailable");
    assert.equal(run.auditStatus, "incomplete");
    assert.equal(run.analysis, null);
    // Zero model findings, and the legacy path carrying the run.
    assert.equal(run.audit.issues.length, 1);
    assert.equal(run.audit.issues[0]?.id, "NO_GUARANTEE");
    assert.equal(run.gate.allowed, false, "no screenshot exists on this run either way");
    assert.ok(run.reasons.some((reason) => reason.includes("did not complete")));
    assert.ok(
      run.audit.observability.notes.some((note) => note.includes("did not complete")),
      "the guardrails downstream read these notes, so the degrade is stated there too",
    );
  });

  it("a degraded analysis does not erase a supplied screenshot's own observability", async () => {
    // The model never got to classify the page, which has nothing to do with
    // whether the operator has uploaded a screenshot — that fact comes from
    // disk, independently, and markUnanalysed must not touch it.
    const h = harness({ analysis: null, screenshots: 1 });
    const run = await runFunnelPipeline(h.deps, landing());
    assert.equal(run.audit.observability.postBookingObserved, true);
    assert.equal(run.gate.allowed, true);
  });

  it("never invents a finding to fill the gap", async () => {
    const h = harness({ analysis: null, landing: landingAnalysis({ observed_issues: [] }) });
    const run = await runFunnelPipeline(h.deps, landing());
    assert.deepEqual(run.audit.issues, []);
  });

  it("does not call the model at all when the API returned no raw evidence", async () => {
    const rawLanding = landingAnalysis();
    delete rawLanding.raw_evidence;
    const h = harness({ landing: rawLanding });

    const run = await runFunnelPipeline(h.deps, landing());

    assert.equal(h.analysed.length, 0, "there is nothing to send it");
    assert.equal(run.degraded, "no_raw_evidence");
    assert.equal(run.auditStatus, "incomplete");
    assert.ok(run.reasons.some((reason) => reason.includes("did not return page evidence")));
  });
});

/* ------------------------------ the two legs ------------------------------ */

describe("the analysis and the identity chain", () => {
  it("runs them concurrently, as whole sequences", async () => {
    const order: string[] = [];
    const h = harness();

    const deps: FunnelPipelineDeps<{ identity: string }> = {
      ...h.deps,
      async analyzeFunnel(input) {
        order.push("analyse:start");
        // A real analysis call is a network round trip; a bare microtask
        // resolves faster than the identity chain's two, which would make
        // this assert an artifact of the mock rather than the pipeline.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        const result = await h.deps.analyzeFunnel(input);
        order.push("analyse:end");
        return result;
      },
      async identity() {
        order.push("identity:start");
        // Two awaits: the identity chain is discover-then-search, and the
        // point of racing sequences rather than steps is that BOTH of its
        // legs overlap the analysis, not just the fast one.
        await Promise.resolve();
        await Promise.resolve();
        order.push("identity:end");
        return { identity: "acme" };
      },
    };

    const run = await runFunnelPipeline(deps, landing());

    assert.deepEqual(run.identity, { identity: "acme" });
    // Both start before either finishes — the point of Promise.allSettled
    // over the two whole sequences, rather than running one after the other.
    assert.ok(order.indexOf("analyse:start") < order.indexOf("identity:end"));
    assert.ok(order.indexOf("identity:start") < order.indexOf("analyse:end"));
    assert.ok(
      order.indexOf("identity:end") < order.indexOf("analyse:end"),
      "the identity chain finishes while the analysis is still running",
    );
  });

  it("hands the identity chain a landing-only reading, exactly as before", async () => {
    let seen: { finalUrl: string; issues: number } | null = null;
    const h = harness();

    const run = await runFunnelPipeline(
      {
        ...h.deps,
        async identity(landingResult, provisional) {
          seen = { finalUrl: provisional.finalUrl, issues: provisional.issues.length };
          assert.equal(landingResult.analysis.page?.title, "Book a call", "the raw analysis reaches it untouched");
          return { identity: "acme" };
        },
      },
      landing(),
    );

    assert.deepEqual(seen, { finalUrl: LANDING, issues: 1 });
    // The provisional reading is not what the run returns: the final audit has
    // the model's findings attached.
    assert.equal(run.audit.issues[0]?.id, "headline-does-not-name-the-buyer");
  });
});
