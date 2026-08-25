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
