/**
 * One bounded retry, after a fixed delay, for a single classified failure.
 *
 * Not a general backoff library — deliberately just enough to mirror the "one
 * repair attempt, and only one" philosophy already used for the funnel
 * analysis's JSON-repair retry (src/lib/analysis/analyze.ts), applied here to
 * a transient failure like a rate limit instead of a malformed response.
 *
 * `shouldRetry` decides which failures earn the second try; anything else is
 * rethrown immediately, unchanged. No loop, no growing backoff, no cap
 * parameter to misuse — a caller that needs more than one retry should not be
 * reaching for this.
 *
 * Deliberately free of any provider import: this is pure control flow, so it
 * can be driven directly in tests without pulling in the Anthropic SDK or
 * anything that has to run on a server.
 */
export async function retryOnceIf<T>(
  attempt: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  delayMs: number,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!shouldRetry(error)) throw error;
  }
  await sleep(delayMs);
  return attempt();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
