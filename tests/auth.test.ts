import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

/**
 * The session is the only thing standing between the public internet and the
 * funnel data, so these tests are all about what must NOT be accepted.
 *
 * The module reads its configuration from the environment at call time, so
 * each test sets it explicitly rather than depending on a .env file.
 */
const ENV = { ...process.env };

beforeEach(() => {
  process.env.AUTH_EMAIL = "volodymyr@rysu-media.com";
  process.env.AUTH_PASSWORD = "correct horse battery staple";
  process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  process.env = { ...ENV };
});

const load = async () => import("../src/lib/auth/session");

describe("credentials", () => {
  it("accepts the configured pair", async () => {
    const { verifyCredentials } = await load();
    assert.equal(verifyCredentials("volodymyr@rysu-media.com", "correct horse battery staple"), true);
  });

  it("ignores case and surrounding space in the email", async () => {
    const { verifyCredentials } = await load();
    assert.equal(verifyCredentials("  Volodymyr@Rysu-Media.com ", "correct horse battery staple"), true);
  });

  it("rejects a wrong password and a wrong email alike", async () => {
    const { verifyCredentials } = await load();
    assert.equal(verifyCredentials("volodymyr@rysu-media.com", "nearly right"), false);
    assert.equal(verifyCredentials("someone@else.com", "correct horse battery staple"), false);
  });

  it("rejects everything when no password is configured", async () => {
    delete process.env.AUTH_PASSWORD;
    const { verifyCredentials, isAuthConfigured } = await load();
    assert.equal(isAuthConfigured(), false);
    assert.equal(verifyCredentials("volodymyr@rysu-media.com", ""), false);
  });
});

describe("session tokens", () => {
  it("round-trips a token it just signed", async () => {
    const { createSessionToken, readSessionToken } = await load();
    const token = createSessionToken("volodymyr@rysu-media.com");
    assert.equal(readSessionToken(token)?.sub, "volodymyr@rysu-media.com");
  });

  it("refuses a token whose signature was altered", async () => {
    const { createSessionToken, readSessionToken } = await load();
    const token = createSessionToken("volodymyr@rysu-media.com");
    const [body] = token.split(".");
    assert.equal(readSessionToken(`${body}.notarealsignature`), null);
  });

  it("refuses a payload edited after signing", async () => {
    const { createSessionToken, readSessionToken } = await load();
    const [, signature] = createSessionToken("volodymyr@rysu-media.com").split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "attacker@evil.com", exp: 9_999_999_999 }))
      .toString("base64url");
    assert.equal(readSessionToken(`${forged}.${signature}`), null);
  });

  it("refuses a token signed with a different secret", async () => {
    const { createSessionToken, readSessionToken } = await load();
    const token = createSessionToken("volodymyr@rysu-media.com");

    // The signing key is read from the environment on every call, so rotating
    // the secret here is enough — a session issued under the old one must stop
    // working immediately rather than surviving until it expires.
    process.env.AUTH_SECRET = "ffffffffffffffffffffffffffffffff";
    assert.equal(readSessionToken(token), null);
  });

  it("refuses an expired token", async () => {
    const { createSessionToken, readSessionToken } = await load();
    const token = createSessionToken("volodymyr@rysu-media.com", 60);
    // Same token, read two minutes later.
    assert.equal(readSessionToken(token, Date.now() + 120_000), null);
  });

  it("refuses a token for anyone but the configured operator", async () => {
    const { createSessionToken, readSessionToken } = await load();
    // Signed correctly, but naming a different person — a leftover session
    // after the configured email changes must not still open the door.
    const token = createSessionToken("someone@else.com");
    assert.equal(readSessionToken(token), null);
  });

  it("refuses empty and malformed input", async () => {
    const { readSessionToken } = await load();
    for (const value of ["", "   ", "no-dot", "a.b.c.d", undefined, null]) {
      assert.equal(readSessionToken(value as string | undefined), null, `accepted: ${String(value)}`);
    }
  });
});
