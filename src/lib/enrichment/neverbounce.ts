import "server-only";
import { config } from "../config";
import { recordSpend } from "../cost/meter";
import { cacheGet, cacheSet } from "./cache";

/**
 * NeverBounce, the last gate before an address is used.
 *
 * The distinction that earns this module its place is `catchall`. A catch-all
 * domain accepts mail for every address, real or not, so the mailbox can be
 * neither confirmed nor ruled out. That is NOT the same as "invalid", and
 * collapsing the two would throw away most small-business addresses — plenty
 * of real founders sit behind a catch-all. It is also not the same as "valid":
 * presenting it as confirmed would be a lie the operator can't see through.
 * So it gets its own verdict and is passed through as usable-but-unconfirmed.
 */

const API = "https://api.neverbounce.com/v4.2";
const TIMEOUT_MS = 20_000;

/** NeverBounce's own result codes, plus our reading of each. */
export type VerificationResult = "valid" | "invalid" | "disposable" | "catchall" | "unknown";

export interface EmailVerification {
  address: string;
  result: VerificationResult;
  /** Safe to send to. False for invalid and disposable only. */
  usable: boolean;
  /** True only when the mailbox was positively confirmed. */
  confirmed: boolean;
  flags: string[];
  /** NeverBounce's typo suggestion, when it has one. */
  suggestedCorrection: string | null;
  /** Plain-language reading, shown beside the address. */
  summary: string;
  cached: boolean;
}

export class NeverBounceError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "failed" = "failed",
  ) {
    super(message);
    this.name = "NeverBounceError";
  }
}

export function isNeverBounceConfigured(): boolean {
  return Boolean(config.enrichment.neverBounceApiKey);
}

interface SingleCheckResponse {
  status?: string;
  result?: string;
  flags?: string[];
  suggested_correction?: string;
  message?: string;
  credits_info?: {
    free_credits_remaining?: number;
    paid_credits_remaining?: number;
  };
}

/**
 * Verifies one address. Cached permanently — a mailbox does not usually change
 * status, and every check costs a credit.
 */
export async function verifyEmail(address: string, options: { force?: boolean } = {}): Promise<EmailVerification> {
  if (!isNeverBounceConfigured()) {
    throw new NeverBounceError("NEVERBOUNCE_API_KEY is not set.", "not_configured");
  }

  const value = address.trim().toLowerCase();
  const key = `neverbounce:${value}`;
  if (!options.force) {
    const hit = await cacheGet<EmailVerification>(key);
    if (hit) return { ...hit.value, cached: true };
  }

  const url = new URL(`${API}/single/check`);
  // NeverBounce takes the key as a query parameter; there is no header form.
  url.searchParams.set("key", config.enrichment.neverBounceApiKey);
  url.searchParams.set("email", value);
  url.searchParams.set("credits_info", "1");

  let body: SingleCheckResponse | null;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = (await response.json().catch(() => null)) as SingleCheckResponse | null;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new NeverBounceError("NeverBounce timed out.");
    }
    throw new NeverBounceError("Could not reach NeverBounce.");
  }

  // NeverBounce reports failures in the body with HTTP 200, so the status
  // field has to be read rather than relying on the response code.
  if (!body || body.status !== "success") {
    throw new NeverBounceError(scrub(body?.message ?? "NeverBounce returned an error."));
  }

  // Below the cache check, so only a check that actually ran is counted.
  recordSpend("neverbounce", "Address verification", { checks: 1 });

  const verification = read(value, body);
  await cacheSet(key, verification);
  return verification;
}

function read(address: string, body: SingleCheckResponse): EmailVerification {
  const result = normalise(body.result);
  const flags = body.flags ?? [];

  return {
    address,
    result,
    usable: result !== "invalid" && result !== "disposable",
    confirmed: result === "valid",
    flags,
    suggestedCorrection: body.suggested_correction || null,
    summary: describe(result),
    cached: false,
  };
}

function normalise(value: string | undefined): VerificationResult {
  switch ((value ?? "").toLowerCase()) {
    case "valid":
      return "valid";
    case "invalid":
      return "invalid";
    case "disposable":
      return "disposable";
    case "catchall":
      return "catchall";
    default:
      return "unknown";
  }
}

function describe(result: VerificationResult): string {
  switch (result) {
    case "valid":
      return "Mailbox confirmed to exist.";
    case "invalid":
      return "The mailbox does not exist — this address would bounce.";
    case "disposable":
      return "A temporary burner address, not a real contact.";
    case "catchall":
      return "The domain accepts all mail, so this cannot be confirmed or ruled out. Usable, but unproven.";
    case "unknown":
      return "The mail server could not be reached, so this is unproven. Usable, but unconfirmed.";
  }
}

/** Free to call, and the only way to see the remaining balance. */
export async function neverBounceCredits(): Promise<number | null> {
  if (!isNeverBounceConfigured()) return null;
  try {
    const url = new URL(`${API}/account/info`);
    url.searchParams.set("key", config.enrichment.neverBounceApiKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await response.json().catch(() => null)) as {
      status?: string;
      credits_info?: { free_credits_remaining?: number; paid_credits_remaining?: number };
    } | null;
    if (body?.status !== "success") return null;
    const info = body.credits_info ?? {};
    return (info.free_credits_remaining ?? 0) + (info.paid_credits_remaining ?? 0);
  } catch {
    return null;
  }
}

function scrub(message: string): string {
  const key = config.enrichment.neverBounceApiKey;
  return (key ? message.split(key).join("***") : message).slice(0, 200);
}
