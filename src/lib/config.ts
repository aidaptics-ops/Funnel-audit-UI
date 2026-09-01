/**
 * Server-only configuration. Nothing here may be imported from a client
 * component: every value is a secret or an internal address, and none of them
 * are prefixed NEXT_PUBLIC_ on purpose.
 */
import "server-only";

function str(name: string, fallback = ""): string {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function int(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export const config = {
  audit: {
    /** Base URL of the existing Funnel Audit API. No trailing slash. */
    baseUrl: str(
      "FUNNEL_AUDIT_API_URL",
      "https://funnelauditapi-funnelauditapi-cal2xu-d531aa-13-140-128-208.sslip.io",
    ).replace(/\/+$/, ""),
    /** Optional today: the audit API has no auth yet. Sent as a bearer token when set. */
    apiKey: str("FUNNEL_AUDIT_API_KEY"),
    /**
     * The audit API's own ceiling is 180s. Staying just under it means a
     * timeout surfaces as our own error rather than a dropped socket.
     */
    timeoutMs: int("FUNNEL_AUDIT_TIMEOUT_MS", 175_000),
  },

  llm: {
    /**
     * Provider is deliberately generic. "mock" is the default so the whole app
     * runs end to end before any model has been chosen.
     */
    provider: str("LLM_PROVIDER", "mock"),
    apiKey: str("LLM_API_KEY"),
    model: str("LLM_MODEL"),
    baseUrl: str("LLM_BASE_URL"),
    /**
     * One shared ceiling, read by both providers.
     *
     * The funnel analysis wants far more than this — ten images and adaptive
     * thinking at high effort runs past ninety seconds routinely — but this
     * value is not the place to give it, because it is not the analysis
     * call's to spend. Today the only callers are the email generator and the
     * voice build. generateEmail makes up to two sequential calls, and the
     * Anthropic SDK retries twice by default, inside a route that declares
     * maxDuration = 300 after already allowing the audit 175s. Doubling this
     * doubles the email stage's worst case and pushes the whole request past
     * the platform's ceiling, where the completed audit is never persisted
     * and the tokens already spent are never metered.
     *
     * The analysis call gets its own, longer budget in the phase that wires it
     * up, as a per-request timeout rather than a bigger number here.
     */
    timeoutMs: int("LLM_TIMEOUT_MS", 90_000),

    /**
     * The two-page funnel analysis, and only that call.
     *
     * This is the budget the comment above promised: a separate number,
     * applied per request as an AbortSignal on the analysis call, so the
     * email generator's worst case does not move at all. It needs the room —
     * up to nine screenshot strips, two full page inventories and full
     * reasoning depth, with one repair retry inside the same deadline.
     *
     * 240s is what is left of the route's 600 once the landing audit (175s)
     * and the post-booking crawl (90s) have had theirs, with the email's 90s
     * still to come.
     */
    analysisTimeoutMs: int("LLM_ANALYSIS_TIMEOUT_MS", 240_000),
  },

  storage: {
    /**
     * Where the client email library and derived profile live.
     * "file" works locally and on any host with a writable disk.
     * "memory" is the serverless fallback — see docs/DEPLOYMENT note.
     */
    driver: str("KNOWLEDGE_STORE", "file") as "file" | "memory",
    dir: str("KNOWLEDGE_DIR", ".data"),
    /**
     * Where paid-lookup results are cached.
     *
     * Separate from the knowledge dir because it has a different requirement:
     * losing the email library costs nothing (it re-seeds), but losing this
     * costs real enrichment credits. On Vercel the project directory is
     * read-only while /tmp is writable, so the cache lands there and at least
     * survives repeated clicks within one instance.
     */
    cacheDir: str("ENRICHMENT_CACHE_DIR", process.env.VERCEL ? "/tmp/.cache" : ".data"),
  },

  sheets: {
    /** Not wired yet; the service falls back to a no-op when unset. */
    serviceAccount: str("GOOGLE_SERVICE_ACCOUNT"),
    spreadsheetId: str("GOOGLE_SHEETS_ID"),
    worksheet: str("GOOGLE_SHEETS_WORKSHEET", "Funnels"),
  },

  enrichment: {
    hunterApiKey: str("HUNTER_API_KEY"),
    rocketReachApiKey: str("ROCKETREACH_API_KEY"),
    neverBounceApiKey: str("NEVERBOUNCE_API_KEY"),
  },
} as const;

export type AppConfig = typeof config;
