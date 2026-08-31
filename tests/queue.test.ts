import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPending, toRun, STALE_ANALYSIS_MS } from "../src/lib/runs";
import { emptyRecord, queuedRecord, type FunnelRecord } from "../src/lib/sheets/types";

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
    const record = queuedRecord("https://example.com/offer?utm_source=fb", true);
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
