import "server-only";
import { config } from "../config";
import type { NormalizedAudit } from "../audit/normalize";
import { compactAudit } from "./compact";
import type { IdentityResult } from "../identity/types";
import { approvedAddress, serializeContacts, type ContactCandidate } from "../contacts";
import { runKey } from "./key";
import type { GeneratedEmail } from "../email/validate";
import { GoogleSheetsService } from "./google";
import { SHEET_COLUMNS, emptyRecord, queuedRecord, type FunnelRecord, type SheetColumn } from "./types";

/**
 * The Google Sheets seam.
 *
 * Two implementations sit behind it: the real one in ./google.ts, and a no-op
 * used until a service account and spreadsheet id are configured. The no-op is
 * deliberate — an operator must be able to run the whole workflow and approve
 * emails before any spreadsheet exists.
 */
export interface UpsertOptions {
  /**
   * Columns to write even when the incoming value is empty.
   *
   * A merge normally treats a blank cell as "leave what is there", which is
   * what stops a re-analysis wiping an approved address. Clearing a field
   * therefore has to be asked for explicitly, or it silently does nothing.
   */
  overwrite?: SheetColumn[];
}

export interface SheetsService {
  readonly configured: boolean;
  /** Insert or update by funnel_url. Returns the row written. */
  upsert(record: FunnelRecord, options?: UpsertOptions): Promise<FunnelRecord>;
  /**
   * Appends every record whose funnel_url is not already present, in ONE
   * write. Returns how many were added.
   *
   * Exists because queueing is now a durable act: a batch of fifty URLs has to
   * reach the sheet before the operator can close the tab, and fifty
   * sequential upserts would take a minute of round trips while they waited.
   * Existing rows are skipped rather than updated — re-queuing a funnel that
   * already ran must not blank the audit it produced.
   */
  appendMany(records: FunnelRecord[]): Promise<number>;
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

  async appendMany(): Promise<number> {
    return 0;
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
  /** Every address discovered, with source and verification. */
  contacts?: ContactCandidate[];
  /** The canonical UI state, so history reads the same as the live queue. */
  stage?: string;
  errorMessage?: string | null;
  warningCount?: number;
  /** Blank leaves whatever the queued row already recorded. */
  performedAction?: boolean;
}): FunnelRecord {
  const record = emptyRecord();
  const now = new Date().toISOString();
  const topIssues = (input.audit?.issues ?? []).slice(0, 3);

  // Normalised, always. The same funnel arrives with and without ad
  // parameters depending on where the URL was copied from, and keying on the
  // raw string filed one funnel as two unrelated runs.
  record.funnel_url = runKey(input.url);
  record.domain = input.audit?.domain ?? "";
  // The extracted business name wins over whatever the audit guessed — that
  // extraction is the step that knows "The Art of Wooing" from a domain.
  record.company_name = input.identity?.company.brand ?? input.audit?.brand ?? "";
  record.owner_name = input.identity?.owner?.fullName ?? "";

  // Every candidate is kept, whether or not one has been approved. Discarding
  // the unapproved ones would leave the operator nothing to choose from when
  // they come back to the run later.
  const contacts = input.contacts ?? [];
  record.contacts_json = serializeContacts(contacts);

  // The approved address is whichever the operator accepted — either passed
  // explicitly, or flagged in the candidate list they approved earlier.
  // Nothing is written here until someone actually accepts one.
  const approved = input.approvedEmail ?? approvedAddress(contacts);
  record.owner_email = approved ?? "";
  record.owner_email_approved = approved ? "true" : "false";

  const known = [input.identity?.ownerEmail, input.identity?.fallbackEmail];
  const accepted = approved ? known.find((entry) => entry?.address === approved) : undefined;
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

  record.performed_action = input.performedAction === undefined ? "" : input.performedAction ? "true" : "false";

  record.created_at = input.createdAt ?? now;
  record.updated_at = now;
  record.audit_json = input.audit ? compactAudit(input.audit) : "";

  return record;
}

/**
 * Columns a completed run must be allowed to CLEAR.
 *
 * The merging upsert treats a blank incoming cell as "leave what is there",
 * which is what stops a re-analysis erasing an approved address. The top-issue
 * titles need the opposite: a re-run that finds two findings where it once
 * found three must not leave the third one's title sitting in the row,
 * attributed to an analysis that never produced it.
 *
 * error_message is here for the same reason: a run that has since succeeded
 * must stop displaying the reason it once failed.
 */
export const RUN_OVERWRITE: SheetColumn[] = [
  "top_issue_1",
  "top_issue_2",
  "top_issue_3",
  "error_message",
];

export { SHEET_COLUMNS, queuedRecord, compactAudit };
