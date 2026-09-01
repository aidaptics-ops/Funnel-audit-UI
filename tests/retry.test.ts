import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryOnceIf } from "../src/lib/retry";

/**
 * The primitive behind the founder-research rate-limit retry (Fact 4).
 *
 * founder.ts and pipeline.ts both import "server-only" and so cannot be
 * loaded by this test runner at all (see analyze-route.test.ts's own comment
 * on the same problem for analyze.ts) — so the actual retry control flow is
 * pulled out into this small, provider-free function specifically so it has
 * somewhere to be tested for real, rather than only read.
 */

describe("retryOnceIf", () => {
  it("returns the result on a first try that just works, and never retries", async () => {
    let calls = 0;
    const result = await retryOnceIf(
      async () => {
        calls += 1;
        return "ok";
      },
      () => true,
      1,
    );
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries exactly once when the failure is classified as retryable", async () => {
    let calls = 0;
    const result = await retryOnceIf(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("rate limited");
        return "recovered";
      },
      (error) => error instanceof Error && error.message === "rate limited",
      1,
    );
    assert.equal(result, "recovered");
    assert.equal(calls, 2);
  });

  it("does not retry a failure shouldRetry rejects — one call, original error thrown", async () => {
    let calls = 0;
    const boom = new Error("auth failure");
    await assert.rejects(
      retryOnceIf(
        async () => {
          calls += 1;
          throw boom;
        },
        (error) => error instanceof Error && error.message === "rate limited",
        1,
      ),
      (error) => error === boom,
    );
    assert.equal(calls, 1, "an unclassified failure must not spend the retry");
  });

  it("retries at most once — a second failure is thrown, not swallowed", async () => {
    let calls = 0;
    const second = new Error("rate limited again");
    await assert.rejects(
      retryOnceIf(
        async () => {
          calls += 1;
          throw calls === 1 ? new Error("rate limited") : second;
        },
        () => true,
        1,
      ),
      (error) => error === second,
    );
    assert.equal(calls, 2, "no third attempt — this is a bounded retry, not a loop");
  });

  it("actually waits delayMs before the retry, not zero", async () => {
    let calls = 0;
    const start = Date.now();
    await retryOnceIf(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("retry me");
        return "ok";
      },
      () => true,
      50,
    );
    assert.ok(Date.now() - start >= 45, "the retry should not fire immediately");
  });
});
