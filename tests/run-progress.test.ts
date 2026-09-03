import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectRun, formatDuration, TYPICAL_RUN_MS } from "../src/lib/run-progress";

describe("projectRun", () => {
  it("starts on the crawl", () => {
    assert.equal(projectRun(0).stage, "crawl");
    assert.equal(projectRun(5_000).stage, "crawl");
  });

  it("moves through the stages in the order they run", () => {
    assert.equal(projectRun(60_000).stage, "research");
    assert.equal(projectRun(215_000).stage, "email");
  });

  it("says it is overdue rather than counting down to zero", () => {
    const past = projectRun(TYPICAL_RUN_MS + 60_000);
    assert.equal(past.stage, "overdue");
    assert.equal(past.remainingMs, null, "no estimate is honest once the estimate is wrong");
  });

  it("never shows a full bar while the run is still going", () => {
    for (const elapsed of [0, 60_000, 215_000, TYPICAL_RUN_MS, TYPICAL_RUN_MS * 5]) {
      assert.ok(projectRun(elapsed).fraction < 1, `fraction hit 1 at ${elapsed}ms`);
    }
  });

  it("keeps the remaining estimate falling while it is still valid", () => {
    const early = projectRun(10_000).remainingMs!;
    const later = projectRun(100_000).remainingMs!;
    assert.ok(later < early, "the estimate should shrink as the run proceeds");
  });

  it("treats a negative elapsed as zero rather than going backwards", () => {
    assert.equal(projectRun(-5_000).stage, "crawl");
    assert.ok(projectRun(-5_000).fraction >= 0);
  });
});

describe("formatDuration", () => {
  it("reads as seconds under a minute", () => {
    assert.equal(formatDuration(48_000), "48s");
  });
  it("pads the seconds past a minute", () => {
    assert.equal(formatDuration(134_000), "2m 14s");
    assert.equal(formatDuration(125_000), "2m 05s");
  });
  it("never shows a negative", () => {
    assert.equal(formatDuration(-1000), "0s");
  });
});
