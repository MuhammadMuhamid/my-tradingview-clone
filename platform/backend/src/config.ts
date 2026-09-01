import "dotenv/config";

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: string;
  alertEncryptionKey: string;
  allowedWebhookHosts: string[];
  liveTestEnabled: boolean;
  /** Cookie-session auth. Opt-out only, and it fails closed when misconfigured. */
  authEnabled: boolean;
  adminUsername: string;
  adminPasswordHash: string;
  sessionSecret: string;
  /** Emit `Secure` on the session cookie — must be off for plain-HTTP dev. */
  cookieSecure: boolean;
  /** Trust `X-Forwarded-For` when a reverse proxy terminates TLS. */
  trustProxy: boolean;
  /**
   * The live runner sends real buy/sell instructions to the execution bot.
   * OPT-IN: it starts only when this is explicitly `true`.
   */
  liveRunnerEnabled: boolean;
  /** Stable identity for the single-emitter lease. */
  emitterId: string;
  /** True when this process is running as a production deployment. */
  isProduction: boolean;
  /** Manual orders proxy only to the execution bot; credentials never live here. */
  manualTradingEnabled: boolean;
  manualTradingBotUrl: string;
  manualTradingHmacSecret: string;
  /** Canonical Scanner service. Browser code never receives this address. */
  scannerServiceUrl: string;
}

/**
 * The single parse rule for AUTH_ENABLED.
 *
 * The frontend middleware previously read `=== "true"` (opt-in) while the
 * backend read `!== "false"` (opt-out), so `AUTH_ENABLED=1` produced a gated
 * API behind an ungated UI. Both now call this, and it is deliberately strict:
 * only the exact string `false` disables the gate.
 */
export function parseAuthEnabled(raw: string | null | undefined): boolean {
  return (raw ?? "true").trim().toLowerCase() !== "false";
}

/**
 * Values published in this repository's own examples and documentation. A
 * deployment that boots on one of these has no secret at all, so they are
 * refused outright rather than warned about.
 */
const PUBLISHED_PLACEHOLDERS = [
  "replace-with-openssl-rand-hex-32",
  "replace-with-openssl-rand-hex-64",
  "replace_me",
  "replaceme",
  "change-me",
  "changeme",
  "change-me-to-a-random-32-char-string",
  "your-secret-here",
  "paste_your_bot_secret_here",
  "insecure",
  "dev-insecure-key",
  "test-only",
];

export function isPublishedPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return PUBLISHED_PLACEHOLDERS.some((p) => v === p || v.startsWith(p));
}

export const config: AppConfig = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://platform:platform@localhost:5433/platform",
  logLevel: process.env.LOG_LEVEL ?? "info",
  alertEncryptionKey: process.env.ALERT_ENCRYPTION_KEY ?? "",
  allowedWebhookHosts: (process.env.ALLOWED_WEBHOOK_HOSTS ?? "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
  liveTestEnabled: process.env.LIVE_TEST_ENABLED === "true",
  authEnabled: parseAuthEnabled(process.env.AUTH_ENABLED),
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  cookieSecure: process.env.COOKIE_SECURE !== "false",
  trustProxy: process.env.TRUST_PROXY === "true",
  /*
   * X-06: this was `!== "false"`, i.e. opt-OUT — and the launch agent shipped in
   * `platform/backend/launchd/` sets no environment at all, with RunAtLoad and
   * KeepAlive. Loading it, or following the repository on a fresh machine,
   * started a SECOND live emitter against the same production bot, with its
   * runtime state in a different database from the first. Opt-in now.
   */
  liveRunnerEnabled: process.env.LIVE_RUNNER_ENABLED === "true",
  emitterId: process.env.EMITTER_ID ?? `${process.env.HOSTNAME ?? "unknown"}:${process.pid}`,
  isProduction: (process.env.NODE_ENV ?? "").toLowerCase() === "production",
  manualTradingEnabled: process.env.MANUAL_TRADING_ENABLED === "true",
  manualTradingBotUrl: (process.env.MANUAL_TRADING_BOT_URL ?? "http://localhost:4001").replace(/\/$/, ""),
  manualTradingHmacSecret: process.env.MANUAL_TRADING_HMAC_SECRET ?? "",
  scannerServiceUrl: (process.env.SCANNER_SERVICE_URL ?? (
    (process.env.NODE_ENV ?? "").toLowerCase() === "production" ? "" : "http://127.0.0.1:8000"
  )).replace(/\/$/, ""),
};

// ── Fail closed ───────────────────────────────────────────────────────────────
// An app that only *looks* protected is worse than one that refuses to start:
// this process exposes a real-order test endpoint and the live signal emitter.

if (config.authEnabled && !config.adminPasswordHash) {
  throw new Error(
    "ADMIN_PASSWORD_HASH is required when auth is enabled. " +
    "Generate one with `npm run hash-password -- '<password>'`, or set " +
    "AUTH_ENABLED=false to run this instance deliberately unauthenticated."
  );
}

// A session signed with a guessable secret is no session at all.
if (config.authEnabled && config.sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters when auth is enabled");
}

if (config.authEnabled && isPublishedPlaceholder(config.sessionSecret)) {
  throw new Error("SESSION_SECRET is a published placeholder value — generate a real one");
}

if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
  throw new Error(`Invalid PORT: ${JSON.stringify(process.env.PORT)}`);
}

if (config.alertEncryptionKey.length < 32) {
  throw new Error("ALERT_ENCRYPTION_KEY must be at least 32 characters");
}

if (config.isProduction && isPublishedPlaceholder(config.alertEncryptionKey)) {
  throw new Error("ALERT_ENCRYPTION_KEY is a published placeholder value — generate a real one");
}

if (config.manualTradingEnabled && config.manualTradingHmacSecret.length < 32) {
  throw new Error("MANUAL_TRADING_HMAC_SECRET must be at least 32 characters when manual trading is enabled");
}
if (config.manualTradingEnabled && isPublishedPlaceholder(config.manualTradingHmacSecret)) {
  throw new Error("MANUAL_TRADING_HMAC_SECRET is a published placeholder value — generate a real one");
}
if (config.manualTradingEnabled) {
  const manualBotUrl = new URL(config.manualTradingBotUrl);
  if (!/^https?:$/.test(manualBotUrl.protocol) || manualBotUrl.username || manualBotUrl.password) {
    throw new Error("MANUAL_TRADING_BOT_URL must be an http(s) URL without embedded credentials");
  }
}
if (config.scannerServiceUrl) {
  const scannerUrl = new URL(config.scannerServiceUrl);
  if (!/^https?:$/.test(scannerUrl.protocol) || scannerUrl.username || scannerUrl.password ||
      scannerUrl.search || scannerUrl.hash || scannerUrl.pathname !== "/") {
    throw new Error(
      "SCANNER_SERVICE_URL must be an http(s) origin without credentials, path, query, or fragment"
    );
  }
}

// An empty allowlist would make `validateWebhookUrl` reject everything, which
// is safe but silently breaks delivery. Say so at boot instead.
if (config.allowedWebhookHosts.length === 0) {
  throw new Error(
    "ALLOWED_WEBHOOK_HOSTS must list at least one host. Webhook delivery is " +
    "restricted to exactly these hostnames over HTTPS on port 443."
  );
}
