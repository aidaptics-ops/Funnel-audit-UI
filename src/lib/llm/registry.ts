import "server-only";
import { config } from "../config";
import { MockLlmProvider } from "./providers/mock";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible";
import { LlmError, type LlmProvider } from "./types";

/**
 * Provider selection. Adding a model later is a two-line change here plus one
 * new file under `providers/` — no other part of the app knows the difference.
 *
 * No model is named anywhere in this file. Which model runs is LLM_MODEL, so
 * moving between a cheap test model and a production one is a config edit, not
 * a deployment. "openai_compatible" is the same adapter pointed at any other
 * OpenAI-shaped endpoint via LLM_BASE_URL.
 */
const providers = new Map<string, LlmProvider>();

function register(provider: LlmProvider): void {
  providers.set(provider.id, provider);
}

register(new MockLlmProvider());

register(new AnthropicProvider());

register(
  new OpenAiCompatibleProvider({
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    attribution: { referer: "https://localhost/funnel-audit", title: "Funnel Audit Dashboard" },
  }),
);

register(
  new OpenAiCompatibleProvider({
    id: "openai_compatible",
    label: "OpenAI-compatible endpoint",
    // No default: pointing this at a host is the operator's explicit choice.
    defaultBaseUrl: "",
  }),
);

export function getProvider(): LlmProvider {
  const requested = config.llm.provider.toLowerCase();
  const provider = providers.get(requested);

  if (!provider) {
    // Misconfiguration must not take the app down: fall back to the mock and
    // let the UI say plainly that no model is wired up.
    return providers.get("mock")!;
  }
  if (!provider.isConfigured()) {
    throw new LlmError(`Provider "${provider.id}" is selected but not configured.`, "unavailable");
  }
  return provider;
}

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  isMock: boolean;
  model: string | null;
}

/** Safe to send to the browser: contains no key material. */
export function providerStatus(): ProviderStatus {
  const requested = config.llm.provider.toLowerCase();
  const provider = providers.get(requested) ?? providers.get("mock")!;
  return {
    id: provider.id,
    label: provider.label,
    configured: provider.isConfigured() && providers.has(requested),
    isMock: provider.id === "mock",
    model: config.llm.model || null,
  };
}

export function availableProviders(): string[] {
  return [...providers.keys()];
}
