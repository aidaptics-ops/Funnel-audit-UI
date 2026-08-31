import "server-only";
import { config } from "../../config";
import { recordSpend } from "../../cost/meter";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "../types";

/**
 * One adapter for every OpenAI-compatible chat endpoint.
 *
 * OpenRouter, OpenAI, Groq, Together, DeepSeek, Fireworks and most local
 * runtimes all speak `POST /chat/completions` with the same body. That means a
 * single class covers all of them and the *model* becomes a config value
 * rather than a code change — which is the whole point of the LlmProvider
 * seam. Switching from a cheap test model to Claude Opus 5 for production is
 * one line in .env.local.
 *
 * The key never leaves this file: it goes into an Authorization header and is
 * scrubbed from anything that could be logged or returned.
 */

interface ProviderOptions {
  id: string;
  label: string;
  /** Used when LLM_BASE_URL is unset. Empty means the base URL is required. */
  defaultBaseUrl: string;
  /** OpenRouter shows these on the account's activity page. */
  attribution?: { referer: string; title: string };
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string | number };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly label: string;
  private readonly defaultBaseUrl: string;
  private readonly attribution?: { referer: string; title: string };
  /** Set once a request is rejected for sending response_format. */
  private jsonModeUnsupported = false;

  constructor(options: ProviderOptions) {
    this.id = options.id;
    this.label = options.label;
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.attribution = options.attribution;
  }

  private baseUrl(): string {
    return (config.llm.baseUrl || this.defaultBaseUrl).replace(/\/+$/, "");
  }

  isConfigured(): boolean {
    return Boolean(config.llm.apiKey && config.llm.model && this.baseUrl());
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.isConfigured()) {
      throw new LlmError(
        `${this.label} needs LLM_API_KEY, LLM_MODEL and a base URL before it can be used.`,
        "unavailable",
      );
    }

    const wantsJson = Boolean(request.jsonSchemaName) && !this.jsonModeUnsupported;
    const first = await this.send(request, wantsJson);

    // Not every model behind an aggregator accepts response_format. Rather
    // than make the operator discover that through a 400, notice it once and
    // fall back for the rest of the process — the prompt already demands JSON
    // and safeJson() parses defensively either way.
    if (first.kind === "json_mode_rejected") {
      this.jsonModeUnsupported = true;
      const retry = await this.send(request, false);
      if (retry.kind === "ok") return retry.response;
      if (retry.kind === "failed") throw retry.error;
      throw new LlmError(`${this.label} rejected the request twice.`, "failed");
    }
    if (first.kind !== "ok") throw first.error;
    return first.response;
  }

  private async send(
    request: LlmRequest,
    jsonMode: boolean,
  ): Promise<
    | { kind: "ok"; response: LlmResponse }
    | { kind: "failed"; error: LlmError }
    | { kind: "json_mode_rejected" }
  > {
    const timeout = AbortSignal.timeout(config.llm.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${config.llm.apiKey}`,
    };
    if (this.attribution) {
      headers["http-referer"] = this.attribution.referer;
      headers["x-title"] = this.attribution.title;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model: config.llm.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxOutputTokens ?? 2000,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "network error";
      return { kind: "failed", error: new LlmError(`${this.label} request ${reason}.`, "failed") };
    }

    const body = (await response.json().catch(() => null)) as ChatCompletion | null;

    if (!response.ok) {
      const detail = scrub(body?.error?.message ?? `HTTP ${response.status}`);
      if (response.status === 400 && /response_format|json_object|json mode/i.test(detail)) {
        return { kind: "json_mode_rejected" };
      }
      // 401/403 are configuration problems, not transient ones; saying so
      // saves an operator from retrying a bad key ten times.
      const kind = response.status === 401 || response.status === 403 ? "unavailable" : "failed";
      return {
        kind: "failed",
        error: new LlmError(`${this.label} rejected the request (${response.status}): ${detail}`, kind),
      };
    }

    const text = body?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      return {
        kind: "failed",
        error: new LlmError(`${this.label} returned an empty completion.`, "bad_response"),
      };
    }

    // Metered like the Anthropic provider, or a run that happens to be on this
    // adapter costs real money and reports zero on the Expenditure page.
    recordSpend("anthropic", request.purpose ?? "Model call", {
      input_tokens: body?.usage?.prompt_tokens ?? 0,
      output_tokens: body?.usage?.completion_tokens ?? 0,
    });

    return {
      kind: "ok",
      response: {
        text,
        model: body?.model ?? config.llm.model,
        finishReason: body?.choices?.[0]?.finish_reason,
        usage: {
          inputTokens: body?.usage?.prompt_tokens,
          outputTokens: body?.usage?.completion_tokens,
        },
      },
    };
  }
}

/**
 * Defence in depth: an upstream error message should never echo a key back
 * into a log line or an HTTP response.
 */
function scrub(message: string): string {
  const key = config.llm.apiKey;
  const withoutKey = key ? message.split(key).join("***") : message;
  return withoutKey.replace(/\b(sk|sk-or|sk-ant|key)-[A-Za-z0-9_-]{8,}/g, "***").slice(0, 300);
}
