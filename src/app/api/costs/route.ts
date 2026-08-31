import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { toAppError, type AppError } from "@/lib/errors";
import { priceRun, totalise, type RunCost } from "@/lib/cost/price";
import { rateCard } from "@/lib/cost/rates";
import { sheetsService } from "@/lib/sheets/service";
import { sortRuns, toRun } from "@/lib/runs";

/**
 * What every lead cost, priced at today's rates.
 *
 * Pricing happens here rather than at the time of the run. The sheet stores
 * units — tokens, credits, checks — so moving Hunter onto a paid plan, or
 * correcting a rate that was wrong, re-prices the entire history instead of
 * leaving each row frozen at whatever was believed on the day it ran.
 *
 * The rate card goes to the browser with the figures. A cost with no visible
 * rate behind it is a number nobody can check.
 */

export interface RunCostRow {
  url: string;
  domain: string;
  business: string;
  owner: string;
  updatedAt: string;
  cost: RunCost;
}

export async function GET(): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const service = sheetsService();
    const runs = sortRuns((await service.list()).map(toRun));
    const card = rateCard();

    const rows: RunCostRow[] = runs.map((run) => ({
      url: run.url,
      domain: run.domain,
      business: run.brand,
      owner: run.ownerName || run.ownerEmail,
      updatedAt: run.updatedAt,
      cost: priceRun(run.usage, card),
    }));

    return NextResponse.json({
      ok: true,
      data: {
        runs: rows,
        totals: totalise(rows.map((row) => row.cost)),
        rates: card,
        configured: service.configured,
      },
    });
  } catch (error) {
    return fail(toAppError(error));
  }
}

function fail(error: AppError): NextResponse {
  if (error.detail) console.error(`[costs] ${error.code}: ${error.detail}`);
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}
