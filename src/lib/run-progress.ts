/**
 * What a run is probably doing, and how much longer it probably has.
 *
 * PROJECTED, not observed. The browser POSTs to /api/analyze once and waits
 * for one response; there is no channel carrying progress back, so nothing
 * here knows which stage is really running. What it does know is the order the
 * stages run in and how long each has actually taken, and that is enough to
 * stop a healthy five-minute run reading as a hung one — which is the problem
 * this exists to solve, not accuracy for its own sake.
 *
 * Durations are measured, not guessed. Three real runs:
 *   crawl     15.8s   20.0s   23.7s
 *   analysis  77.7s  104.2s  114.5s
 *   identity  56.1s   62.9s  400.4s   <- the variable one, by a long way
 *   email     28.3s   60.4s   86.7s
 *
 * `analysis` and `identity` run CONCURRENTLY, so the middle of a run is one
 * block whose length is the slower of the two — which is why the estimate
 * widens so much once the owner search is in play.
 */

export type RunStage = "crawl" | "research" | "email" | "overdue";

/** Typical milliseconds per stage, from the runs above. */
const CRAWL_MS = 20_000;
/** analysis and identity together, since they overlap. */
const RESEARCH_MS = 190_000;
const EMAIL_MS = 45_000;

export const TYPICAL_RUN_MS = CRAWL_MS + RESEARCH_MS + EMAIL_MS;

export interface RunProgress {
  stage: RunStage;
  /** What to show as the headline. */
  label: string;
  /** The one-line explanation under it. */
  detail: string;
  /** 0-1, for the bar. Never reaches 1 while the run is still going. */
  fraction: number;
  /** Milliseconds still expected, or null once the run is past its estimate. */
  remainingMs: number | null;
}

/**
 * Once a run passes its estimate, the estimate is WRONG and saying so is
 * better than counting down to zero and sitting there. The owner search can
 * legitimately take 400s, so overrunning is common rather than exceptional.
 */
export function projectRun(elapsedMs: number): RunProgress {
  const elapsed = Math.max(0, elapsedMs);

  if (elapsed < CRAWL_MS) {
    return {
      stage: "crawl",
      label: "Reading the page",
      detail: "Rendering it and recording what is actually there.",
      fraction: cap(elapsed / TYPICAL_RUN_MS),
      remainingMs: TYPICAL_RUN_MS - elapsed,
    };
  }

  if (elapsed < CRAWL_MS + RESEARCH_MS) {
    return {
      stage: "research",
      label: "Analysing the funnel and researching the owner",
      detail: "Both at once. The owner search is usually the longest part of a run.",
      fraction: cap(elapsed / TYPICAL_RUN_MS),
      remainingMs: TYPICAL_RUN_MS - elapsed,
    };
  }

  if (elapsed < TYPICAL_RUN_MS) {
    return {
      stage: "email",
      label: "Writing the email",
      detail: "In the client's voice, then checked against what was actually observed.",
      fraction: cap(elapsed / TYPICAL_RUN_MS),
      remainingMs: TYPICAL_RUN_MS - elapsed,
    };
  }

  return {
    stage: "overdue",
    label: "Still working",
    detail:
      "Past the usual time for a run. The owner search can legitimately take several more minutes on a " +
      "domain with little published about it.",
    // Creeps toward 95% without arriving: a full bar on a running job is a lie.
    fraction: cap(0.85 + (elapsed - TYPICAL_RUN_MS) / (TYPICAL_RUN_MS * 8), 0.95),
    remainingMs: null,
  };
}

/** "2m 14s", or "48s" under a minute. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function cap(value: number, ceiling = 0.85): number {
  return Math.min(Math.max(value, 0), ceiling);
}
