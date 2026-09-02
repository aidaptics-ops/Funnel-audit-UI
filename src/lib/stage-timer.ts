/**
 * Stage timings, so a slow run says where the time went.
 *
 * Neither service logs anything on success, so a run that took eleven minutes
 * and one that took three looked identical from outside: a single "analysing"
 * line and then silence. Every diagnosis had to be inferred from what did NOT
 * appear, which is a bad way to run a system somebody is waiting on.
 *
 * Deliberately dumb — a name, a start, a duration. No IDs to correlate, no
 * spans, no exporter. The question being answered is only ever "which stage
 * ate the minutes", and a line per stage answers it.
 */
export interface StageTiming {
  stage: string;
  ms: number;
}

export class StageTimer {
  readonly #label: string;
  readonly #timings: StageTiming[] = [];
  readonly #startedAt: number;
  readonly #now: () => number;

  constructor(label: string, now: () => number = () => Date.now()) {
    this.#label = label;
    this.#now = now;
    this.#startedAt = now();
  }

  /** Times one stage, whether it resolves or throws. */
  async time<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const started = this.#now();
    try {
      return await work();
    } finally {
      this.#timings.push({ stage, ms: this.#now() - started });
    }
  }

  /** Records a stage that was measured elsewhere. */
  record(stage: string, ms: number): void {
    this.#timings.push({ stage, ms });
  }

  timings(): StageTiming[] {
    return [...this.#timings];
  }

  totalMs(): number {
    return this.#now() - this.#startedAt;
  }

  /**
   * One line, every stage, seconds to one decimal.
   *
   * Concurrent stages are reported as measured rather than as a share of the
   * total, so the parts deliberately do not add up to the whole - the identity
   * chain runs alongside the analysis. Saying so in the line itself beats
   * someone later concluding the numbers are wrong.
   */
  summary(): string {
    const parts = this.#timings.map((t) => `${t.stage}=${(t.ms / 1000).toFixed(1)}s`);
    return `[timing] ${this.#label} total=${(this.totalMs() / 1000).toFixed(1)}s ${parts.join(" ")}`;
  }
}
