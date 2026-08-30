# Deploying the dashboard to Vercel

The dashboard is a normal Next.js app and deploys with no custom build config.
What needs thought is that Vercel is **serverless**: there is no long-lived
process and no writable project directory. Three things in this app cared about
that, and all three are handled — but you should know how, because two of them
have limits.

The Playwright crawler is **not** deployed here. It stays on Dokploy and the
dashboard calls it over HTTP. Vercel could not run it: Chromium exceeds the
bundle limit and the audit exceeds the function timeout.

---

## 1. Push to GitHub

The dashboard lives in `dashboard/` inside the crawler repo, so Vercel needs to
be told that — see the root directory setting below. Nothing needs restructuring.

Confirm your secrets are not committed:

```bash
git check-ignore dashboard/.env.local && echo "ignored — good"
```

## 2. Create the Vercel project

<https://vercel.com/new> → import the repository, then **before deploying**:

| Setting | Value |
|---|---|
| **Root Directory** | `dashboard` |
| Framework Preset | Next.js (auto-detected) |
| Build / Install command | leave as default |

Getting Root Directory wrong is the single most common failure — Vercel builds
the repo root, finds no Next app, and fails.

## 3. Environment variables

**Settings → Environment Variables.** Add every one of these to *Production*,
*Preview* and *Development*. None is prefixed `NEXT_PUBLIC_`, so none reaches
the browser.

```
FUNNEL_AUDIT_API_URL      https://funnelauditapi-...sslip.io
FUNNEL_AUDIT_TIMEOUT_MS   175000

LLM_PROVIDER              openrouter
LLM_API_KEY               sk-or-v1-...
LLM_MODEL                 anthropic/claude-haiku-4.5

KNOWLEDGE_STORE           memory
KNOWLEDGE_DIR             .data

GOOGLE_SERVICE_ACCOUNT    <base64 of the JSON key>
GOOGLE_SHEETS_ID          1AzDeSA5...
GOOGLE_SHEETS_WORKSHEET   Funnels

HUNTER_API_KEY            ...
ROCKETREACH_API_KEY       ...

AUTH_EMAIL                volodymyr@rysu-media.com
AUTH_PASSWORD             <the password>
AUTH_SECRET               <openssl rand -hex 32>
```

> **Root Directory.** If you pushed the `dashboard` folder as its own
> repository — which is what `git rev-parse` reports for this checkout — leave
> Root Directory **blank**. Set it to `dashboard` only when the repository root
> is the crawler and the app sits in a subfolder.

`KNOWLEDGE_STORE=memory` is deliberate — see below. Paste the service account
**base64-encoded**; Vercel's editor handles one long line fine and mangles a
multi-line PEM key.

## 4. Deploy

Push to your default branch, or hit **Deploy**. First build is ~2 minutes.

Then open `https://<your-app>.vercel.app/api/status` and check all five report
healthy, exactly as they do locally.

---

## What serverless changes

### Sign-in — required before you share the URL

`AUTH_EMAIL` and `AUTH_PASSWORD` turn the gate on; with either missing the
console stays open to anyone with the link. Sessions are a signed cookie
(HMAC, no database), so any instance can verify one without shared state.

`AUTH_SECRET` signs that cookie. If you leave it unset a key is derived from
the password so a one-variable setup still works — but then changing the
password signs everyone out. Set it explicitly in production.

Two layers enforce it: `src/proxy.ts` turns unauthenticated browsers away, and
every API route calls `requireSession()` itself. The Next docs are explicit
that Proxy is an optimistic check rather than an authorization boundary, so
the routes do not rely on it.

### The client email library — handled

`KNOWLEDGE_STORE=file` writes to `.data/`, which does not exist on Vercel, so
the library would be empty on every cold start — and an empty library means the
generator has no voice to imitate and quietly writes generic copy.

So `readSnapshot()` falls back to the committed `seed/client-emails.txt` when
the store is empty, and `next.config.ts` force-includes `seed/**` in the
serverless bundle (it is read at runtime, so tracing does not find it alone).
A fresh deploy has all 11 emails.

The derived **profile** ships the same way, in `seed/client-profile.json`.
That matters more than it sounds: a profile built on one serverless instance is
invisible to the next, so before this existed the deployed dashboard said "no
profile yet" no matter how many times Refresh was pressed. A committed profile
means a fresh deploy is correct from the first request, with no model call.

**The limit:** emails you add — or a profile you rebuild — through the *Client
Voice* page live only in that instance's memory and vanish on the next cold
start. The rebuilt profile is shown to you immediately (the response is used
directly rather than re-fetched), but it is not persisted. To make either
permanent, commit it to `seed/` and redeploy. The durable fix is a
`SheetsKnowledgeStore` — the seam already exists.

### The enrichment cache — mostly handled

Hunter results cache to disk so a domain is never charged twice. On Vercel the
project directory is read-only, so the cache writes to `/tmp/.cache` instead.

**The limit:** `/tmp` is per-instance. Repeated clicks in one session are free,
but the same domain looked up after a cold start spends a second credit. With
50 credits/month and one operator that is a small leak, not a hazard — and the
credit balance is always visible in the status strip. A durable fix would cache
into a second tab of the spreadsheet.

### Function timeouts — check your plan

A funnel audit takes 15–25 seconds, occasionally more. `maxDuration = 300` is
set on the routes that need it, but Vercel caps it by plan:

| Plan | Max duration | Verdict |
|---|---|---|
| Hobby | 60s | Works for typical funnels; slow ones will 504 |
| Pro | 300s | Fully covered |

If you see gateway timeouts on Hobby, that is the cause — the audit itself is
fine, the function was cut off.

### The Runs page depends on Sheets

History lives in the spreadsheet, not in the app. The live queue is per-browser
and disappears with the tab; the Runs page reads every past run back from the
sheet, which is why it keeps working across restarts, machines and deploys.

A row is written when an analysis finishes — success or failure — and rewritten
when the email is approved. If Sheets is not connected, analyses still work but
the Runs page has nothing to show.

### Google Sheets concurrency

Writes are serialised inside one instance, which is what prevented the
duplicate rows you saw. Two *concurrent* Vercel instances writing the same
funnel URL could still race. In practice the queue is sequential and one
operator uses it, so this needs two browser tabs saving the same URL in the
same second to trigger. Should it ever happen, the next save of that URL
collapses the duplicates automatically.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Build fails, "no Next.js app" | Root Directory is not set to `dashboard` |
| `AI: mock (no model configured)` | `LLM_PROVIDER` / `LLM_API_KEY` missing from that environment |
| `Client voice: 0 emails` | `seed/` was not bundled — confirm `outputFileTracingIncludes` in `next.config.ts` |
| Sheets 403 | The spreadsheet is not shared with the service account |
| 504 on analyze | Function timeout — see the plan table above |
| Audit API unreachable | Dokploy instance down, or `FUNNEL_AUDIT_API_URL` wrong |

## A note on access

The deployed dashboard is **public**: anyone with the URL can spend your
OpenRouter and Hunter credits and write to your spreadsheet. Before sharing the
link, put something in front of it — Vercel Authentication (Settings →
Deployment Protection, one toggle, free on Pro) is the least effort.
