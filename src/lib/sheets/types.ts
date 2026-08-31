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
   * Every candidate address, with where it came from and what the verifier
   * said. Persisted because approval is a decision the operator makes later,
   * often on another page — keeping the list only in the browser is what made
   * a completed run vanish on navigation.
   */
  "contacts_json",

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
