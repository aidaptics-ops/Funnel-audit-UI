import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StageTimer } from "../src/lib/stage-timer";

describe("StageTimer", () => {
  function fakeClock(steps: number[]): () => number {
    let i = 0;
    return () => steps[Math.min(i++, steps.length - 1)]!;
  }

  it("records a stage's duration", async () => {
    const timer = new StageTimer("run", fakeClock([0, 100, 350, 350]));
    await timer.time("crawl", async () => "ok");
    assert.deepEqual(timer.timings(), [{ stage: "crawl", ms: 250 }]);
  });

  it("still records a stage that threw", async () => {
    const timer = new StageTimer("run", fakeClock([0, 100, 400, 400]));
    await assert.rejects(timer.time("analysis", async () => { throw new Error("boom"); }));
    assert.deepEqual(timer.timings(), [{ stage: "analysis", ms: 300 }]);
  });

  it("summarises every stage with the total", async () => {
    const timer = new StageTimer("funnel", fakeClock([0, 0, 2000, 2000, 5000, 8000]));
    await timer.time("crawl", async () => null);
    await timer.time("email", async () => null);
    const line = timer.summary();
    assert.ok(line.startsWith("[timing] funnel total="), line);
    assert.ok(line.includes("crawl=2.0s"), line);
    assert.ok(line.includes("email=3.0s"), line);
  });

  it("accepts a duration measured elsewhere", () => {
    const timer = new StageTimer("run", fakeClock([0, 0]));
    timer.record("identity", 4200);
    assert.deepEqual(timer.timings(), [{ stage: "identity", ms: 4200 }]);
  });
});
