/**
 * The seam between this application and whatever model eventually writes the
 * emails. Nothing outside `lib/llm` may import a provider SDK, name a model,
 * or read a provider-specific environment variable.
 *
 * To add a provider later: implement LlmProvider, register it in registry.ts.
 * Nothing else in the app changes.
 */

export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  /** Hint only. A provider may ignore it. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * When set, the provider should coerce the model into returning JSON that
   * matches this shape. Providers without native JSON mode should fall back to
   * instructing the model and letting the caller parse defensively.
   */
  jsonSchemaName?: string;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  /** Whatever the provider can tell us; all optional, all for logging only. */
  model?: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmProvider {
  /** Stable identifier used by LLM_PROVIDER. */
  readonly id: string;
  /** Human-readable, shown in the UI's status strip. */
  readonly label: string;
  /** False when the provider needs configuration it does not have. */
  isConfigured(): boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "failed" | "bad_response" = "failed",
  ) {
    super(message);
    this.name = "LlmError";
  }
}
