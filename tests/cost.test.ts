import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  addEvent,
  emptyUsage,
  mergeUsage,
  parseUsage,
  serializeUsage,
  type RunUsage,
} from "../src/lib/cost/types";
import { money, priceRun, totalise, type RateCard } from "../src/lib/cost/price";

/**
 * The rates the app ships with, so a test failure means the arithmetic moved
 * rather than that someone changed an environment variable.
 */
const CARD: RateCard = {
  model: "claude-opus-5",
  prices: {
    anthropic: {
      input_tokens: 5 / 1_000_000,
      output_tokens: 25 / 1_000_000,
      cache_write_tokens: 6.25 / 1_000_000,
      cache_read_tokens: 0.5 / 1_000_000,
      web_searches: 10 / 1_000,
    },
    hunter: { credits: 0 },
    rocketreach: { lookups: 0 },
    neverbounce: { checks: 0.008 },
    audit: { requests: 0 },
  },
  notes: {},
};

function usage(events: RunUsage["events"]): RunUsage {
  return { events };
}

describe("pricing a run", () => {
  it("prices tokens, searches and checks together", () => {
    const cost = priceRun(
      usage([
        {
          service: "anthropic",
          label: "Founder research (web search)",
          count: 1,
          units: { input_tokens: 25_000, output_tokens: 5_000, web_searches: 8 },
        },
        { service: "neverbounce", label: "Address verification", count: 4, units: { checks: 4 } },
      ]),
      CARD,
    );

    // 25k x $5/M = $0.125, 5k x $25/M = $0.125, 8 searches x $0.01 = $0.08
    const research = cost.byService.find((entry) => entry.service === "anthropic");
    assert.equal(research?.usd, 0.33);
    // 4 checks x $0.008
    const verify = cost.byService.find((entry) => entry.service === "neverbounce");
    assert.equal(verify?.usd, 0.032);
    assert.equal(cost.usd, 0.362);
    assert.equal(cost.metered, true);
  });

  it("prices cache reads far below fresh input", () => {
    const cached = priceRun(
      usage([{ service: "anthropic", label: "Outreach email", count: 1, units: { cache_read_tokens: 10_000 } }]),
      CARD,
    );
    const fresh = priceRun(
      usage([{ service: "anthropic", label: "Outreach email", count: 1, units: { input_tokens: 10_000 } }]),
      CARD,
    );
    assert.equal(cached.usd, 0.005);
    assert.equal(fresh.usd, 0.05);
  });

  it("reports the biggest service first, which is the answer to the question", () => {
    const cost = priceRun(
      usage([
        { service: "neverbounce", label: "Address verification", count: 1, units: { checks: 1 } },
        { service: "anthropic", label: "Outreach email", count: 1, units: { input_tokens: 100_000 } },
      ]),
      CARD,
    );
    assert.equal(cost.byService[0]?.service, "anthropic");
  });

  it("keeps a free-plan service visible with its units, priced at nothing", () => {
    const cost = priceRun(
      usage([{ service: "hunter", label: "Hunter domain search", count: 1, units: { credits: 1, requests: 1 } }]),
      CARD,
    );
    const hunter = cost.byService.find((entry) => entry.service === "hunter");
    assert.equal(hunter?.usd, 0);
    // The credit still has to be visible: on a free plan the quota is the
    // scarce thing, not the money.
    assert.equal(hunter?.units.credits, 1);
  });

  it("treats a run with no ledger as unknown, not free", () => {
    const cost = priceRun(null, CARD);
    assert.equal(cost.metered, false);
    assert.equal(cost.usd, 0);
  });
});

describe("totals", () => {
  const metered = priceRun(
    usage([{ service: "anthropic", label: "Outreach email", count: 1, units: { input_tokens: 100_000 } }]),
    CARD,
  );

  it("averages over costed runs only", () => {
    // Three runs, one of which predates tracking. The average must be $0.50,
    // not $0.33 — averaging an unknown in as zero flatters every figure.
    const totals = totalise([metered, metered, priceRun(null, CARD)]);
    assert.equal(totals.usd, 1);
    assert.equal(totals.metered, 2);
    assert.equal(totals.unmetered, 1);
    assert.equal(totals.averageUsd, 0.5);
  });

  it("does not divide by zero when nothing has been costed", () => {
    const totals = totalise([priceRun(null, CARD)]);
    assert.equal(totals.averageUsd, 0);
    assert.equal(totals.byService.length, 0);
  });

  it("shares add up to the whole", () => {
    const mixed = priceRun(
      usage([
        { service: "anthropic", label: "Outreach email", count: 1, units: { input_tokens: 100_000 } },
        { service: "neverbounce", label: "Address verification", count: 1, units: { checks: 25 } },
      ]),
      CARD,
    );
    const totals = totalise([mixed]);
    const share = totals.byService.reduce((sum, entry) => sum + entry.share, 0);
    assert.ok(Math.abs(share - 1) < 1e-9);
  });
});

describe("the ledger", () => {
  it("merges repeats of the same step rather than stacking rows", () => {
    let ledger = emptyUsage();
    ledger = addEvent(ledger, {
      service: "anthropic",
      label: "Outreach email",
      count: 1,
      units: { input_tokens: 7_000, output_tokens: 2_000 },
    });
    ledger = addEvent(ledger, {
      service: "anthropic",
      label: "Outreach email",
      count: 1,
      units: { input_tokens: 7_000, output_tokens: 2_000 },
    });

    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0]?.count, 2);
    assert.equal(ledger.events[0]?.units.input_tokens, 14_000);
  });

  it("keeps different steps of the same service apart", () => {
    let ledger = emptyUsage();
    ledger = addEvent(ledger, { service: "anthropic", label: "Founder research", count: 1, units: { web_searches: 6 } });
    ledger = addEvent(ledger, { service: "anthropic", label: "Outreach email", count: 1, units: { input_tokens: 10 } });
    assert.equal(ledger.events.length, 2);
  });

  it("adds a later spend to what the lead has already cost", () => {
    // Re-analysing or enriching a funnel is more money against the same lead.
    // Replacing the cell instead of accumulating would report the last action
    // as though it were the only one.
    const first = usage([{ service: "neverbounce", label: "Address verification", count: 4, units: { checks: 4 } }]);
    const later = usage([{ service: "neverbounce", label: "Address verification", count: 1, units: { checks: 1 } }]);
    const merged = mergeUsage(first, later);
    assert.equal(merged.events.length, 1);
    assert.equal(merged.events[0]?.units.checks, 5);
  });

  it("does not mutate the ledger it was given", () => {
    const first = usage([{ service: "hunter", label: "Hunter domain search", count: 1, units: { credits: 1 } }]);
    mergeUsage(first, first);
    assert.equal(first.events[0]?.units.credits, 1);
  });
});

describe("reading a row back", () => {
  it("survives a round trip through the spreadsheet", () => {
    const original = usage([
      { service: "anthropic", label: "Outreach email", count: 2, units: { input_tokens: 14_000 } },
      { service: "hunter", label: "Hunter index check (free)", count: 1, units: { requests: 1 } },
    ]);
    const parsed = parseUsage(serializeUsage(original));
    assert.deepEqual(parsed, original);
  });

  it("returns nothing for an empty or hand-cleared cell", () => {
    assert.equal(parseUsage(""), null);
    assert.equal(parseUsage("   "), null);
    assert.equal(serializeUsage(emptyUsage()), "");
  });

  it("does not break the page on a truncated or hand-edited cell", () => {
    assert.equal(parseUsage('{"events":[{"service":"anthro'), null);
    assert.equal(parseUsage("not json at all"), null);
    assert.equal(parseUsage('{"events":"nonsense"}'), null);
  });

  it("drops an unknown service rather than inventing a column for it", () => {
    const parsed = parseUsage(
      '{"events":[{"service":"stripe","label":"x","count":1,"units":{"checks":1}},' +
        '{"service":"hunter","label":"Hunter domain search","count":1,"units":{"credits":1}}]}',
    );
    assert.equal(parsed?.events.length, 1);
    assert.equal(parsed?.events[0]?.service, "hunter");
  });

  it("refuses negative and non-numeric quantities", () => {
    const parsed = parseUsage(
      '{"events":[{"service":"neverbounce","label":"Address verification","count":1,' +
        '"units":{"checks":-5,"requests":"lots","lookups":2}}]}',
    );
    assert.deepEqual(parsed?.events[0]?.units, { lookups: 2 });
  });
});

describe("formatting money", () => {
  it("keeps sub-cent amounts legible instead of rounding them to zero", () => {
    assert.equal(money(0.4213), "$0.4213");
    assert.equal(money(0.000_75), "$0.00075");
    assert.equal(money(0), "$0");
  });

  it("drops to two places once the figure is a real sum", () => {
    assert.equal(money(312.5), "$312.50");
  });
});
