import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A stateless, signed session.
 *
 * No database and no server-side session store, because there is neither one
 * available and — more importantly — the app runs on serverless instances that
 * share no memory. A signed token in a cookie is verifiable by any instance
 * without coordination, which is the only property that actually matters here.
 *
 * Deliberately dependency-free: Next 16 runs Proxy on the Node.js runtime, so
 * node:crypto is available in the one place that has to verify on every
 * request. Adding a JWT library would buy nothing but supply chain.
 */

const COOKIE_NAME = "funnel_session";
const DEFAULT_TTL_SECONDS = 60 * 60 * 12;

export const SESSION_COOKIE = COOKIE_NAME;

export interface SessionPayload {
  /** The signed-in address. */
  sub: string;
  /** Unix seconds. */
  exp: number;
}

/** The configured operator, or null when authentication is not set up. */
export function configuredEmail(): string | null {
  return (process.env.AUTH_EMAIL ?? "").trim().toLowerCase() || null;
}

function configuredPassword(): string | null {
  return process.env.AUTH_PASSWORD ?? null;
}

/**
 * Authentication is only enforced once BOTH an email and a password exist.
 *
 * A half-configured deployment must not lock its owner out, and must not
 * silently serve everything to the public either — so the login page states
 * which of the two is missing rather than failing opaquely.
 */
export function isAuthConfigured(): boolean {
  return Boolean(configuredEmail() && configuredPassword());
}

/**
 * The signing key.
 *
 * AUTH_SECRET is preferred. Falling back to a key derived from the password
 * keeps a one-variable deployment working, and is still stable across
 * instances — which a random per-instance key would not be, so every request
 * would land on an instance that rejected the cookie.
 */
function signingKey(): Buffer {
  const explicit = process.env.AUTH_SECRET;
  if (explicit && explicit.length >= 16) return Buffer.from(explicit, "utf8");
  const password = configuredPassword() ?? "";
  return createHmac("sha256", "funnel-console-derived-key").update(password).digest();
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="), "base64");
}

function sign(body: string): string {
  return base64url(createHmac("sha256", signingKey()).update(body).digest());
}

export function createSessionToken(email: string, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()): string {
  const payload: SessionPayload = {
    sub: email.toLowerCase(),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/**
 * Verifies a token and returns its payload, or null.
 *
 * Every failure returns null rather than throwing or distinguishing between
 * "malformed", "wrong signature" and "expired" — the caller has no legitimate
 * use for that difference, and an attacker does.
 */
export function readSessionToken(token: string | undefined | null, now = Date.now()): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = sign(body);
  // Length-check first: timingSafeEqual throws on a length mismatch, and the
  // length of a signature is not a secret.
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload?.sub !== "string" || typeof payload?.exp !== "number") return null;
  if (payload.exp * 1000 <= now) return null;
  if (payload.sub !== configuredEmail()) return null;

  return payload;
}

/**
 * Checks submitted credentials in constant time.
 *
 * Both comparisons run even when the email is already wrong: returning early
 * would make a wrong address measurably faster to reject than a wrong
 * password, which tells an attacker when they have found the right address.
 */
export function verifyCredentials(email: string, password: string): boolean {
  const expectedEmail = configuredEmail();
  const expectedPassword = configuredPassword();
  if (!expectedEmail || !expectedPassword) return false;

  const emailOk = constantTimeEquals(email.trim().toLowerCase(), expectedEmail);
  const passwordOk = constantTimeEquals(password, expectedPassword);
  return emailOk && passwordOk;
}

function constantTimeEquals(left: string, right: string): boolean {
  // Hashing first makes the comparison fixed-width, so differing lengths do
  // not short-circuit and leak the expected length.
  const a = createHmac("sha256", "compare").update(left).digest();
  const b = createHmac("sha256", "compare").update(right).digest();
  return timingSafeEqual(a, b);
}

export function sessionCookieOptions(maxAgeSeconds = DEFAULT_TTL_SECONDS) {
  return {
    httpOnly: true,
    // Vercel serves over HTTPS; locally over HTTP, where Secure would stop the
    // cookie ever being stored and make login appear to silently fail.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Used by the setup docs to suggest a value for AUTH_SECRET. */
export function suggestSecret(): string {
  return randomBytes(32).toString("hex");
}
