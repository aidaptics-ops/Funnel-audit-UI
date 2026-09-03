"use client";

import { useEffect, useState } from "react";
import { Card } from "./ui";
import { formatDuration, projectRun } from "@/lib/run-progress";

/**
 * A run in flight, with the time it has taken and what it is probably doing.
 *
 * The stage is PROJECTED from elapsed time, not reported by the server: the
 * browser makes one request and waits for one response, so nothing here can
 * know what is really happening. The card says so rather than implying live
 * telemetry it does not have.
 *
 * It exists because a completed run once sat on "Analyzing" and read as
 * broken. A number that visibly moves is the difference between waiting and
 * wondering, even when the number is an estimate.
 */
export function RunProgressCard({ startedAt, queued }: { startedAt: number | null; queued: boolean }) {
  // Re-rendered every second while a run is in flight. Cheap: one setState on
  // a card that is only mounted while something is actually running.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (queued || startedAt === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [queued, startedAt]);

  if (queued || startedAt === null) {
    return (
      <Card>
        <div className="flex items-center gap-3 py-5">
          <span className="h-2 w-2 animate-pulse rounded-full bg-busy" />
          <div>
            <p className="text-[13px] font-medium text-ink">Waiting its turn</p>
            <p className="mt-0.5 text-xs text-ink-subtle">The analyser handles one funnel at a time.</p>
          </div>
        </div>
      </Card>
    );
  }

  const elapsed = now - startedAt;
  const run = projectRun(elapsed);

  return (
    <Card>
      <div className="py-1">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-busy" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink">{run.label}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{run.detail}</p>
          </div>
        </div>

        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
          role="progressbar"
          aria-valuenow={Math.round(run.fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-busy transition-[width] duration-1000 ease-linear"
            style={{ width: `${Math.round(run.fraction * 100)}%` }}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
          <span data-numeric className="text-[12px] text-ink-muted">
            {formatDuration(elapsed)} elapsed
          </span>
          <span data-numeric className="text-[12px] text-ink-subtle">
            {run.remainingMs === null
              ? "longer than usual — still running"
              : `about ${formatDuration(run.remainingMs)} left`}
          </span>
        </div>

        {/* Said plainly, because an estimate presented as fact is worse than no estimate. */}
        <p className="mt-2 text-[11px] text-ink-subtle">
          Estimated from how long runs usually take, not reported by the analyser.
        </p>
      </div>
    </Card>
  );
}
