# Deploying the dashboard to Dokploy

Dokploy is the better host for this app, and not only because it avoids a Pro
plan. Three things it gives you that serverless cannot:

| | Vercel | Dokploy |
|---|---|---|
| Owner search (60–120s) | needs Pro; Hobby kills it at 60s | no limit — it is a long-running server |
| Client email library & profile | in-memory, lost on every cold start | on disk, survives restarts |
| Paid-lookup cache | per-instance, so credits get respent | one durable cache, never respent |
| Audit API hop | public internet | same host, or the internal network |

The last two are the ones that cost real money on Vercel: an enrichment cache
that resets means paying Hunter again for a domain already looked up.

---

## 1. What is already in the repo

Nothing to prepare — [`Dockerfile`](../Dockerfile) and
[`.dockerignore`](../.dockerignore) are committed, and `next.config.ts` sets
`output: "standalone"` so the image carries only the server and the modules it
actually reaches (~28 MB of `node_modules`, not the full install).

The image runs as an unprivileged user and has a healthcheck against `/login`,
so a container that boots but cannot serve is reported unhealthy rather than
silently receiving traffic.

## 2. Create the application

In Dokploy, inside your project: **Create Service → Application**.

| Setting | Value |
|---|---|
| Source | GitHub → `aidaptics-ops/Funnel-audit-UI` |
| Branch | `main` |
| Build type | **Dockerfile** |
| Dockerfile path | `Dockerfile` |
| Port | `3000` |

Build type must be Dockerfile, not Nixpacks. Nixpacks will guess a Next build
and miss the standalone output and the `seed/` copy.

## 3. Add a volume — do this before the first deploy

**Advanced → Volumes → Add**:

| Field | Value |
|---|---|
| Type | Volume mount |
| Name | `funnel-dashboard-data` |
| Mount path | `/app/.data` |

This is the whole durability story. Without it the container still runs, but
the enrichment cache dies on every redeploy and the next owner search pays
Hunter again for domains you have already bought.

## 4. Environment variables

**Environment** tab. Every one of these is server-side; none is prefixed
`NEXT_PUBLIC_`, so none reaches the browser.

```dotenv
FUNNEL_AUDIT_API_URL=https://funnelauditapi-...sslip.io
FUNNEL_AUDIT_TIMEOUT_MS=175000

LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-opus-5
LLM_TIMEOUT_MS=90000

# "file", NOT "memory" — the opposite of the Vercel setting. This is what the
# volume above is for.
KNOWLEDGE_STORE=file
KNOWLEDGE_DIR=.data

GOOGLE_SERVICE_ACCOUNT=<base64 of the JSON key>
GOOGLE_SHEETS_ID=...
GOOGLE_SHEETS_WORKSHEET=Funnels

HUNTER_API_KEY=...
ROCKETREACH_API_KEY=...
NEVERBOUNCE_API_KEY=...

AUTH_EMAIL=volodymyr@rysu-media.com
AUTH_PASSWORD=...
AUTH_SECRET=<openssl rand -hex 32>

NODE_ENV=production
```

`NODE_ENV=production` matters for more than optimisation: it is what makes the
session cookie `Secure`. Leave it out and the cookie is sent over plain HTTP.

Set `AUTH_SECRET` here rather than letting it derive from the password — on a
box you control there is no reason not to, and it means changing the password
does not sign everyone out.

## 5. Domain and HTTPS

**Domains → Add Domain**: your hostname, container port `3000`, HTTPS on with
Let's Encrypt. Dokploy handles the certificate and the reverse proxy, which is
what the Next self-hosting guide recommends sitting in front of the server.

## 6. Deploy

Hit **Deploy**. The first build takes ~3 minutes; later ones reuse the
dependency layer and are much faster.

Then check `https://<your-domain>/api/status`. Signed out it returns `401` —
that is the gate working. Sign in, and it should report:

```json
{
  "llm":       { "model": "claude-opus-5", "configured": true },
  "knowledge": { "emailCount": 11, "hasProfile": true,
                 "storage": { "kind": "file", "durable": true } },
  "sheets":    { "configured": true }
}
```

`"durable": true` is the line to look for. If it says `memory`, the volume did
not mount or `KNOWLEDGE_STORE` is wrong.

---

## Optional: skip the public internet for the audit call

Both services are on the same Docker network, so the dashboard can reach the
audit API by its service name instead of going out and back:

```dotenv
FUNNEL_AUDIT_API_URL=http://funnelauditapi:3000
```

Use the exact service name Dokploy shows for the API. Faster, and the audit API
stops needing public exposure at all. Keep the public URL until you have
confirmed the internal one resolves — the status strip will tell you
immediately if it does not.

## What this deployment does better

- **Owner search has no ceiling.** A 60–120 second research run is a normal
  request here, not a timeout.
- **Credits are not respent.** The enrichment cache is on the volume, so a
  domain looked up in January is still free in June.
- **Emails added through the Client Voice page persist.** On Vercel they had to
  be committed to `seed/` and redeployed.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Build fails immediately | Build type is Nixpacks, not Dockerfile |
| `storage: memory` in status | Volume not mounted, or `KNOWLEDGE_STORE=memory` |
| `Client voice: 0 emails` | `seed/` missing — check `.dockerignore` does not exclude it |
| Login succeeds then bounces back | `NODE_ENV` not `production`, so the cookie is not `Secure` behind HTTPS |
| Sheets 403 | Spreadsheet not shared with the service account |
| Audit API unreachable | Wrong `FUNNEL_AUDIT_API_URL`, or the internal name does not resolve |
| Container marked unhealthy | It failed to serve `/login`; check the logs for a missing env var |
