import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isAuthConfigured, readSessionToken } from "@/lib/auth/session";

/**
 * The front door.
 *
 * In Next 16 this file is `proxy.ts` — the `middleware.ts` convention was
 * deprecated and renamed in v16, and Proxy now runs on the Node.js runtime,
 * which is what lets the session verifier use node:crypto here.
 *
 * The Next docs are explicit that Proxy is an OPTIMISTIC check and not a
 * complete authorization solution, so this is one of two layers: it keeps
 * unauthenticated browsers away from the pages, and every API route
 * independently calls requireSession(). A gate that only exists here would be
 * bypassed the moment a route was reached another way.
 */

/** Paths that must stay reachable while signed out, or nobody can sign in. */
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // With no credentials configured the app is open. This is deliberate: a
  // half-configured deployment locking its owner out is worse than one that
  // says plainly on the login page that authentication is not set up.
  if (!isAuthConfigured()) return NextResponse.next();

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const session = readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  // An API call gets a status it can act on; a browser gets the login page.
  // Redirecting a fetch() would hand it an HTML page where JSON was expected.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Sign in to continue." } },
      { status: 401 },
    );
  }

  const login = new URL("/login", request.url);
  // Preserve where they were going, so signing in does not dump them on the
  // dashboard when they clicked a link to a specific run.
  if (pathname !== "/") login.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  /*
   * Everything except Next's own assets and the favicon. Without a negative
   * match the gate would also block CSS and JS, so the login page itself would
   * render unstyled and its script would never load.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
