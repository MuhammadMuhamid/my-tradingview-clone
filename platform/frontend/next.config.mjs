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
 * `connect-src` names the Binance market-stream origins the chart, the
 * watchlist and the order ticket open websockets to directly, plus `'self'`
 * for the proxied API.
 *
 * ── Why NO Binance REST origin is listed ───────────────────────────────────
 *
 * The browser never calls a Binance REST origin at all — every candle,
 * symbol, history and ticker-seed read goes through `'self'` to the Next
 * proxy and on to the backend, which is where `api.binance.com` or its
 * `data-api.binance.vision` mirror (BINANCE_MARKET_DATA_BASE_URL) is chosen.
 * A REST origin here would be a permission nothing uses, and a policy is
 * only as tight as the widest thing it permits.
 *
 * ── Why BOTH stream origins are listed ─────────────────────────────────────
 *
 * What the browser does open directly is the kline, miniTicker and bookTicker
 * websockets, through `lib/marketStream.ts`. `stream.binance.com` answers some
 * networks with HTTP 451 at the handshake; `data-stream.binance.vision` is
 * Binance's market-data-only endpoint for that case. The registry tries the
 * mirror first and falls back to the normal host, so the policy must permit
 * both or the fallback is a connection the browser silently refuses to make.
 * `MARKET_STREAM_ORIGINS` below must equal `lib/marketStream.ts`'s list;
 * `tests/marketTransport.test.ts` fails if they drift.
 */
export const MARKET_STREAM_ORIGINS = [
  "wss://data-stream.binance.vision",
  "wss://stream.binance.com:9443",
];

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${MARKET_STREAM_ORIGINS.join(" ")}`,
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
