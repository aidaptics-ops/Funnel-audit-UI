import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config";
import { recordSpend } from "../../cost/meter";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "../types";

/**
 * Claude, through the official SDK.
 *
 * Three things here are specific to the current model family and easy to get
 * wrong from memory:
 *
 *   - `budget_tokens` was REMOVED. Sending it to Opus 5 is a 400, not a
 *     deprecation warning. Depth is controlled by `output_config.effort`.
 *   - Thinking is on by default on Opus 5; `{type: "adaptive"}` is stated
 *     explicitly so the behaviour does not silently change with the model.
 *   - Assistant prefill is rejected, so output shape is steered by the system
 *     prompt rather than by seeding a reply.
 *
 * Streaming is used for every call. It costs nothing extra and is what keeps a
 * long generation from dying against an HTTP timeout.
 */

/** Effort trades thoroughness for tokens; the audit emails are worth "high". */
const DEFAULT_EFFORT = "high";

/**
 * A UTF-16 surrogate with no partner.
 *
 * Scraped landing pages carry these regularly — an emoji truncated by a length
 * limit, or text sliced mid-pair. JSON.stringify emits the broken half
 * verbatim, the request body is then not valid JSON, and the API rejects the
 * entire call with "invalid high surrogate in string". Found on a live funnel,
 * where it failed every generation for that page and named a byte offset
 * rather than a cause.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replaces broken pairs only; well-formed emoji pass through untouched. */
export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, "�");
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly label = "Anthropic";
  private client: Anthropic | null = null;

  isConfigured(): boolean {
    return Boolean(config.llm.apiKey && config.llm.model);
  }

  private sdk(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: config.llm.apiKey,
        timeout: config.llm.timeoutMs,
        ...(config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : {}),
      });
    }
    return this.client;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.isConfigured()) {
      throw new LlmError("Anthropic needs LLM_API_KEY and LLM_MODEL.", "unavailable");
    }

    // The API takes the system prompt as its own field, not as a message.
    const system = stripLoneSurrogates(
      request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n"),
    );

    const messages: Anthropic.MessageParam[] = request.messages
      .filter((message) => message.role === "user")
      .map((message) => ({ role: "user", content: stripLoneSurrogates(message.content) }));

    if (messages.length === 0) {
      throw new LlmError("Anthropic needs at least one user message.", "failed");
    }

    try {
      const stream = this.sdk().messages.stream({
        model: config.llm.model,
        max_tokens: request.maxOutputTokens ?? 8000,
        // Stated rather than omitted: on Opus 5 the default is already
        // adaptive, but being explicit keeps behaviour stable across models.
        thinking: { type: "adaptive" },
        output_config: { effort: DEFAULT_EFFORT },
        ...(system
          ? {
              system: [
                {
                  type: "text" as const,
                  text: system,
                  // The instructions and the client's sample emails are
                  // identical on every call and are most of the prompt, so
                  // caching the system block is nearly all of the saving.
                  cache_control: { type: "ephemeral" as const },
                },
              ],
            }
          : {}),
        messages,
      });

      const message = await stream.finalMessage();

      // A safety decline is an HTTP 200 with stop_reason "refusal", so it has
      // to be checked rather than caught.
      if (message.stop_reason === "refusal") {
        throw new LlmError(
          `The model declined this request (${message.stop_details?.category ?? "unspecified"}).`,
          "failed",
        );
      }

      // Recorded before the empty-response check: the tokens were billed
      // whether or not the answer turned out to be usable.
      recordSpend("anthropic", request.purpose ?? "Model call", {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_write_tokens: message.usage.cache_creation_input_tokens ?? 0,
        cache_read_tokens: message.usage.cache_read_input_tokens ?? 0,
      });

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (!text.trim()) {
        throw new LlmError("Anthropic returned an empty completion.", "bad_response");
      }

      return {
        text,
        model: message.model,
        finishReason: message.stop_reason ?? undefined,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
    } catch (error) {
      throw toLlmError(error);
    }
  }
}

/**
 * Typed SDK errors, narrowed most-specific first.
 *
 * The distinction that matters downstream is "configuration is wrong, stop"
 * versus "transient, a retry might work" — collapsing them into one class
 * makes an invalid key look like a flaky network.
 */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;

  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError("The Anthropic API key was rejected.", "unavailable");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new LlmError("This Anthropic key may not use that model.", "unavailable");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError("Anthropic rate limit reached. Try again shortly.", "failed");
  }
  if (error instanceof Anthropic.BadRequestError) {
    // Almost always a malformed request on our side; the message names the
    // offending parameter, which saves a long guess.
    return new LlmError(`Anthropic rejected the request: ${error.message}`, "failed");
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmError(`Anthropic error ${error.status ?? "?"}.`, "failed");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new LlmError("The request was cancelled.", "failed");
  }
  return new LlmError("Could not reach Anthropic.", "failed");
}
