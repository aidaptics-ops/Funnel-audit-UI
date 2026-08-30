import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSessionToken,
  isAuthConfigured,
  sessionCookieOptions,
  verifyCredentials,
} from "@/lib/auth/session";

/**
 * Sign in.
 *
 * One deliberate choice: a wrong email and a wrong password produce the same
 * message and the same status. Telling someone which half they got right
 * turns a password guess into an account enumeration.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "not_configured",
          message: "Authentication is not configured on this deployment.",
        },
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!verifyCredentials(email, password)) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "That email and password do not match." } },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ ok: true, data: { email: email.trim().toLowerCase() } });
  response.cookies.set(SESSION_COOKIE, createSessionToken(email), sessionCookieOptions());
  return response;
}
