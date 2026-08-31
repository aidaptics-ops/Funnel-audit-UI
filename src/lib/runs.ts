import { parseContacts, type ContactCandidate } from "./contacts";
import type { FunnelRecord } from "./sheets/types";
import type { FunnelStage } from "./types";

/**
 * A past run, rebuilt from one spreadsheet row.
 *
 * The sheet is the source of truth for history, so this is the only place that
 * knows how a row maps back to something the UI can render. Rows are written by
 * people as well as by us, so every field is treated as untrusted text.
 */
export interface RunSummary {
  url: string;
  domain: string;
  brand: string;
  stage: FunnelStage;
  funnelType: string;
  conversionGoal: string;
  ownerName: string;
  ownerEmail: string;
  ownerEmailKind: string;
  /** Every address found for this funnel, not only the approved one. */
  contacts: ContactCandidate[];
  /** True once the operator has accepted one of them. */
  emailApproved: boolean;
  topIssues: string[];
  issueCount: number;
  warningCount: number;
  emailSubject: string;
  emailBody: string;
  emailAngle: string;
  approved: boolean;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
  /** The trimmed audit, when the row carries one. */
  audit: RunAudit | null;
}

export interface RunAudit {
  finalUrl?: string;
  domain?: string;
  brand?: string | null;
  pageTitle?: string | null;
  funnelType?: string | null;
  pageType?: string | null;
  conversionGoal?: string | null;
  headline?: string | null;
  subheadline?: string | null;
  primaryCta?: string | null;
  analyzedAt?: string | null;
  jobId?: string | null;
  issues?: {
    id?: string;
    title?: string;
    severity?: string;
    category?: string;
    description?: string;
    recommendation?: string;
    impact?: string | null;
    evidence?: string[];
  }[];
}

/**
 * Rows written before `stage` existed, or edited by hand, still have to land
 * somewhere sensible — so the stage is inferred from what the row does contain
 * rather than trusted blindly.
 */
const KNOWN_STAGES: FunnelStage[] = [
  "queued",
  "analyzing",
  "generating",
  "ready",
  "approved",
  "saved",
  "failed",
];

export function toRun(record: FunnelRecord): RunSummary {
  const audit = parseAudit(record.audit_json);
  const issues = audit?.issues ?? [];

  return {
    url: record.funnel_url,
    domain: record.domain,
    brand: record.company_name,
    stage: readStage(record),
    funnelType: record.funnel_type,
    conversionGoal: record.conversion_goal,
    ownerName: record.owner_name,
    ownerEmail: record.owner_email,
    ownerEmailKind: record.owner_email_kind,
    contacts: parseContacts(record.contacts_json),
    emailApproved: record.owner_email_approved === "true",
    topIssues: [record.top_issue_1, record.top_issue_2, record.top_issue_3].filter(Boolean),
    issueCount: issues.length,
    warningCount: Number(record.email_warnings) || 0,
    emailSubject: record.email_subject,
    emailBody: record.email_body,
    emailAngle: record.email_angle,
    approved: record.email_approved === "true",
    errorMessage: record.error_message,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    audit,
  };
}

function readStage(record: FunnelRecord): FunnelStage {
  const stated = record.stage as FunnelStage;
  if (KNOWN_STAGES.includes(stated)) return stated;

  if (record.audit_status === "failed") return "failed";
  if (record.email_approved === "true") return "approved";
  if (record.email_subject) return "ready";
  return record.audit_status === "complete" ? "ready" : "queued";
}

function parseAudit(raw: string): RunAudit | null {
  if (!raw || !raw.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as RunAudit;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // A truncated or hand-edited cell must not break the history page.
    return null;
  }
}

/** Newest first — what someone opening the page wants to see. */
export function sortRuns(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}
