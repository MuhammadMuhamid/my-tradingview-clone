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

/** Official public X1/X2 market-data websocket origins. No account channels. */
export const PROVIDER_STREAM_ORIGINS = [
  "wss://ws-feed.exchange.coinbase.com",
  "wss://stream.bybit.com",
  "wss://ws.okx.com:8443",
  "wss://ws.kraken.com",
  "wss://ws-api-spot.kucoin.com",
  "wss://api.gateio.ws",
  "wss://api.hyperliquid.xyz",
  "wss://fstream.binance.com",
  "wss://dstream.binance.com",
  "wss://ws-api-futures.kucoin.com",
  "wss://fx-ws.gateio.ws",
  "wss://futures.kraken.com",
];

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${[...MARKET_STREAM_ORIGINS, ...PROVIDER_STREAM_ORIGINS].join(" ")}`,
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
  /*
   * The production image is built ON the app instance — a t3.micro, where Node
   * sizes its heap at a quarter of physical RAM: about 230 MB. The compile fits
   * in that. The type-check does not: on 2026-10-13 the release's first deploy
   * died with "Reached heap limit … Failed to type check" after "Compiled
   * successfully", reproduced exactly by capping a local build at 230 MB.
   *
   * So the Docker build — and only the Docker build, via SKIP_BUILD_TYPECHECK
   * in its build stage — skips Next's type-check. That is not a loss of the
   * check: CI runs `npm run typecheck` on every push, deploys are built from
   * a commit's archive, and a local `next build` still type-checks as before.
   * Raising the heap instead was rejected: on this box that trades a clean V8
   * heap error for kernel memory pressure, which is what once took the SSM
   * agent down with a build.
   */
  typescript: {
    ignoreBuildErrors: process.env.SKIP_BUILD_TYPECHECK === "1",
  },
  /*
   * W2D-01: how long the `/api` rewrite waits for the backend.
   *
   * Next's proxy (`server/lib/router-utils/proxy-request.js`) defaults to 30 s
   * and, when it expires, destroys the upstream request and answers 500 —
   * logging `Failed to proxy … Error: socket hang up ECONNRESET`. That is
   * exactly the signature seen on `POST /api/pine/run`: the backend's own
   * budget for an editor/chart run is 45 s plus its data load
   * (`PINE_EDITOR_TIME_BUDGET_MS`, `backend/src/api/routes/pine.ts`), and a run
   * queued behind others in its two-worker pool waits longer still, so the
   * proxy was cutting off runs the backend was still entitled to finish. The
   * ceiling now sits above the backend's own, which remains the real bound:
   * a run that overruns is stopped THERE and answered with a reason. (Not the
   * backend's keep-alive: Fastify already sets 72 s, and a client abort is
   * reported as `econnreset` without this log line.)
   */
  experimental: {
    proxyTimeout: 120_000,
  },
  // Proxy API calls to the backend so the browser talks to one origin (no CORS).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND}/api/:path*` }];
  },
  /**
   * FC2-L2: the three destinations whose slug did not match their name.
   *
   * `Screener` resolved to `/scanner`, `Trading` to `/deployments` and
   * `Research` to `/backtests`. Nothing was broken — every one returned 200 —
   * but the mismatch surfaced everywhere a URL is seen rather than clicked:
   * the address bar, a bookmark, a link pasted to someone else. The pages moved
   * to the slugs their labels promise; these keep every link that already
   * exists working, including a bookmarked backtest detail page.
   *
   * `permanent: true` (308) because the move is permanent and the method must
   * be preserved. The API paths are untouched — `/api/scanner`,
   * `/api/deployments` and `/api/backtests` are the backend's contract, not
   * this application's navigation, and renaming a page is no reason to rename
   * a wire format.
   */
  async redirects() {
    return [
      { source: "/scanner", destination: "/screener", permanent: true },
      { source: "/scanner/:path*", destination: "/screener/:path*", permanent: true },
      { source: "/deployments", destination: "/trading", permanent: true },
      { source: "/deployments/:path*", destination: "/trading/:path*", permanent: true },
      { source: "/backtests", destination: "/research", permanent: true },
      { source: "/backtests/:path*", destination: "/research/:path*", permanent: true },
    ];
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
