/**
 * One error vocabulary for the whole app. Every failure the UI can encounter
 * has a code here, a safe message, and an HTTP status — so a route handler
 * never has to decide what is safe to show a user.
 */
export type AppErrorCode =
  // request problems
  | "invalid_url"
  | "unsupported_scheme"
  | "private_host"
  | "credentials_not_allowed"
  | "url_too_long"
  | "invalid_body"
  // audit API problems
  | "audit_timeout"
  | "audit_busy"
  | "audit_unavailable"
  | "audit_navigation_failed"
  | "audit_bad_response"
  | "audit_error"
  // AI problems
  | "llm_unavailable"
  | "llm_failed"
  | "llm_bad_response"
  // enrichment problems
  | "enrichment_unavailable"
  | "enrichment_exhausted"
  | "enrichment_failed"
  | "enrichment_pending"
  // storage / integrations
  | "storage_failed"
  | "sheets_failed"
  | "not_found"
  | "internal_error"
  // the uniform post-booking evidence gate
  | "post_booking_evidence_required";

/**
 * The one sentence an operator reads when no email was written.
 *
 * It lives here rather than beside the gate because two different things now
 * say it — the pipeline, which withholds the email during a run, and
 * /api/generate-email, which refuses to write one after the fact — and a
 * second copy of a user-facing sentence is a sentence that drifts.
 */
export const POST_BOOKING_EVIDENCE_MESSAGE =
  "The page after the conversion step was never seen, so no email was written. " +
  "Upload a screenshot of the confirmation page and this run will unblock.";

const STATUS: Record<AppErrorCode, number> = {
  invalid_url: 400,
  unsupported_scheme: 400,
  private_host: 400,
  credentials_not_allowed: 400,
  url_too_long: 400,
  invalid_body: 400,
  audit_timeout: 504,
  audit_busy: 429,
  audit_unavailable: 502,
  audit_navigation_failed: 502,
  audit_bad_response: 502,
  audit_error: 502,
  llm_unavailable: 503,
  llm_failed: 502,
  llm_bad_response: 502,
  enrichment_unavailable: 503,
  enrichment_exhausted: 429,
  enrichment_failed: 502,
  enrichment_pending: 202,
  storage_failed: 500,
  sheets_failed: 502,
  not_found: 404,
  internal_error: 500,
  // Nothing failed and retrying changes nothing: the request is refused until
  // the operator supplies what is missing.
  post_booking_evidence_required: 409,
};

/** Shown to the user. Never contains a stack, a URL of ours, or a credential. */
const SAFE_MESSAGE: Record<AppErrorCode, string> = {
  invalid_url: "That does not look like a valid URL.",
  unsupported_scheme: "Only http and https URLs can be analysed.",
  private_host: "That address is private or internal and cannot be analysed.",
  credentials_not_allowed: "Remove the username and password from the URL.",
  url_too_long: "That URL is too long.",
  invalid_body: "The request body was not valid JSON.",
  audit_timeout: "The funnel took too long to analyse. Try again, or try a lighter page.",
  audit_busy: "The analyser is busy with another funnel. It will retry shortly.",
  audit_unavailable: "The funnel audit service is unreachable right now.",
  audit_navigation_failed: "That page could not be loaded — it may be down, blocked, or behind a login.",
  audit_bad_response: "The funnel audit service returned something unexpected.",
  audit_error: "The funnel audit service reported an error.",
  llm_unavailable: "No AI provider is configured yet.",
  llm_failed: "The email could not be generated. Try again.",
  llm_bad_response: "The AI returned an email in an unexpected format.",
  enrichment_unavailable: "No contact-enrichment provider is configured.",
  enrichment_exhausted: "The enrichment provider's credits for this month are used up.",
  enrichment_failed: "The contact lookup failed. Nothing was changed.",
  enrichment_pending: "The provider is still working on that lookup. Try again in a moment.",
  storage_failed: "Could not save that. Check the server's storage configuration.",
  sheets_failed: "Could not write to Google Sheets.",
  not_found: "Not found.",
  internal_error: "Something went wrong.",
  post_booking_evidence_required: POST_BOOKING_EVIDENCE_MESSAGE,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  /** Extra context for logs only — never serialised to the client. */
  readonly detail?: string;

  constructor(code: AppErrorCode, detail?: string) {
    super(SAFE_MESSAGE[code]);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }

  toJSON(): { code: AppErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** Anything thrown anywhere becomes a safe AppError here. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AppError("internal_error", detail);
}

export interface ApiFailure {
  ok: false;
  error: { code: AppErrorCode; message: string };
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;
