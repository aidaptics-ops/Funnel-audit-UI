import "server-only";
import { sheetsService } from "../sheets/service";
import { emptyRecord } from "../sheets/types";
import { runKey } from "../sheets/key";
import { isEmptyUsage, mergeUsage, parseUsage, serializeUsage, type RunUsage } from "./types";

/**
 * Adds what a step spent to a funnel's running total.
 *
 * Accumulating rather than replacing is the whole design. Re-analysing a
 * funnel, regenerating its email, or spending a Hunter credit on it later are
 * all real money against the same lead — a write that overwrote the cell would
 * report the last action as though it were the only one, and the total spend
 * would drift down every time someone did more work.
 *
 * Never throws. Losing an accounting entry is a much smaller problem than
 * failing an analysis that has already been paid for.
 */
export async function addRunCost(url: string, usage: RunUsage | null): Promise<void> {
  if (isEmptyUsage(usage)) return;

  try {
    const service = sheetsService();
    if (!service.configured) return;

    const key = runKey(url);
    const rows = await service.list();
    const existing = rows.find((row) => row.funnel_url === key);
    const merged = mergeUsage(parseUsage(existing?.cost_json ?? ""), usage);

    // Only the two cells that changed; upsert merges, so the rest of the row
    // is untouched. cost_json is named explicitly because a merging write
    // treats a blank as "leave it" — which is right everywhere else and would
    // here mean the ledger could never be corrected.
    const patch = emptyRecord();
    patch.funnel_url = key;
    patch.cost_json = serializeUsage(merged);
    patch.updated_at = new Date().toISOString();

    await service.upsert(patch, { overwrite: ["cost_json"] });
  } catch (error) {
    // The read and the write are two calls, and only the write holds the
    // sheet's lock. The queue analyses one funnel at a time and enrichment is
    // operator-triggered on a finished run, so two writers cannot reach the
    // same row concurrently — but a lost entry here is still only a lost
    // entry, never a lost run.
    console.error(
      `[cost] could not record spend for this run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
