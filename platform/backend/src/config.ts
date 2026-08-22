import "dotenv/config";

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: string;
  alertEncryptionKey: string;
  allowedWebhookHosts: string[];
  liveTestEnabled: boolean;
  /** Cookie-session auth. Disabled locally unless credentials are configured. */
  authEnabled: boolean;
  adminUsername: string;
  adminPasswordHash: string;
  sessionSecret: string;
  /** Emit `Secure` on the session cookie — must be off for plain-HTTP dev. */
  cookieSecure: boolean;
}

export const config: AppConfig = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://platform:platform@localhost:5433/platform",
  logLevel: process.env.LOG_LEVEL ?? "info",
  alertEncryptionKey: process.env.ALERT_ENCRYPTION_KEY ?? "",
  allowedWebhookHosts: (process.env.ALLOWED_WEBHOOK_HOSTS ?? "bot.alphawebstudioz.com,api.3commas.io")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
  liveTestEnabled: process.env.LIVE_TEST_ENABLED === "true",
  authEnabled: process.env.AUTH_ENABLED !== "false" && !!process.env.ADMIN_PASSWORD_HASH,
  adminUsername: process.env.ADMIN_USERNAME ?? "admin",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  cookieSecure: process.env.COOKIE_SECURE !== "false",
};

// A session signed with a guessable secret is no session at all, so refuse to
// start rather than serving an app that only looks protected.
if (config.authEnabled && config.sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters when auth is enabled");
}

if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
  throw new Error(`Invalid PORT: ${JSON.stringify(process.env.PORT)}`);
}

if (config.alertEncryptionKey.length < 32) {
  throw new Error("ALERT_ENCRYPTION_KEY must be at least 32 characters");
}
