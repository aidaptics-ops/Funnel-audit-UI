import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPending, toRun, STALE_ANALYSIS_MS, type RunAudit } from "../src/lib/runs";
import { emptyRecord, queuedRecord, type FunnelRecord } from "../src/lib/sheets/types";
import { compactAudit, CELL_LIMIT } from "../src/lib/sheets/compact";
import type { NormalizedAudit, NormalizedIssue } from "../src/lib/audit/normalize";

/**
 * Picking a queue back up after the tab that created it went away.
 *
 * The expensive mistake in both directions: forgetting work the operator
 * queued, or re-running a funnel that already finished and paying for it
 * twice. These pin both edges.
 */
function row(overrides: Partial<FunnelRecord> = {}): FunnelRecord {
  return { ...emptyRecord(), funnel_url: "https://example.com/offer", ...overrides };
}

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("a queued row", () => {
  it("is written with everything blank except what queueing knows", () => {
    const record = queuedRecord("https://example.com/offer?utm_source=fb", { performedAction: true });
    assert.equal(record.stage, "queued");
    assert.equal(record.audit_status, "queued");
    assert.equal(record.performed_action, "true");
    // Keyed the same way every other write keys it, or the analysis that
    // follows would append a second row instead of filling this one in.
    assert.equal(record.funnel_url, "https://example.com/offer");
    assert.equal(record.domain, "example.com");
    // Blank so the merging upsert lets the real analysis fill them later.
    assert.equal(record.audit_json, "");
    assert.equal(record.email_body, "");
  });

  it("is picked up as work still owed", () => {
    assert.equal(isPending(toRun(row({ stage: "queued" })), NOW), true);
  });

  it("carries the operator's conversion flag back", () => {
    assert.equal(toRun(row({ performed_action: "true" })).performedAction, true);
    assert.equal(toRun(row({ performed_action: "" })).performedAction, false);
  });
});

describe("a row that is already running", () => {
  it("is left alone while it is fresh", () => {
    const run = toRun(row({ stage: "analyzing", updated_at: ago(60_000) }));
    assert.equal(isPending(run, NOW), false, "another tab must not take a live run");
  });

  it("is reclaimed once it has clearly been abandoned", () => {
    const run = toRun(row({ stage: "analyzing", updated_at: ago(STALE_ANALYSIS_MS + 1000) }));
    assert.equal(isPending(run, NOW), true);
  });

  it("is reclaimed when its timestamp is unreadable", () => {
    const run = toRun(row({ stage: "analyzing", updated_at: "not a date" }));
    assert.equal(isPending(run, NOW), true);
  });
});

describe("never paying twice", () => {
  it("ignores a row that already produced an audit, whatever its stage says", () => {
    // Rows written before the stage column existed read as "queued". Re-running
    // them would spend real money reproducing what is already in the row.
    const run = toRun(row({ stage: "queued", audit_json: '{"headline":"Book a call"}' }));
    assert.equal(isPending(run, NOW), false);
  });

  it("ignores a row that already produced an email", () => {
    const run = toRun(row({ stage: "analyzing", updated_at: ago(STALE_ANALYSIS_MS * 4), email_subject: "quick note" }));
    assert.equal(isPending(run, NOW), false);
  });

  it("ignores finished and failed runs", () => {
    for (const stage of ["ready", "approved", "saved", "failed"]) {
      assert.equal(isPending(toRun(row({ stage })), NOW), false, `${stage} should not be re-run`);
    }
  });
});

/* --------------------------- the stored audit ---------------------------- */

function finding(index: number, size: number): NormalizedIssue {
  return {
    id: `finding-${index}`,
    stage: index % 2 === 0 ? "landing" : "post_booking",
    claimType: "presence",
    severity: "high",
    category: "conversion",
    title: `Finding number ${index}`,
    description: "d".repeat(size),
    evidence: [{ text: "e".repeat(size), page: "landing" }],
    citations: [`forms[0].fields[${index}].label — ${"q".repeat(400)}`],
    recommendation: "r".repeat(size),
    impact: null,
    confidence: 0.9,
    commercialWeight: 70,
  };
}

function audit(issues: NormalizedIssue[]): NormalizedAudit {
  return {
    finalUrl: "https://example.com/offer",
    domain: "example.com",
    brand: "Example",
    pageTitle: "Offer",
    headline: "Book a call",
    jobId: "job-1",
    analyzedAt: "2026-08-31T12:00:00.000Z",
    issues,
    observability: {
      scope: "landing_and_post_booking",
      postBookingObserved: true,
      formSubmissionObserved: false,
      bookingStepVisible: true,
      postBookingStatus: "supplied",
      notes: [],
    },
  } as unknown as NormalizedAudit;
}

/** Exactly what runs.ts does with the cell. A null here is a lost audit. */
function parseAudit(raw: string): RunAudit | null {
  if (!raw || !raw.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as RunAudit;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

describe("the audit, cut down to fit one cell", () => {
  it("carries the finding's stage, claim type, weight and first citation", () => {
    const stored = parseAudit(compactAudit(audit([finding(0, 20)])));
    const issue = stored?.issues?.[0];
    assert.equal(issue?.stage, "landing");
    assert.equal(issue?.claimType, "presence");
    assert.equal(issue?.commercialWeight, 70);
    assert.ok(issue?.citation?.startsWith("forms[0].fields[0].label"));
  });

  it("caps a citation quote at 160 characters", () => {
    const stored = parseAudit(compactAudit(audit([finding(0, 20)])));
    assert.equal(stored?.issues?.[0]?.citation?.length, 160);
  });

  it("STILL PARSES when the audit is far too big for the cell", () => {
    /*
     * The bug this pins, verified against the old code: the last line was
     * `leanJson.slice(0, CELL_LIMIT)`, which cuts the document mid-string.
     * parseAudit then threw, returned null, and the row silently lost its
     * ENTIRE stored audit — the size guard fired exactly when it destroyed
     * everything it was meant to protect.
     */
    const huge = compactAudit(audit(Array.from({ length: 400 }, (_, index) => finding(index, 300))));
    assert.ok(huge.length <= CELL_LIMIT, "must fit the cell");
    const stored = parseAudit(huge);
    assert.notEqual(stored, null, "a truncated document is a destroyed document");
    assert.equal(stored?.domain, "example.com", "the header survives");
  });

  it("drops whole findings from the tail and says how many went", () => {
    const stored = parseAudit(compactAudit(audit(Array.from({ length: 400 }, (_, i) => finding(i, 300)))));
    assert.ok((stored?.issues?.length ?? 0) < 400, "it cannot have kept them all");
    assert.ok((stored?.findings_omitted ?? 0) > 0, "the loss has to be stated, not hidden");
    // Whatever survived is a WHOLE finding, not the first half of one.
    for (const issue of stored?.issues ?? []) {
      assert.equal(typeof issue.title, "string");
      assert.equal(typeof issue.severity, "string");
    }
  });

  it("parses back at every rung of the ladder", () => {
    for (const count of [0, 1, 5, 40, 200, 400]) {
      const json = compactAudit(audit(Array.from({ length: count }, (_, i) => finding(i, 400))));
      assert.ok(json.length <= CELL_LIMIT, `${count} findings overflowed the cell`);
      assert.notEqual(parseAudit(json), null, `${count} findings produced unparseable JSON`);
    }
  });
});
