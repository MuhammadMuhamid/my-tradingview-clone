/**
 * Page-level sign-in gate. The backend independently enforces the session on
 * /api/*; this only spares the user a flash of an empty app before the first
 * API call returns 401.
 *
 * The cookie signature is NOT verified here — that is the backend's job with
 * the signing secret. Middleware only checks for presence, so a forged cookie
 * buys a redirect and nothing more.
 */
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "srtrend_session";

/**
 * Opt-in, mirroring the backend: local development runs without credentials
 * configured, and gating the pages there would redirect to a login the
 * backend would not accept.
 */
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";

export function middleware(req: NextRequest) {
  if (!AUTH_ENABLED) return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    /*
     * Everything except: the login page, the API (guarded server-side and
     * needed by the login form itself), Next's own assets, and the PWA files —
     * the service worker and manifest must load for push to work at all.
     */
    "/((?!login|api|_next/static|_next/image|favicon.ico|icon.svg|sw.js|manifest.webmanifest).*)",
  ],
};
