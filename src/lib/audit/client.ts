import "server-only";
import { config } from "../config";
import { recordSpend } from "../cost/meter";
import { AppError, type AppErrorCode } from "../errors";
import type { AuditFailureEnvelope, AuditSuccessEnvelope, RawAnalysis } from "./types";

/**
 * The only place that talks to the Funnel Audit API. Callers get either a
 * RawAnalysis or an AppError — never a raw fetch failure, never an upstream
 * error body.
 */

/** Upstream error codes → our vocabulary. Anything unlisted becomes audit_error. */
const UPSTREAM_CODES: Record<string, AppErrorCode> = {
  invalid_url: "invalid_url",
  unsupported_scheme: "unsupported_scheme",
  private_host: "private_host",
  credentials_not_allowed: "credentials_not_allowed",
  url_too_long: "url_too_long",
  invalid_body: "invalid_body",
  analysis_timeout: "audit_timeout",
  too_many_requests: "audit_busy",
  navigation_failed: "audit_navigation_failed",
  blocked_navigation: "private_host",
  browser_unavailable: "audit_unavailable",
  internal_error: "audit_error",
  not_found: "audit_error",
};

export interface AuditResult {
  jobId: string | null;
  requestedUrl: string;
  analysis: RawAnalysis;
  /** Wall-clock time this app waited, which includes network. */
  elapsedMs: number;
}

export async function runAudit(url: string, signal?: AbortSignal): Promise<AuditResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.audit.timeoutMs);

  // Caller cancellation (browser navigated away) must also stop the request.
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(`${config.audit.baseUrl}/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.audit.apiKey ? { authorization: `Bearer ${config.audit.apiKey}` } : {}),
      },
      // The pictures are the only defence against a confident, wrong reading
      // of the markup — a scripted opt-in button reads as "no conversion path"
      // and looks like a button to anyone who can see it.
      body: JSON.stringify({ url, screenshot: true }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new AppError(aborted ? "audit_timeout" : "audit_unavailable", describe(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const text = await response.text().catch(() => "");
  let body: AuditSuccessEnvelope & AuditFailureEnvelope;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // A proxy error page, an HTML 502 from Traefik, etc.
    throw new AppError("audit_bad_response", `non-JSON body (HTTP ${response.status})`);
  }

  if (!response.ok || body.status === "failed") {
    const upstream = body.error?.code ?? "";
    const mapped = UPSTREAM_CODES[upstream] ?? statusToCode(response.status);
    throw new AppError(mapped, `upstream ${response.status} ${upstream || "unknown"}`);
  }

  const analysis = body.analysis;
  if (!analysis || typeof analysis !== "object") {
    throw new AppError("audit_bad_response", "response contained no analysis object");
  }

  // Free at the margin on a self-hosted audit API, but recorded anyway: the
  // costs page should account for every service a run touches, and a line that
  // reads "no per-run charge" is an answer where an absent line is a question.
  recordSpend("audit", "Funnel page audit", { requests: 1 });

  return {
    jobId: typeof body.job_id === "string" ? body.job_id : null,
    requestedUrl: typeof body.url === "string" ? body.url : url,
    analysis,
    elapsedMs: Date.now() - started,
  };
}

export interface AuditHealth {
  ok: boolean;
  activeAnalyses: number | null;
  maxConcurrent: number | null;
  version: string | null;
}

export async function auditHealth(): Promise<AuditHealth> {
  try {
    const response = await fetch(`${config.audit.baseUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false, activeAnalyses: null, maxConcurrent: null, version: null };
    const body = (await response.json()) as Record<string, unknown>;
    return {
      ok: body.status === "ok",
      activeAnalyses: numberOrNull(body.active_analyses),
      maxConcurrent: numberOrNull(body.max_concurrent_analyses),
      version: typeof body.version === "string" ? body.version : null,
    };
  } catch {
    return { ok: false, activeAnalyses: null, maxConcurrent: null, version: null };
  }
}

function statusToCode(status: number): AppErrorCode {
  if (status === 429) return "audit_busy";
  if (status === 408 || status === 504) return "audit_timeout";
  if (status === 502 || status === 503) return "audit_unavailable";
  if (status >= 400 && status < 500) return "audit_error";
  return "audit_error";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
