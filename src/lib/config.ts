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
    timeoutMs: int("LLM_TIMEOUT_MS", 90_000),
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
  },
} as const;

export type AppConfig = typeof config;
