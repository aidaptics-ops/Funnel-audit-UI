import "server-only";
import { safeJson } from "../client-knowledge/profile";
import { getProvider } from "../llm/registry";
import { LlmError, type LlmImage } from "../llm/types";
import type { RawEvidence, RawScreenshot } from "../audit/types";
import {
  computeRelationship,
  renderPageEvidence,
  type RelationshipBlock,
  type RenderedEvidence,
} from "./evidence";
import { FUNNEL_ANALYSIS_SYSTEM_PROMPT, buildFunnelImages, buildFunnelPrompt } from "./prompt";
import { parseFunnelAnalysis, type FunnelAnalysisResult } from "./schema";
import { verifyFindings, type VerificationResult } from "./verify";

/**
 * One model call over both pages, then the verifier.
 *
 * NOTHING CALLS THIS YET. It is wired up in the next phase; today it exists,
 * typechecks and is covered by tests of its pure parts, and the dashboard
 * behaves exactly as it did before.
 *
 * The verification is not optional and is not left to the caller. This
 * function is the only thing in the app that holds both the evidence indexes
 * and the model's claims at the same moment, and a caller that received
 * unverified findings would have no way to check them afterwards. Handing back
 * an unchecked `FunnelAnalysisResult` would be handing back a loaded gun.
 */

/** A distinct label, so the cost meter keeps this off the "Outreach email" line. */
const PURPOSE = "Funnel analysis (two pages)";

/**
 * Headroom above what a ten-finding response should need.
 *
 * FUNNEL_ANALYSIS_SYSTEM_PROMPT ("OUTPUT") now caps the model at ten findings
 * explicitly, so this no longer has to guess how many the model might decide
 * to write. 12000 is roughly 50% over what ten findings with real
 * descriptions, recommendations and citations run to in practice — there to
 * absorb one unusually verbose finding without truncating the response and
 * forcing the repair retry (below) to run at all, which is both slower and
 * costs real money on the same request.
 *
 * Reasoning depth is not set here: the Anthropic provider runs every call at
 * high effort already, and the owner approved full depth and cost for this
 * one. If a per-call effort knob is ever added to LlmRequest, this is the call
 * that should ask for the maximum explicitly.
 */
/*
 * Thinking is spent out of THIS budget, not beside it.
 *
 * At 12000 a high-effort pass over the page images spent the whole
 * allowance reasoning and returned no text at all — logged in production as
 * "Anthropic returned an empty completion". The ceiling costs nothing when
 * it is not reached, so it is now generous enough that the answer always
 * has room after the thinking.
 */
const MAX_OUTPUT_TOKENS = 32000;

export interface FunnelAnalysisPage {
  url: string;
  evidence: RawEvidence | null | undefined;
  screenshot: RawScreenshot | null | undefined;
}

export interface FunnelAnalysisInput {
  landing: FunnelAnalysisPage;
  /** Screenshots the operator has supplied of the page after conversion, so far. */
  suppliedPostBooking: { label: string; mediaType: string; data: string }[];
  /**
   * The provider call's own deadline, in milliseconds — applied FRESH to each
   * of the two attempts below (the first, and the one-shot JSON-repair retry),
   * never as one AbortSignal built once and shared between them.
   *
   * A shared signal meant a slow first attempt — ten image strips, adaptive
   * thinking, routinely past ninety seconds — could burn through most or all
   * of the budget before the repair retry even started, starving the one
   * mechanism whose entire purpose is to give the model a genuine second
   * chance at parseable JSON. Each attempt now gets the full budget on its own
   * clock. Omit for no deadline.
   */
  analysisTimeoutMs?: number;
}

export interface FunnelAnalysisOutcome {
  result: FunnelAnalysisResult;
  /** What survived, and what was thrown away with the reason why. */
  verification: VerificationResult;
  landingEvidence: RenderedEvidence;
  relationship: RelationshipBlock;
  /** True when the first response had to be sent back for repair. */
  repaired: boolean;
}

/**
 * Returns null rather than throwing when the model cannot produce an analysis.
 *
 * Null is a deliberate contract: the caller degrades to the legacy
 * `observed_issues` path, which is dull but real. The alternative — throwing,
 * or returning an empty result that reads like "this funnel has no problems" —
 * would turn a model outage into a claim about somebody's page.
 */
export async function analyzeFunnel(input: FunnelAnalysisInput): Promise<FunnelAnalysisOutcome | null> {
  const landingEvidence = renderPageEvidence(input.landing.evidence, "landing");

  // There is no crawl of a second URL, so nothing about the post-booking page
  // is ever a comparison — every field about it comes back null, honestly.
  const relationship = computeRelationship(input.landing.evidence, null);

  const images = buildFunnelImages(input.landing.screenshot, input.suppliedPostBooking);
  const landingStrips = images.filter((image) => image.caption.startsWith("LANDING PAGE")).length;

  const prompt = buildFunnelPrompt({
    landing: { url: input.landing.url, evidence: landingEvidence, screenshotStrips: landingStrips },
    suppliedPostBooking: input.suppliedPostBooking,
    relationship,
  });

  const first = await complete(prompt, images, input.analysisTimeoutMs);
  let result = first === null ? null : parseFunnelAnalysis(safeJson(first));
  let repaired = false;

  if (result === null && first !== null) {
    // One repair attempt, and only one. A second would double the latency of
    // the most expensive call in the app to rescue a case that is nearly
    // always the model having run out of output tokens rather than having
    // mangled its braces.
    //
    // This gets the SAME full timeout budget as the first attempt, not
    // whatever was left of it — see the doc comment on `analysisTimeoutMs`.
    repaired = true;
    const second = await complete(`${prompt}\n\n${repairInstruction(first)}`, images, input.analysisTimeoutMs);
    result = second === null ? null : parseFunnelAnalysis(safeJson(second));
  }

  if (result === null) return null;

  return {
    result,
    verification: verifyFindings(result, {
      landing: landingEvidence,
      suppliedPostBookingCount: input.suppliedPostBooking.length,
    }),
    landingEvidence,
    relationship,
    repaired,
  };
}

/**
 * One provider call. A failure becomes null rather than an exception.
 *
 * Every failure is treated the same way for the CALLER on purpose. An
 * unconfigured provider, a rate limit and a refusal have different causes but
 * one correct response here: fall back to the legacy path. Swallowing them
 * into a single `null` also keeps provider detail — which can carry a base
 * URL or a key-shaped string — out of anything a user could ever see.
 *
 * That does not mean the detail is thrown away. It is logged below, because
 * "the two-page analysis did not complete" with no further trace is exactly
 * what made a real production failure unexplainable after the fact.
 */
async function complete(prompt: string, images: LlmImage[], timeoutMs?: number): Promise<string | null> {
  try {
    const response = await getProvider().complete({
      jsonSchemaName: "funnel_analysis",
      purpose: PURPOSE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // Medium, not the default high: this call reads evidence and reports
      // what it finds, and the citation verifier — not the model's own
      // deliberation — is what makes a finding trustworthy. Less thinking is
      // also less latency and less money on the single slowest call here.
      effort: "medium",
      // Low, not zero: the findings are judgements about a page, and a
      // deterministic decode on this kind of task reliably produces the same
      // four safe observations about every funnel.
      temperature: 0.3,
      images,
      // Built fresh for THIS call. See the doc comment on
      // FunnelAnalysisInput.analysisTimeoutMs for why this may not be shared
      // between the first attempt and the repair retry.
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      messages: [
        { role: "system", content: FUNNEL_ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    return response.text;
  } catch (error) {
    // Every LlmProvider is required to convert whatever it caught into an
    // LlmError before it reaches its caller (see src/lib/llm/types.ts), so
    // `.kind` is available whenever the failure came from a provider at all —
    // "unavailable" (misconfigured), "failed" (network, rate limit, refusal,
    // abort) or "bad_response" (empty completion). `error.message` on that
    // type is provider prose about the failure itself, never the prompt, the
    // images, or a key. "unknown" only fires for a bug that threw something
    // that never went through a provider.
    const kind = error instanceof LlmError ? error.kind : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[analysis] completion failed (${kind}): ${message}`);
    return null;
  }
}

function repairInstruction(previous: string): string {
  return (
    "Your previous reply could not be parsed as JSON. Return the SAME analysis again as a single " +
    "valid JSON object, with no prose around it and no code fence. Do not add findings, remove " +
    "findings, or change any citation.\n\nYour previous reply was:\n" +
    previous.slice(0, 4000)
  );
}
