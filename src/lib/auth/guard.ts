import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, isAuthConfigured, readSessionToken } from "./session";

/**
 * The second layer.
 *
 * Proxy already turns unauthenticated browsers away, but the Next docs are
 * explicit that it is an optimistic check rather than an authorization
 * boundary. Every route that returns funnel data, client information or an
 * analysis result calls this too, so the data is protected by the route
 * itself and not only by what sits in front of it.
 */
export async function requireSession(): Promise<NextResponse | null> {
  if (!isAuthConfigured()) return null;

  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (session) return null;

  return NextResponse.json(
    { ok: false, error: { code: "unauthorized", message: "Sign in to continue." } },
    { status: 401 },
  );
}
