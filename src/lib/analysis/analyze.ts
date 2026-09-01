import "server-only";
import { safeJson } from "../client-knowledge/profile";
import { getProvider } from "../llm/registry";
import type { LlmImage } from "../llm/types";
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
 * Enough for a dozen findings with real descriptions and citations.
 *
 * Reasoning depth is not set here: the Anthropic provider runs every call at
 * high effort already, and the owner approved full depth and cost for this
 * one. If a per-call effort knob is ever added to LlmRequest, this is the call
 * that should ask for the maximum explicitly.
 */
const MAX_OUTPUT_TOKENS = 8000;

export interface FunnelAnalysisPage {
  url: string;
  evidence: RawEvidence | null | undefined;
  screenshot: RawScreenshot | null | undefined;
}

export interface FunnelAnalysisInput {
  landing: FunnelAnalysisPage;
  /** Screenshots the operator has supplied of the page after conversion, so far. */
  suppliedPostBooking: { label: string; mediaType: string; data: string }[];
  signal?: AbortSignal;
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

  const first = await complete(prompt, images, input.signal);
  let result = first === null ? null : parseFunnelAnalysis(safeJson(first));
  let repaired = false;

  if (result === null && first !== null) {
    // One repair attempt, and only one. A second would double the latency of
    // the most expensive call in the app to rescue a case that is nearly
    // always the model having run out of output tokens rather than having
    // mangled its braces.
    repaired = true;
    const second = await complete(`${prompt}\n\n${repairInstruction(first)}`, images, input.signal);
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
 * Every failure is treated the same way on purpose. An unconfigured provider,
 * a rate limit and a refusal have different causes but one correct response
 * here: fall back to the legacy path. Swallowing them in one place also keeps
 * provider detail — which can carry a base URL or a key-shaped string — out of
 * anything a user could ever see.
 */
async function complete(prompt: string, images: LlmImage[], signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await getProvider().complete({
      jsonSchemaName: "funnel_analysis",
      purpose: PURPOSE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // Low, not zero: the findings are judgements about a page, and a
      // deterministic decode on this kind of task reliably produces the same
      // four safe observations about every funnel.
      temperature: 0.3,
      images,
      ...(signal ? { signal } : {}),
      messages: [
        { role: "system", content: FUNNEL_ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    return response.text;
  } catch {
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
