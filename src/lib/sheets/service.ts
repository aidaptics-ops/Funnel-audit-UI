import "server-only";
import { config } from "../config";
import type { NormalizedAudit } from "../audit/normalize";
import type { IdentityResult } from "../identity/types";
import type { GeneratedEmail } from "../email/validate";
import { GoogleSheetsService } from "./google";
import { SHEET_COLUMNS, emptyRecord, type FunnelRecord } from "./types";

/**
 * The Google Sheets seam.
 *
 * Two implementations sit behind it: the real one in ./google.ts, and a no-op
 * used until a service account and spreadsheet id are configured. The no-op is
 * deliberate — an operator must be able to run the whole workflow and approve
 * emails before any spreadsheet exists.
 */
export interface SheetsService {
  readonly configured: boolean;
  /** Insert or update by funnel_url. Returns the row written. */
  upsert(record: FunnelRecord): Promise<FunnelRecord>;
  list(): Promise<FunnelRecord[]>;
  /** Collapses duplicate funnel_url rows. Returns how many were removed. */
  dedupe(): Promise<number>;
  /** Removes the row for this URL entirely. Returns true if one went. */
  remove(url: string): Promise<boolean>;
}

class UnconfiguredSheetsService implements SheetsService {
  readonly configured = false;

  async upsert(record: FunnelRecord): Promise<FunnelRecord> {
    // Deliberately a no-op rather than a throw: an operator should be able to
    // run the whole workflow and approve emails before Sheets exists.
    return record;
  }

  async list(): Promise<FunnelRecord[]> {
    return [];
  }

  async dedupe(): Promise<number> {
    return 0;
  }

  async remove(): Promise<boolean> {
    return false;
  }
}

let instance: SheetsService | null = null;

export function sheetsService(): SheetsService {
  if (instance) return instance;
  instance = isSheetsConfigured() ? new GoogleSheetsService() : new UnconfiguredSheetsService();
  return instance;
}

/** Test seam: forget the memoised instance after config changes. */
export function resetSheetsService(): void {
  instance = null;
}

export function isSheetsConfigured(): boolean {
  return Boolean(config.sheets.serviceAccount && config.sheets.spreadsheetId);
}

/** Builds the operational row from whatever stage the funnel has reached. */
export function toRecord(input: {
  url: string;
  audit: NormalizedAudit | null;
  email: GeneratedEmail | null;
  auditStatus: string;
  emailStatus: string;
  approved?: boolean;
  edited?: boolean;
  createdAt?: string;
  identity?: IdentityResult | null;
  /** Only an address the operator accepted is written. */
  approvedEmail?: string | null;
  /** The canonical UI state, so history reads the same as the live queue. */
  stage?: string;
  errorMessage?: string | null;
  warningCount?: number;
}): FunnelRecord {
  const record = emptyRecord();
  const now = new Date().toISOString();
  const topIssues = (input.audit?.issues ?? []).slice(0, 3);

  record.funnel_url = input.url;
  record.domain = input.audit?.domain ?? "";
  record.company_name = input.audit?.brand ?? "";
  record.owner_name = input.identity?.owner?.fullName ?? "";

  // Priority: the owner's own address, then any other real address — but only
  // ever the one a human accepted. An address nobody approved is a lead we
  // have not verified, and writing it would make the sheet look decided.
  const candidates = [input.identity?.ownerEmail, input.identity?.fallbackEmail];
  const accepted = input.approvedEmail
    ? candidates.find((entry) => entry?.address === input.approvedEmail)
    : undefined;

  record.owner_email = input.approvedEmail ?? "";
  record.owner_email_kind = accepted
    ? accepted === input.identity?.ownerEmail
      ? "owner_personal"
      : `fallback_${accepted.kind}`
    : "";

  record.stage = input.stage ?? "";
  record.error_message = input.errorMessage ?? "";
  record.audit_status = input.auditStatus;
  record.audit_job_id = input.audit?.jobId ?? "";
  record.audit_completed_at = input.audit?.analyzedAt ?? "";

  record.funnel_type = input.audit?.funnelType ?? "";
  record.conversion_goal = input.audit?.conversionGoal ?? "";

  record.top_issue_1 = topIssues[0]?.title ?? "";
  record.top_issue_2 = topIssues[1]?.title ?? "";
  record.top_issue_3 = topIssues[2]?.title ?? "";

  record.email_status = input.emailStatus;
  record.email_subject = input.email?.subject ?? "";
  record.email_body = input.email?.email ?? "";
  record.email_angle = input.email?.angle ?? "";

  record.email_approved = input.approved ? "true" : "false";
  record.email_edited = input.edited ? "true" : "false";
  record.email_warnings = String(input.warningCount ?? 0);

  record.created_at = input.createdAt ?? now;
  record.updated_at = now;
  record.audit_json = input.audit ? compactAudit(input.audit) : "";

  return record;
}

/**
 * A cell-sized copy of the audit.
 *
 * Sheets caps a cell at 50,000 characters, and a full audit can exceed that.
 * This keeps everything the history view actually renders — the page's own
 * words and the findings — and drops the raw capture data, which nothing reads
 * back. Better a complete summary than a truncated document.
 */
const CELL_LIMIT = 45_000;

function compactAudit(audit: NormalizedAudit): string {
  const trimmed = {
    finalUrl: audit.finalUrl,
    domain: audit.domain,
    brand: audit.brand,
    pageTitle: audit.pageTitle,
    funnelType: audit.funnelType,
    pageType: audit.pageType,
    conversionGoal: audit.conversionGoal,
    headline: audit.headline,
    subheadline: audit.subheadline,
    primaryCta: audit.primaryCta,
    analyzedAt: audit.analyzedAt,
    jobId: audit.jobId,
    observability: audit.observability,
    issues: (audit.issues ?? []).map((issue) => ({
      id: issue.id,
      title: issue.title,
      severity: issue.severity,
      category: issue.category,
      description: issue.description,
      recommendation: issue.recommendation,
      impact: issue.impact,
      evidence: (issue.evidence ?? []).slice(0, 4),
    })),
  };

  const json = JSON.stringify(trimmed);
  if (json.length <= CELL_LIMIT) return json;

  // Shed evidence first, then recommendations — the titles and severities are
  // what the list view needs, and they are the last thing to go.
  const lean = {
    ...trimmed,
    issues: trimmed.issues.map((issue) => ({ ...issue, evidence: [] as string[] })),
  };
  const leanJson = JSON.stringify(lean);
  return leanJson.length <= CELL_LIMIT ? leanJson : leanJson.slice(0, CELL_LIMIT);
}

export { SHEET_COLUMNS };
