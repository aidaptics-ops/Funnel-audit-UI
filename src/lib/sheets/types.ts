import { runKey } from "./key";

/**
 * The operational record. Google Sheets becomes the source of truth later, so
 * this shape is defined by explicit column names — never by cell position.
 * Adding a column must not move an existing one.
 */
export const SHEET_COLUMNS = [
  "funnel_url",
  "domain",
  "company_name",
  "owner_name",
  "owner_email",
  "owner_email_kind",
  "owner_email_approved",

  "stage",
  "audit_status",
  "audit_job_id",
  "audit_completed_at",
  "error_message",

  "funnel_type",
  "conversion_goal",

  "top_issue_1",
  "top_issue_2",
  "top_issue_3",

  "email_status",
  "email_subject",
  "email_body",
  "email_angle",

  "email_approved",
  "email_edited",
  "email_warnings",

  "created_at",
  "updated_at",

  /**
   * The operator personally completed this funnel's conversion action.
   *
   * Persisted because a queued funnel now outlives the browser tab that
   * queued it, and this flag decides whether the email may open the way the
   * client normally does ("Just booked a call with..."). Losing it on a
   * restart would silently turn a true opener into a false one.
   */
  "performed_action",

  /**
   * Every candidate address, with where it came from and what the verifier
   * said. Persisted because approval is a decision the operator makes later,
   * often on another page — keeping the list only in the browser is what made
   * a completed run vanish on navigation.
   */
  "contacts_json",

  /**
   * What this run consumed, per service, in each provider's own units.
   *
   * Units rather than money, so a change of plan or a corrected rate re-prices
   * the whole history instead of leaving rows priced at whatever was believed
   * on the day. Accumulated across re-analyses and later enrichment: money
   * spent on a lead is spent whether or not the row was rewritten afterwards.
   */
  "cost_json",

  /**
   * A trimmed copy of the audit, so a run stays viewable long after the
   * browser session that produced it. Kept last: these are the wide columns,
   * and putting them on the end keeps the sheet readable by a human.
   */
  "audit_json",
] as const;

export type SheetColumn = (typeof SHEET_COLUMNS)[number];

export type FunnelRecord = Record<SheetColumn, string>;

export type AuditStatus = "queued" | "analyzing" | "complete" | "failed";
export type EmailStatus = "pending" | "generating" | "ready" | "approved" | "failed";

export function emptyRecord(): FunnelRecord {
  return SHEET_COLUMNS.reduce((record, column) => {
    record[column] = "";
    return record;
  }, {} as FunnelRecord);
}

/**
 * A funnel that has been queued and nothing more.
 *
 * Written the moment it is added, so the work survives the tab that created
 * it. Everything else is blank on purpose — the merging upsert treats a blank
 * cell as "leave what is there", so the real analysis fills this row in later
 * rather than fighting it.
 */
export function queuedRecord(url: string, performedAction = false): FunnelRecord {
  const record = emptyRecord();
  const now = new Date().toISOString();
  record.funnel_url = runKey(url);
  record.domain = domainOf(url);
  record.stage = "queued";
  record.audit_status = "queued";
  record.email_status = "pending";
  record.performed_action = performedAction ? "true" : "false";
  record.created_at = now;
  record.updated_at = now;
  return record;
}

function domainOf(url: string): string {
  try {
    return new URL(runKey(url)).hostname;
  } catch {
    return "";
  }
}
