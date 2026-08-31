/**
 * Shared browser-side types. Kept free of `server-only` imports so client
 * components can use them.
 */
import type { NormalizedAudit } from "./audit/normalize";
import type { GeneratedEmail, Violation } from "./email/validate";
import type { IdentityResult } from "./identity/types";

export type { NormalizedAudit, GeneratedEmail, Violation, IdentityResult };

export type FunnelStage =
  | "queued"
  | "analyzing"
  | "generating"
  | "ready"
  | "approved"
  | "saved"
  | "failed";

/**
 * What the UI shows, which is not quite what the queue tracks.
 *
 * "Ready" splits in two: an email the validator was happy with, and one that
 * needs a human to look at a warning before it goes anywhere. Those deserve
 * different colours — the whole point of the review step is that the second
 * kind should not slide past.
 */
export type DisplayStatus = FunnelStage | "needs_review";

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  queued: "Queued",
  analyzing: "Analyzing",
  generating: "Writing email",
  ready: "Ready",
  needs_review: "Needs review",
  approved: "Approved",
  saved: "Saved",
  failed: "Failed",
};

/** Ready + warnings (or a missing email) means a person has to look. */
export function displayStatus(input: {
  stage: FunnelStage;
  warningCount?: number;
  hasEmail?: boolean;
}): DisplayStatus {
  if (input.stage !== "ready") return input.stage;
  if (input.hasEmail === false) return "needs_review";
  return (input.warningCount ?? 0) > 0 ? "needs_review" : "ready";
}

export const STAGE_LABEL: Record<FunnelStage, string> = {
  queued: "Queued",
  analyzing: "Analyzing",
  generating: "Generating email",
  ready: "Ready for review",
  approved: "Approved",
  saved: "Saved",
  failed: "Failed",
};

export interface EmailPayload extends GeneratedEmail {
  warnings?: Violation[];
  regenerated?: boolean;
  provider?: string;
}

export interface FunnelItem {
  id: string;
  url: string;
  stage: FunnelStage;
  audit: NormalizedAudit | null;
  email: EmailPayload | null;
  /** Set when the operator edits the generated email. */
  editedEmail: { subject: string; email: string } | null;
  error: { code: string; message: string } | null;
  /** A non-fatal problem, e.g. the audit worked but the email did not. */
  notice: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** The operator confirmed they personally completed the conversion action. */
  performedAction: boolean;
  /** Who the funnel belongs to, as resolved after the audit. */
  identity: IdentityResult | null;
  /** Operator-confirmed owner, which overrides every heuristic. */
  confirmedName: string | null;
  confirmedEmail: string | null;
  /** A paid enrichment lookup is in flight for this funnel. */
  enriching?: boolean;
  /** People RocketReach knows about here. Free to find; paid to contact. */
  rocketReachProfiles?: RocketReachProfile[];
  /** The last owner-search run for this funnel, with its audit trail. */
  ownerSearch?: OwnerSearch | null;
  /** A save is in flight. Guards against a double click writing two rows. */
  saving?: boolean;
  /** The contact address the operator accepted. Only this reaches the sheet. */
  approvedEmail: string | null;
  /** Addresses the operator refused; never proposed again for this funnel. */
  rejectedEmails: string[];
}

/**
 * Which lookup to run, and therefore what it costs.
 *
 * "auto" is the chained path the UI offers by default: a free check of whether
 * Hunter holds anything, a paid search only if it does, then a free
 * RocketReach search when no owner turned up.
 */
export type EnrichProvider =
  | "find_owner"
  | "auto"
  | "hunter"
  | "rocketreach_search"
  | "rocketreach_lookup";

/** One stage of the owner search, with what it actually cost. */
export interface OwnerSearchStep {
  name: string;
  outcome: string;
  cost: string;
}

export interface OwnerVerification {
  address: string;
  result: string;
  usable: boolean;
  confirmed: boolean;
  summary: string;
}

/** What the company -> founder -> address -> verification chain produced. */
export interface OwnerSearch {
  companyName: string | null;
  founderName: string | null;
  founderTitle: string | null;
  chosen: { address: string; source: string; verification: OwnerVerification } | null;
  candidates: { address: string; source: string; verification: OwnerVerification | null }[];
  evidence: { claim: string; source: string }[];
  steps: OwnerSearchStep[];
  reason: string;
}

/** A RocketReach profile before any credit has been spent on it. */
export interface RocketReachProfile {
  id: number;
  fullName: string;
  title: string | null;
  employer: string | null;
  linkedinUrl: string | null;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface StatusPayload {
  enrichment?: {
    hunter: {
      configured: boolean;
      creditsRemaining: number | null;
      creditsAvailable: number | null;
      resetsAt: string | null;
    };
    rocketreach: {
      configured: boolean;
      lookupsRemaining: number | null;
      lookupsAllocated: number | null;
    };
  };
  audit: { ok: boolean; activeAnalyses: number | null; maxConcurrent: number | null; version: string | null };
  llm: { id: string; label: string; configured: boolean; isMock: boolean; model: string | null };
  knowledge: {
    emailCount: number;
    hasProfile: boolean;
    storage: { kind: string; durable: boolean };
  };
  sheets: { configured: boolean };
}
