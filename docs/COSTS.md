# Cost tracking

What every lead costs, where the money goes, and how the figure is arrived at.

## The measured shape of one run

A complete run of `thefinallover.com/compass` — audit, business identification,
founder research, email discovery, verification and the outreach email:

| | |
| --- | --- |
| Wall clock | ~2 minutes |
| **Total** | **$0.55** |
| Claude | $0.53 — 97% of it |
| NeverBounce | $0.016 (2 checks) |
| Hunter | 2.2 credits, $0 on the free plan |
| RocketReach | 0 lookups (search is free) |
| Funnel audit | 1 run, self-hosted |

Almost all of it is one call. The founder research consumed **60,289 input
tokens** — web search results come back into the context, so the prompt grows
with every page the model reads — against 10,905 for writing the email. If a
run ever needs to be cheaper, that is the only line worth looking at.

## How the number is produced

Each provider records what it consumed at its **HTTP boundary**, inside a
per-request meter (`src/lib/cost/meter.ts`, an `AsyncLocalStorage` ledger).
Placing the measurement there rather than at the call sites has three
consequences that matter:

- A **cached** Hunter or NeverBounce result never reaches the transport, so it
  correctly records nothing. Nothing has to remember to skip it.
- A call that **failed after** the credit was taken is still recorded.
- A new call site cannot forget to meter itself.

The ledger is written to the run's `cost_json` column and **accumulates**:
re-analysing a funnel, regenerating its email or spending a credit on it later
all add to what that lead has cost. A write that replaced the cell would report
the last action as though it were the only one.

## Units, not money

`cost_json` stores tokens, credits, checks and lookups — never dollars. Money
is computed when the Expenditure page is read, from the rates below.

So changing a rate, or moving Hunter onto a paid plan, **re-prices the entire
history** correctly. Had each row been stored in dollars, every past run would
be frozen at whatever was believed on the day it ran, with nothing to say which
rate applied to which row.

## Rates

All optional; the defaults are in `.env.example` and are shown on the page
itself so any figure can be checked.

| Variable | Default | |
| --- | --- | --- |
| `PRICE_LLM_INPUT_PER_MTOK` | 5 | Opus 5 list price |
| `PRICE_LLM_OUTPUT_PER_MTOK` | 25 | |
| `PRICE_LLM_CACHE_WRITE_PER_MTOK` | 6.25 | 1.25× input |
| `PRICE_LLM_CACHE_READ_PER_MTOK` | 0.5 | 0.1× input |
| `PRICE_WEB_SEARCH_PER_THOUSAND` | 10 | billed per request, on top of tokens |
| `PRICE_HUNTER_PER_CREDIT` | 0 | free plan: 50/month |
| `PRICE_ROCKETREACH_PER_LOOKUP` | 0 | free plan: 3/month |
| `PRICE_NEVERBOUNCE_PER_CHECK` | 0.008 | |
| `PRICE_AUDIT_PER_RUN` | 0 | self-hosted |

A free tier is priced at **zero** deliberately: nothing is charged for the 51st
Hunter credit, the lookup simply stops working. The money is not the constraint
there — the quota is — so the page shows credits consumed beside the money, and
the balances on the Funnels page are what to watch.

## Runs from before tracking existed

Rows written earlier have no ledger. They show as **not tracked** and are left
out of both the total and the average, rather than counted as zero — a run
whose cost was never recorded did not cost nothing, and averaging it in as zero
would quietly flatter every figure on the page.
