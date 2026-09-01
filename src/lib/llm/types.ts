/**
 * The seam between this application and whatever model eventually writes the
 * emails. Nothing outside `lib/llm` may import a provider SDK, name a model,
 * or read a provider-specific environment variable.
 *
 * To add a provider later: implement LlmProvider, register it in registry.ts.
 * Nothing else in the app changes.
 */

export interface LlmImage {
  /** Base64, no data: prefix. */
  data: string;
  mediaType: string;
  /** Where this sits on the page, so the model can order them. */
  caption: string;
}

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
   * Reasoning depth for THIS call, when the default is wrong for it.
   *
   * Thinking tokens are spent out of the same budget as the answer, so a
   * call that reasons hard over a large multimodal input can exhaust
   * maxOutputTokens before emitting a single character of output — which
   * arrives as an empty completion rather than as an error naming a cause.
   */
  effort?: "low" | "medium" | "high" | "xhigh";
  /**
   * When set, the provider should coerce the model into returning JSON that
   * matches this shape. Providers without native JSON mode should fall back to
   * instructing the model and letting the caller parse defensively.
   */
  jsonSchemaName?: string;
  signal?: AbortSignal;
  /**
   * Pictures of the thing being described, for a provider that can see.
   *
   * The structured audit is a reading of the markup, and markup lies by
   * omission — a scripted button with no href reads as "no conversion path"
   * and looks like an obvious opt-in to anyone with eyes. These let the model
   * check the reading against the page.
   */
  images?: LlmImage[];
  /**
   * What this call is for, in the operator's words.
   *
   * Used only for cost attribution: it becomes the line on the Expenditure
   * page, so "Outreach email" tells someone what their money bought where the
   * model name and token count cannot.
   */
  purpose?: string;
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
