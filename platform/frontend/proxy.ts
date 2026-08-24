/**
 * Page-level sign-in gate. The backend independently enforces the session on
 * /api/*; this only spares the user a flash of an empty app before the first
 * API call returns 401.
 *
 * The cookie signature is NOT verified here — that is the backend's job with
 * the signing secret, which must not reach the edge runtime. Presence-only is
 * therefore intentional: a forged cookie buys a redirect and nothing more, and
 * every protected byte still comes from the authenticated API.
 *
 * Renamed from `middleware.ts`: the `middleware` convention is deprecated in
 * Next 16 in favour of `proxy`. Same behaviour, same matcher.
 */
import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/authFlag";

const SESSION_COOKIE = "srtrend_session";

export function proxy(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
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
