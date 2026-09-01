import "server-only";
import { AppError } from "../errors";
import { safeJson } from "../client-knowledge/profile";
import { getProvider } from "../llm/registry";
import { LlmError, type LlmImage } from "../llm/types";
import type { EmailContext } from "./context";
import { EMAIL_SYSTEM_PROMPT, buildEmailPrompt } from "./prompt";
import {
  correctionInstruction,
  parseGeneratedEmail,
  validateGeneratedEmail,
  type GeneratedEmail,
  type Violation,
} from "./validate";

/**
 * The only entry point the rest of the app uses.
 *
 *   generateEmail(context) -> { email, warnings, ... }
 *
 * Callers do not know which model produced it, whether it was retried, or how
 * the guardrails are implemented.
 */

export interface EmailGenerationResult {
  email: GeneratedEmail;
  /** Violations that survived the corrective retry. Surfaced in the UI. */
  warnings: Violation[];
  /** True when the first attempt broke a hard rule and was regenerated. */
  regenerated: boolean;
  provider: string;
  model: string | null;
}

export async function generateEmail(context: EmailContext): Promise<EmailGenerationResult> {
  const provider = getProvider();
  const basePrompt = buildEmailPrompt(context);

  const first = await complete(provider, basePrompt, context.screenshots);
  let validation = validateGeneratedEmail(first, context);

  if (validation.hardViolations.length === 0) {
    return {
      email: first,
      warnings: validation.violations,
      regenerated: false,
      provider: provider.id,
      model: null,
    };
  }

  // One corrective attempt. Two would rarely help and would double the latency.
  const corrected = await complete(
    provider,
    `${basePrompt}\n\n${correctionInstruction(validation.hardViolations)}`,
  ).catch(() => null);

  if (!corrected) {
    return {
      email: first,
      warnings: validation.violations,
      regenerated: false,
      provider: provider.id,
      model: null,
    };
  }

  validation = validateGeneratedEmail(corrected, context);
  return {
    email: corrected,
    warnings: validation.violations,
    regenerated: true,
    provider: provider.id,
    model: null,
  };
}

async function complete(
  provider: ReturnType<typeof getProvider>,
  prompt: string,
  images: LlmImage[] = [],
): Promise<GeneratedEmail> {
  let text: string;
  try {
    const response = await provider.complete({
      jsonSchemaName: "outreach_email",
      purpose: "Outreach email",
      images,
      temperature: 0.7,
      messages: [
        { role: "system", content: EMAIL_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    text = response.text;
  } catch (error) {
    if (error instanceof LlmError && error.kind === "unavailable") {
      throw new AppError("llm_unavailable", error.message);
    }
    throw new AppError("llm_failed", error instanceof Error ? error.message : String(error));
  }

  const parsed = parseGeneratedEmail(safeJson(text));
  if (!parsed) throw new AppError("llm_bad_response", "could not parse an email from the model output");
  return parsed;
}
