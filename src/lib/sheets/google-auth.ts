import "server-only";
import { createSign } from "node:crypto";
import { config } from "../config";

/**
 * Service-account authentication for the Sheets API, with no SDK.
 *
 * The whole OAuth2 service-account flow is: sign a JWT with the account's
 * private key, exchange it for an access token, reuse that token for an hour.
 * That is about forty lines, versus pulling in googleapis (and its transitive
 * tree) for the same result. Fewer dependencies is also fewer places a
 * credential can end up.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** Refresh a minute early so a token never expires mid-request. */
const SKEW_MS = 60_000;

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

export class SheetsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetsAuthError";
  }
}

/**
 * Reads GOOGLE_SERVICE_ACCOUNT, accepting either the raw JSON key file or that
 * file base64-encoded.
 *
 * Base64 is the recommended form: the JSON contains a PEM private key full of
 * newlines, and every .env format mangles those differently. Base64 has no
 * newlines and no quotes, so it survives .env files, Docker, and Dokploy's
 * environment editor unchanged.
 */
export function parseServiceAccount(): ServiceAccount | null {
  const raw = config.sheets.serviceAccount;
  if (!raw) return null;

  let json = raw.trim();
  if (!json.startsWith("{")) {
    try {
      json = Buffer.from(json, "base64").toString("utf8").trim();
    } catch {
      throw new SheetsAuthError("GOOGLE_SERVICE_ACCOUNT is neither JSON nor valid base64.");
    }
  }

  let parsed: { client_email?: string; private_key?: string; type?: string };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new SheetsAuthError("GOOGLE_SERVICE_ACCOUNT did not contain valid JSON.");
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new SheetsAuthError("The service account JSON is missing client_email or private_key.");
  }

  return {
    clientEmail: parsed.client_email,
    // Survives the case where the key was pasted with literal \n sequences.
    privateKey: parsed.private_key.includes("\\n")
      ? parsed.private_key.replace(/\\n/g, "\n")
      : parsed.private_key,
  };
}

let cached: { token: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - SKEW_MS) return cached.token;

  const account = parseServiceAccount();
  if (!account) throw new SheetsAuthError("GOOGLE_SERVICE_ACCOUNT is not set.");

  const now = Math.floor(Date.now() / 1000);
  const assertion = sign(
    { alg: "RS256", typ: "JWT" },
    {
      iss: account.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    account.privateKey,
  );

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;

  if (!response.ok || !body?.access_token) {
    // Google's own message here is genuinely useful ("Invalid JWT Signature",
    // "Requested entity was not found") and contains no secret, so it is worth
    // passing through to the operator.
    const detail = body?.error_description ?? body?.error ?? `HTTP ${response.status}`;
    throw new SheetsAuthError(`Google rejected the service account: ${detail}`);
  }

  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Clears the cached token. Used when a 401 suggests it went stale early. */
export function resetToken(): void {
  cached = null;
}

function sign(header: object, claims: object, privateKey: string): string {
  const encode = (value: object): string => base64Url(Buffer.from(JSON.stringify(value)));
  const body = `${encode(header)}.${encode(claims)}`;

  const signer = createSign("RSA-SHA256");
  signer.update(body);
  signer.end();

  try {
    return `${body}.${base64Url(signer.sign(privateKey))}`;
  } catch {
    throw new SheetsAuthError("The service account's private_key could not be used to sign. Re-download the key file.");
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
