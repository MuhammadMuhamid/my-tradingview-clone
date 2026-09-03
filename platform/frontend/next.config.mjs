/** @type {import('next').NextConfig} */
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:4000";

/**
 * Content-Security-Policy.
 *
 * `'unsafe-inline'` on script-src and style-src is required and is not an
 * oversight: Next injects an inline bootstrap script and inline styles on every
 * page, and the nonce-based alternative documented by Next requires dynamic
 * rendering on every route, which would remove the static prerendering these
 * pages currently get. The honest position is that this CSP hardens framing,
 * base-uri, form-action, object embedding and outbound connections, and does
 * NOT defend against injected inline script. The frontend has no
 * `dangerouslySetInnerHTML`, no `innerHTML`, no `eval` and no `new Function`;
 * keeping it that way is the actual XSS control, and it is asserted in
 * `tests/noUnsafeSinks.test.ts`.
 *
 * `connect-src` names the two Binance origins the chart and the watchlist open
 * websockets to directly, plus `'self'` for the proxied API.
 *
 * ── Why the data-api.binance.vision mirror is NOT listed ───────────────────
 *
 * Phase 01 raised this: the backend can be pointed at
 * `https://data-api.binance.vision` (BINANCE_MARKET_DATA_BASE_URL) where
 * `api.binance.com` is geo-blocked, and the mirror is absent from this policy.
 * It is absent because the browser never calls a Binance REST origin at all —
 * every candle, symbol and history read goes through `'self'` to the Next proxy
 * and on to the backend, so the mirror is a BACKEND setting and needs no
 * browser permission. Adding it would grant a capability nothing uses.
 *
 * What the browser does open directly is the kline and bookTicker websockets,
 * and that host is hard-coded in `lib/marketFeed.ts`, `lib/useBookQuote.ts` and
 * `components/tv/Watchlist.tsx` — there is no mirror for it and no setting for
 * it. In a region where `stream.binance.com` is blocked, the charts fall back
 * to their polled REST history and every pane shows `reconnecting…`; the data
 * on screen stays correct and is simply not streaming. Making that origin
 * configurable is a deployment concern, not a V1 UI one.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' wss://stream.binance.com:9443 https://api.binance.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  {
    key: "Permissions-Policy",
    value: "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
  },
];

const nextConfig = {
  reactStrictMode: true,
  // The framework version is not something an attacker needs to be told.
  poweredByHeader: false,
  // Produce a minimal self-contained Node server for the production container.
  output: "standalone",
  // Proxy API calls to the backend so the browser talks to one origin (no CORS).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND}/api/:path*` }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        // The service worker must not be cached across deploys, or a stale one
        // keeps serving and Web Push breaks silently.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
