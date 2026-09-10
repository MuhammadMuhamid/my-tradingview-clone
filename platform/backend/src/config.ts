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
  /** X3A paper/testnet/demo Spot execution channel. No production mode exists. */
  spotExecutionEnabled: boolean;
  /** X3B paper/testnet/demo derivatives channel. No production mode exists. */
  derivativeExecutionEnabled: boolean;
  /** X4 Alpaca paper equities channel. Production brokerage is unrepresentable. */
  equityPaperExecutionEnabled: boolean;
  /** Paired-release switch for the signed Platform->Bot `shariah` context block. */
  realizationIngestionEnabled: boolean;
  realizationHmacSecret: string;
  /** Canonical Scanner service. Browser code never receives this address. */
  scannerServiceUrl: string;
  /**
   * Origin every PUBLIC Binance Spot market-data request is sent to
   * (`/api/v3/klines`, `/api/v3/exchangeInfo`). No credential is ever attached
   * to it and no account/order endpoint is reachable through it.
   */
  binanceMarketDataBaseUrl: string;
  /** Optional Alpaca paper/data credentials; never used for live brokerage. */
  alpacaPaperApiKey: string;
  alpacaPaperApiSecret: string;
  /** Required alongside credentials because Alpaca Assets does not classify ETFs. */
  alpacaEquityClassificationFile: string;
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
 * The official Binance public Spot market-data hosts.
 *
 * `api.binance.com` and its `api1`–`api4` / `api-gcp` siblings are the normal
 * authority. `data-api.binance.vision` is Binance's public market-data-only
 * mirror: it serves the identical `/api/v3/klines` and `/api/v3/exchangeInfo`
 * surfaces and exposes no account, order, or credentialed endpoint at all, so
 * it is the supported escape hatch on a machine where the main API answers
 * HTTP 451.
 *
 * This is an allowlist rather than a free-form URL because the value is the
 * destination of every outbound market-data request: a mistyped or attacker
 * supplied host would silently become the price source the charts, backtests
 * and live evaluators all treat as truth.
 */
export const BINANCE_MARKET_DATA_HOSTS = [
  "api.binance.com",
  "api1.binance.com",
  "api2.binance.com",
  "api3.binance.com",
  "api4.binance.com",
  "api-gcp.binance.com",
  "data-api.binance.vision",
] as const;

export const DEFAULT_BINANCE_MARKET_DATA_BASE_URL = "https://api.binance.com";

/**
 * Parse BINANCE_MARKET_DATA_BASE_URL. Unset keeps the historical default, so a
 * deployment that never heard of this setting behaves exactly as before.
 */
export function resolveBinanceMarketDataBaseUrl(raw: string | null | undefined): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return DEFAULT_BINANCE_MARKET_DATA_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`BINANCE_MARKET_DATA_BASE_URL is not a URL: ${JSON.stringify(raw)}`);
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.port || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error(
      "BINANCE_MARKET_DATA_BASE_URL must be an https origin on port 443 " +
      "without credentials, path, query, or fragment"
    );
  }
  if (!(BINANCE_MARKET_DATA_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(
      `BINANCE_MARKET_DATA_BASE_URL must be an official Binance public Spot ` +
      `market-data host (${BINANCE_MARKET_DATA_HOSTS.join(", ")}), got ${url.hostname}`
    );
  }
  return url.origin;
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
  spotExecutionEnabled: process.env.SPOT_EXECUTION_ENABLED === "true",
  derivativeExecutionEnabled: process.env.DERIVATIVE_EXECUTION_ENABLED === "true",
  equityPaperExecutionEnabled: process.env.EQUITY_PAPER_EXECUTION_ENABLED === "true",
  /*
   * SHARIAH_BOT_CONTEXT_ENABLED is gone, deliberately.
   *
   * It was a paired-release switch, defaulted OFF because the Bot's manual
   * submit schema was `.strict()` and an un-updated Bot would have rejected
   * every manual order the moment the block started travelling. The Bot this
   * Platform ships against accepts the block (contract v4, `shariah` is an
   * allowed field on both the manual and webhook paths), so the reason is
   * spent — and leaving it would have shipped the worst possible finished
   * state: Shariah Mode ON in the operator's UI, with the evidence that lets
   * the executing side enforce it switched OFF behind an environment variable
   * nobody remembers. Delivery is now simply what the Platform does.
   */
  realizationIngestionEnabled: process.env.REALIZATION_INGESTION_ENABLED === "true",
  realizationHmacSecret: process.env.REALIZATION_HMAC_SECRET ?? "",
  scannerServiceUrl: (process.env.SCANNER_SERVICE_URL ?? (
    (process.env.NODE_ENV ?? "").toLowerCase() === "production" ? "" : "http://127.0.0.1:8000"
  )).replace(/\/$/, ""),
  binanceMarketDataBaseUrl: resolveBinanceMarketDataBaseUrl(process.env.BINANCE_MARKET_DATA_BASE_URL),
  alpacaPaperApiKey: process.env.ALPACA_PAPER_API_KEY ?? "",
  alpacaPaperApiSecret: process.env.ALPACA_PAPER_API_SECRET ?? "",
  alpacaEquityClassificationFile: process.env.ALPACA_EQUITY_CLASSIFICATION_FILE ?? "",
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

const alpacaDataParts = [config.alpacaPaperApiKey, config.alpacaPaperApiSecret, config.alpacaEquityClassificationFile];
if (alpacaDataParts.some(Boolean) && !alpacaDataParts.every(Boolean)) {
  throw new Error(
    "ALPACA_PAPER_API_KEY, ALPACA_PAPER_API_SECRET and ALPACA_EQUITY_CLASSIFICATION_FILE must be set together"
  );
}

if (config.alertEncryptionKey.length < 32) {
  throw new Error("ALERT_ENCRYPTION_KEY must be at least 32 characters");
}

if (config.isProduction && isPublishedPlaceholder(config.alertEncryptionKey)) {
  throw new Error("ALERT_ENCRYPTION_KEY is a published placeholder value — generate a real one");
}

/*
 * MANUAL_TRADING_HMAC_SECRET is the Bot CONTROL-PLANE key, not a manual-order
 * key. It signs manual orders AND the Shariah installation-floor push, and the
 * floor is armed whether or not manual order submission is enabled — so a
 * malformed key must fail startup regardless of MANUAL_TRADING_ENABLED. It was
 * validated only when manual trading was on, which left the control plane
 * holding a key nothing had checked.
 *
 * Presence stays required only for manual trading: an installation with no
 * execution Bot needs no key, and `manualBotControlRequest` refuses with a 503
 * rather than signing with a missing one.
 */
if (config.manualTradingHmacSecret.length > 0 && config.manualTradingHmacSecret.length < 32) {
  throw new Error("MANUAL_TRADING_HMAC_SECRET must be at least 32 characters");
}
if (config.manualTradingHmacSecret.length >= 32
    && isPublishedPlaceholder(config.manualTradingHmacSecret)) {
  throw new Error("MANUAL_TRADING_HMAC_SECRET is a published placeholder value — generate a real one");
}
if (config.manualTradingEnabled && config.manualTradingHmacSecret.length === 0) {
  throw new Error("MANUAL_TRADING_HMAC_SECRET must be set when manual trading is enabled");
}
if (config.spotExecutionEnabled && config.manualTradingHmacSecret.length === 0) {
  throw new Error("MANUAL_TRADING_HMAC_SECRET must be set when spot execution is enabled");
}
if (config.derivativeExecutionEnabled && config.manualTradingHmacSecret.length === 0) {
  throw new Error("MANUAL_TRADING_HMAC_SECRET must be set when derivatives execution is enabled");
}
if (config.equityPaperExecutionEnabled && config.manualTradingHmacSecret.length === 0) {
  throw new Error("MANUAL_TRADING_HMAC_SECRET must be set when equity paper execution is enabled");
}
if (config.equityPaperExecutionEnabled && !alpacaDataParts.every(Boolean)) {
  throw new Error("Alpaca paper/data credentials and classification provenance are required when equity paper execution is enabled");
}
if (config.realizationIngestionEnabled && config.realizationHmacSecret.length < 32) {
  throw new Error("REALIZATION_HMAC_SECRET must be at least 32 characters when realization ingestion is enabled");
}
if (config.realizationIngestionEnabled && isPublishedPlaceholder(config.realizationHmacSecret)) {
  throw new Error("REALIZATION_HMAC_SECRET is a published placeholder value — generate a real one");
}
if (config.manualTradingEnabled || config.spotExecutionEnabled || config.derivativeExecutionEnabled
    || config.equityPaperExecutionEnabled) {
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
