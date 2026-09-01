import { AppError, POST_BOOKING_EVIDENCE_MESSAGE } from "../errors";
import { isPrivateHost } from "../ssrf";
import { normalizeFunnelUrl, type NormalizedUrl } from "../url";
import { buildObservability, normalizeAudit, type AuditFinding, type NormalizedAudit } from "../audit/normalize";
import type { AuditResult, RunAuditOptions } from "../audit/client";
import type { RawScreenshot } from "../audit/types";
import type { FunnelAnalysisInput, FunnelAnalysisOutcome } from "./analyze";
import type { FunnelClassification } from "./schema";
import type { VerifiedFinding } from "./verify";

/**
 * What /api/analyze actually does, with its effects handed in.
 *
 * This module holds the decisions — when the analysis degrades, and whether an
 * email may be written at all — and none of the machinery. The three things it
 * needs that only exist on a server (the audit client, the analysis call, the
 * attachment store) arrive as injected functions.
 *
 * That split is not decoration. Every one of those decisions is a rule the
 * product owner settled, and none of them could be tested at all while they
 * lived inside a route module that imports `server-only` and therefore cannot
 * be loaded by the test runner. The route below this is wiring.
 */

/* --------------------------------- the URL -------------------------------- */

/**
 * The one guard every funnel URL goes through.
 *
 * There used to be a second URL — the confirmation page to crawl — guarded the
 * same way. That crawl is gone: the only source of post-booking evidence now
 * is a screenshot the operator uploads himself, which never touches this
 * function at all.
 */
export function guardFunnelUrl(input: unknown): NormalizedUrl {
  const url = normalizeFunnelUrl(input);
  if (isPrivateHost(url.hostname)) throw new AppError("private_host");
  return url;
}

/* -------------------------------- the gate -------------------------------- */

/** Why no email was written. Machine-readable; the message is for the operator. */
export type EmailBlockReason = "post_booking_evidence_required";

/**
 * Re-exported rather than restated. Two things now say this sentence — the
 * pipeline, which withholds the email during a run, and /api/generate-email,
 * which refuses to write one afterwards — and the vocabulary in `errors.ts`
 * is where a message both of them use has to live.
 */
export const EMAIL_BLOCKED_MESSAGE = POST_BOOKING_EVIDENCE_MESSAGE;

export interface EmailGate {
  allowed: boolean;
  reason: EmailBlockReason | null;
  /** Empty when allowed. Never contains an internal detail. */
  message: string;
  suppliedScreenshots: number;
}

/**
 * THE GATE, down to one condition.
 *
 * Post-booking evidence used to have two possible sources — a crawled page
 * that was really observed, or screenshots the operator supplied — and this
 * function combined them. There is no crawl of a second URL any more, so
 * there is only the one source left, and the gate is exactly that question:
 * has the operator supplied at least one screenshot of the page after
 * conversion?
 *
 * With none, the run still completes and still persists its findings — but no
 * email is written, because every email this system sends leans on the stage
 * after the conversion and there is nothing behind that lean.
 */
export function decideEmailGate(suppliedScreenshots: number): EmailGate {
  const allowed = suppliedScreenshots > 0;
  return {
    allowed,
    reason: allowed ? null : "post_booking_evidence_required",
    message: allowed ? "" : EMAIL_BLOCKED_MESSAGE,
    suppliedScreenshots,
  };
}

/* ------------------------------- the pipeline ----------------------------- */

/**
 * Why the analysis could not produce findings.
 *
 * Both degrade identically and both are stated on the run. The alternative —
 * a run that quietly shows fewer findings — is indistinguishable from a funnel
 * with fewer problems, which is a lie told by omission.
 */
export type DegradeReason =
  /** The audit API build predates `raw_evidence`. The repos deploy separately. */
  | "no_raw_evidence"
  /** The model call, and its one repair attempt, did not return JSON. */
  | "analysis_unavailable";

export const DEGRADE_MESSAGE: Record<DegradeReason, string> = {
  no_raw_evidence:
    "The audit service did not return page evidence, so the two-page analysis could not run. " +
    "The findings below come from the crawler's own checks.",
  analysis_unavailable:
    "The two-page analysis did not complete, so the findings below come from the crawler's own checks.",
};

export interface FunnelPipelineDeps<TIdentity> {
  runAudit(url: string, opts: RunAuditOptions): Promise<AuditResult>;
  analyzeFunnel(input: FunnelAnalysisInput): Promise<FunnelAnalysisOutcome | null>;
  /** Screenshots the operator has supplied of the page after conversion, so far. */
  suppliedPostBooking(url: string): Promise<{ label: string; mediaType: string; data: string }[]>;
  /**
   * The founder-identity chain, exactly as the route has always run it.
   *
   * Injected rather than imported so this module never grows an opinion about
   * it: that chain is a product requirement that works, and its only
   * requirement here is that it runs concurrently with the analysis.
   */
  identity(landing: AuditResult, provisional: NormalizedAudit): Promise<TIdentity>;
  /** The analysis call's own deadline. Omit for none. */
  analysisTimeoutMs?: number;
}

export interface FunnelPipelineResult<TIdentity> {
  audit: NormalizedAudit;
  identity: TIdentity;
  /** "incomplete" whenever the analysis degraded. */
  auditStatus: "complete" | "incomplete";
  degraded: DegradeReason | null;
  gate: EmailGate;
  /**
   * The rendered landing page, for the email context.
   *
   * Carried through rather than re-read: the pictures are the only defence
   * against a confident, wrong reading of the markup, and the caller no longer
   * holds the raw audit this came from.
   */
  landingScreenshot: RawScreenshot | null;
  /** Kept for the response; never persisted whole. */
  analysis: FunnelAnalysisOutcome | null;
  /** Non-fatal things this run wants to say about itself. */
  reasons: string[];
}

export async function runFunnelPipeline<TIdentity>(
  deps: FunnelPipelineDeps<TIdentity>,
  landing: NormalizedUrl,
): Promise<FunnelPipelineResult<TIdentity>> {
  const auditResult = await deps.runAudit(landing.href, { captureProfile: "full" });

  /*
   * A first reading of the landing page, for the identity chain only.
   *
   * It carries no findings, which is exactly the shape the identity chain has
   * always been handed — it reads the brand, the domain, the final URL, the
   * page title, the headline and the contact addresses, and every one of
   * those is derived from the landing capture alone. Recomputing it below with
   * the findings attached therefore changes nothing the founder pipeline ever
   * looked at.
   */
  const provisional = normalizeAudit(auditResult.analysis, {
    jobId: auditResult.jobId,
    requestedUrl: landing.href,
  });

  // A cheap local read, done once up front: both the analysis call and the
  // final audit need to know how many screenshots exist, and the count must
  // not drift between the two.
  const supplied = await deps.suppliedPostBooking(landing.href).catch(() => []);
  const suppliedCount = supplied.length;

  /*
   * TWO SEQUENCES, NOT TWO STEPS.
   *
   * The two-page analysis is one sequence, and the identity chain is another
   * (findOwner is gated on the resolved identity — it reads
   * identity.company.domain and identity.people, and only runs when that
   * identity came back without an owner address — so it cannot be hoisted out
   * and started early). Racing them concurrently overlaps the fast leg and the
   * expensive one — the owner search — instead of running them one after the
   * other.
   */
  /*
   * allSettled, not all — and the difference is money.
   *
   * The identity leg spends real credits (a web search, sometimes a Hunter
   * credit, a NeverBounce check) and the route reads the ambient cost ledger
   * in its catch. A rejection from Promise.all returns while the other leg is
   * still in flight, so everything it records after that moment lands in a
   * ledger nobody reads again and the Expenditure page under-reports. Waiting
   * for both to settle before rethrowing costs nothing on the happy path and
   * makes the ledger complete on the unhappy one.
   */
  const [legResult, identityResult] = await Promise.allSettled([
    analysisLeg(deps, landing, auditResult, supplied),
    deps.identity(auditResult, provisional),
  ]);
  if (legResult.status === "rejected") throw legResult.reason;
  if (identityResult.status === "rejected") throw identityResult.reason;
  const leg = legResult.value;
  const identity = identityResult.value;

  const findings = leg.analysis ? toAuditFindings(leg.analysis.verification.kept) : [];

  // With `findings` empty, normalizeAudit falls back to the crawler's own
  // `observed_issues` on its own. That is the degraded path's fallback, and it
  // is reached by handing over an empty list rather than by a second code path.
  const base = normalizeAudit(auditResult.analysis, {
    jobId: auditResult.jobId,
    requestedUrl: landing.href,
    findings,
    suppliedScreenshotCount: suppliedCount,
  });

  const audit = leg.degraded
    ? markUnanalysed(base, leg.degraded)
    : applyClassification(base, leg.analysis?.result.classification ?? null, suppliedCount);

  const gate = decideEmailGate(suppliedCount);

  const reasons: string[] = [];
  if (leg.degraded) reasons.push(DEGRADE_MESSAGE[leg.degraded]);
  if (!gate.allowed) reasons.push(gate.message);

  return {
    audit,
    identity,
    auditStatus: leg.degraded ? "incomplete" : "complete",
    degraded: leg.degraded,
    gate,
    landingScreenshot: auditResult.analysis.screenshot ?? null,
    analysis: leg.analysis,
    reasons,
  };
}

interface AnalysisLeg {
  analysis: FunnelAnalysisOutcome | null;
  degraded: DegradeReason | null;
}

async function analysisLeg<TIdentity>(
  deps: FunnelPipelineDeps<TIdentity>,
  landing: NormalizedUrl,
  auditResult: AuditResult,
  supplied: { label: string; mediaType: string; data: string }[],
): Promise<AnalysisLeg> {
  /*
   * An audit API old enough to have no `raw_evidence` cannot be analysed.
   *
   * The two services deploy independently, so this is a normal Tuesday rather
   * than an outage. Checked before the model call, not after: there is nothing
   * to send it, and spending full reasoning depth on an empty inventory would
   * buy findings with no evidence behind them.
   */
  if (!auditResult.analysis.raw_evidence) {
    return { analysis: null, degraded: "no_raw_evidence" };
  }

  const analysis = await deps.analyzeFunnel({
    landing: {
      url: landing.href,
      evidence: auditResult.analysis.raw_evidence,
      screenshot: auditResult.analysis.screenshot,
    },
    suppliedPostBooking: supplied,
    ...(deps.analysisTimeoutMs ? { signal: AbortSignal.timeout(deps.analysisTimeoutMs) } : {}),
  });

  if (!analysis) return { analysis: null, degraded: "analysis_unavailable" };
  return { analysis, degraded: null };
}

/* ------------------------- applying what came back ------------------------ */

/**
 * The model's reading of the landing page, folded into the normalised audit.
 *
 * Additive, never subtractive. Every field here already has a heuristic answer
 * derived from the markup, and that answer exists on runs where the analysis
 * failed; a null from the model means "I did not say", not "there is none".
 * `hasScheduler` and `isVsl` are OR-ed for the same reason in reverse: the
 * model can see a scheduler that renders as a bare div, which the markup
 * heuristic cannot, and neither one may erase the other's sighting.
 */
export function applyClassification(
  audit: NormalizedAudit,
  classification: FunnelClassification | null,
  suppliedScreenshotCount: number,
): NormalizedAudit {
  if (!classification) return audit;

  const hasScheduler = audit.hasScheduler || classification.bookingStepVisible;

  return {
    ...audit,
    funnelType: classification.funnelType ?? audit.funnelType,
    pageType: classification.pageType ?? audit.pageType,
    conversionGoal: classification.conversionGoal ?? audit.conversionGoal,
    primaryCta: classification.primaryCta ?? audit.primaryCta,
    valueProposition: {
      clarity: classification.valueProposition.clarity ?? audit.valueProposition.clarity,
      statement: classification.valueProposition.statement ?? audit.valueProposition.statement,
    },
    offer: { ...audit.offer, clarity: classification.offerClarity ?? audit.offer.clarity },
    isVsl: audit.isVsl || classification.isVsl,
    hasScheduler,
    // Rebuilt rather than patched: `bookingStepVisible` is derived from
    // hasScheduler, and the notes are derived from both. Editing one field of
    // an observability record leaves the prose beside it contradicting it.
    observability: buildObservability(hasScheduler, audit.forms.length > 0, suppliedScreenshotCount),
  };
}

/**
 * A degraded run, saying so.
 *
 * The analysis model never got to look at the page, so its classification
 * cannot be applied — but that has nothing to do with whether a screenshot of
 * the post-booking stage exists, which `normalizeAudit` has already worked out
 * from the operator's own uploads. This only adds the note.
 */
export function markUnanalysed(audit: NormalizedAudit, reason: DegradeReason): NormalizedAudit {
  return {
    ...audit,
    observability: {
      ...audit.observability,
      notes: [...audit.observability.notes, DEGRADE_MESSAGE[reason]],
    },
  };
}

/**
 * Verified findings, in the shape the normaliser reads.
 *
 * Each citation becomes one evidence line (the quote, tagged with the page it
 * was quoted from) and one citation string (the dotted path it came from).
 * Only citations that survived verification are here — `verifyFindings` has
 * already moved the rest into `rejectedCitations`, and nothing downstream may
 * quote those.
 */
export function toAuditFindings(kept: VerifiedFinding[]): AuditFinding[] {
  return kept.map((finding) => ({
    id: finding.id,
    stage: finding.stage,
    claim_type: finding.claimType,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    description: finding.description,
    evidence: finding.citations.map((citation) => ({ text: citation.quote, page: citation.page })),
    citations: finding.citations.map((citation) => citation.field),
    recommendation: finding.recommendation,
    ...(finding.impact === null ? {} : { impact: finding.impact }),
    commercial_weight: finding.commercialWeight,
  }));
}
