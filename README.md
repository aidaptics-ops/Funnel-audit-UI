# Funnel Outreach Console

Internal dashboard around the existing **Funnel Audit API**. Enter a funnel URL, get the audit,
get an outreach email written in the client's own voice, review and edit it, then save it.

```
Funnel URL → Funnel Audit API → structured analysis → AI email engine → review/edit → Google Sheets
```

The audit API is a separate service in this repository (`../src`). This app **integrates** with it —
it never re-implements crawling, and it never talks to it from the browser.

## Run it

```bash
npm install
cp .env.example .env.local     # defaults already point at the deployed audit API
npm run dev                    # http://localhost:3000
```

```bash
npm run typecheck
npm test        # guardrail tests — no network, no browser
npm run build
```

## Architecture

```
Browser
   │  (never sees a credential, never calls the audit API directly)
   ▼
Next.js route handlers          src/app/api/*
   ▼
Audit service                   src/lib/audit/{client,normalize}.ts
   ▼
AI context builder              src/lib/email/context.ts
   ▼
LLM abstraction                 src/lib/llm/*          ← provider-agnostic
   ▼
Guardrail validation            src/lib/email/validate.ts
   ▼
Email → review → save           src/lib/sheets/*
```

```
src/
├── app/
│   ├── page.tsx                    single + bulk funnel workflow
│   ├── client-voice/page.tsx       Client Voice & Knowledge
│   └── api/
│       ├── analyze/                audit + generate, the main endpoint
│       ├── generate-email/         regenerate without re-crawling
│       ├── client-emails/          email library: list / add / remove
│       ├── client-profile/         derive the client profile
│       ├── records/                save the operational record
│       └── status/                 upstream + provider health
├── lib/
│   ├── audit/         types (defensive) · client · normalize
│   ├── llm/           types · registry · providers/mock
│   ├── email/         context · prompt · validate · generate
│   ├── client-knowledge/  types · store · ingest · profile
│   ├── sheets/        types · service (interface + no-op)
│   ├── enrichment/    types (Hunter/RocketReach seam, not implemented)
│   ├── config.ts      server-only env
│   ├── errors.ts      one error vocabulary
│   └── url.ts         URL validation + bulk extraction
├── components/        AuditPanel · EmailPanel · ui
└── hooks/             useFunnelQueue — the sequential queue
```

## The AI provider is deliberately not chosen

Nothing outside `src/lib/llm` imports an SDK, names a model, or reads a provider-specific variable.
The rest of the app only knows `generateEmail(context)`.

The default provider is `mock`: it reads the real structured context and assembles an
evidence-only email from it, so the entire pipeline is exercised for real before any model exists.
Because it can only repeat facts it was given, it cannot invent a claim.

To add a provider later:

1. implement `LlmProvider` in `src/lib/llm/providers/`;
2. `register(new YourProvider())` in `src/lib/llm/registry.ts`;
3. set `LLM_PROVIDER`.

No other file changes. One OpenAI-compatible adapter would cover OpenAI, Groq, Together,
OpenRouter and most local runtimes.

## How client emails are used

Historical emails are **not** a bug database. They supply two things:

| From the emails | From the audit |
| --- | --- |
| how this person writes | what is actually true of this funnel |
| what they tend to notice | what can be evidenced |

The generator receives the writing profile, the diagnostic profile, a few relevant samples, and the
new funnel's audit — with an explicit statement of what the audit could **not** see.

## Why it cannot invent post-booking problems

The audit renders exactly one page. It never fills a form, never books, never visits a
confirmation page. That fact is carried through the whole pipeline:

1. `normalize.ts` attaches an `observability` block: `postBookingObserved: false`, always.
2. `context.ts` builds an explicit evidence list — the complete set of assertable facts.
3. `prompt.ts` includes a **NOT OBSERVED** section stating that nothing after conversion was seen.
4. `validate.ts` inspects the generated email and rejects any *assertion* about post-conversion
   behaviour, any number not present in the evidence, and any claim about traffic, spend or revenue.
   Raising the topic as a **question** is allowed; claiming a defect is not.
5. A hard violation triggers one corrective regeneration; anything left is surfaced in the UI as a
   guardrail flag next to the email.
6. `/api/generate-email` forces `postBookingObserved: false` even if a caller sends otherwise.

So a client whose profile says they always notice weak confirmation pages will still not produce an
email claiming this prospect has one.

## Sequential queue

The audit API runs `MAX_CONCURRENT_ANALYSES=1`, so the queue is strictly sequential and lives in the
browser (`useFunnelQueue`). One request is in flight at a time; the rest show as `Queued`.
That also means it works unchanged on serverless, where a server-side queue would need a durable
backend.

Stages: `Queued → Analyzing → Generating email → Ready for review → Approved → Saved`, plus `Failed`.

## Storage

The email library and profile sit behind `KnowledgeStore` (`src/lib/client-knowledge/store.ts`).

- `KNOWLEDGE_STORE=file` (default) — persists to `.data/`, correct locally and on any disk-backed host.
- `KNOWLEDGE_STORE=memory` — correct on **Vercel**, whose filesystem is ephemeral and per-instance.

On Vercel the library therefore lives only as long as one instance. The fix is a durable store, and
the interface is the seam: a `SheetsKnowledgeStore` (or KV/Postgres) is one class with no caller
changes. The UI states plainly when storage is not durable rather than pretending.

## Deploy to Vercel

Root Directory: **`dashboard`** (this is a monorepo; the repository root is the audit API).

```
FUNNEL_AUDIT_API_URL = https://…sslip.io
LLM_PROVIDER         = mock
KNOWLEDGE_STORE      = memory
```

`/api/analyze` declares `maxDuration = 300`. Hobby caps functions at 60s, which is tight for a
20s audit plus a model call — use Pro/Fluid Compute, or split audit and email into two calls.

## Not implemented yet

- Google Sheets writes (`SheetsService` is an interface with a no-op implementation).
- Hunter / RocketReach enrichment (`src/lib/enrichment/types.ts` is the seam).
- Import from Google Sheets.
- Any real LLM provider.
