import Fastify, { FastifyError, FastifyInstance } from "fastify";
import { config } from "../config";
import { clientKey, loginLimiter } from "../security/rateLimit";
import { healthRoutes } from "./routes/health";
import { symbolRoutes } from "./routes/symbols";
import { strategyRoutes } from "./routes/strategies";
import { backtestRoutes } from "./routes/backtests";
import { dataRoutes } from "./routes/data";
import { deploymentRoutes } from "./routes/deployments";
import { optimizerRoutes } from "./routes/optimizer";
import { layoutRoutes } from "./routes/layouts";
import { pineRoutes } from "./routes/pine";
import { pushRoutes } from "./routes/push";
import { authRoutes } from "./routes/auth";
import { watchlistRoutes } from "./routes/watchlists";
import { maAlertRoutes } from "./routes/maAlerts";
import { operationsRoutes } from "./routes/operations";
import { manualTradingRoutes } from "./routes/manualTrading";
import { scannerRoutes } from "./routes/scanner";
import { tradingTimelineRoutes } from "./routes/tradingTimeline";
import { journalRoutes } from "./routes/journal";
import type { LiveRunner } from "../engine/liveRunner";
import {
  SESSION_COOKIE, readCookie, sessionCookie, signSession, verifySession,
} from "../security/session";

/** Reachable without a session: health probes and the sign-in flow itself. */
const PUBLIC_PATHS = new Set([
  "/health", "/healthz", "/readyz", "/api/auth/login", "/api/auth/logout", "/api/auth/me",
]);

/**
 * Response headers applied to every reply.
 *
 * This API serves JSON only, so the CSP is the most restrictive one that still
 * works: nothing may load, and nothing may frame it. The frontend sets its own,
 * looser policy for the page that actually renders the chart.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
};

export function buildServer(getRunner: () => LiveRunner): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 256 * 1024,
    // `req.ip` must not be spoofable. Only trust forwarded headers when a
    // proxy we operate is known to set them.
    trustProxy: config.trustProxy,
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    // HSTS is meaningless over plain HTTP and would pin a dev machine to HTTPS.
    if (config.cookieSecure) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  /**
   * Sign-in rate limit. Each attempt costs ~100 ms of scrypt on the same event
   * loop that evaluates live bar closes, so unbounded guessing is a denial of
   * service as well as a credential risk.
   *
   * Only the sign-in attempt is counted. The sliding session cookie is renewed
   * on every other request and must never be throttled, or a normal browsing
   * session would start failing.
   */
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (path !== "/api/auth/login" || req.method !== "POST") return;
    const key = clientKey(req.ip, req.headers["x-forwarded-for"], config.trustProxy);
    const decision = loginLimiter.hit(key);
    if (!decision.allowed) {
      req.log.warn({ ip: key }, "sign-in rate limit exceeded");
      reply.header("retry-after", String(decision.retryAfterSec));
      return reply.code(429).send({ error: "Too many sign-in attempts. Try again shortly." });
    }
  });

  /**
   * Session gate. Runs before every route so a new endpoint is protected by
   * default rather than by remembering to add a guard.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!config.authEnabled) return;
    const path = req.url.split("?")[0] ?? "";
    if (PUBLIC_PATHS.has(path)) return;

    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const claims = token
      ? verifySession(token, config.sessionSecret, { expectedUsername: config.adminUsername })
      : null;
    if (!claims) {
      return reply.code(401).send({ error: "not authenticated" });
    }
    // Slide the expiry so an actively used browser never has to sign in again.
    reply.header(
      "set-cookie",
      sessionCookie(signSession(claims.username, config.sessionSecret), config.cookieSecure)
    );
  });

  /**
   * Terminal error handler. A 5xx never carries the thrown message or a stack:
   * this process holds decrypted webhook secrets, database DSNs and exchange
   * symbol state, and any of those can end up in an exception string.
   *
   * 4xx messages are kept because they are the validation feedback the UI
   * shows, and they are authored by this codebase rather than by a driver.
   */
  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error(err);
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      return reply.code(status).send({ error: "internal server error" });
    }
    return reply.code(status).send({ error: err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: `no route for ${req.method} ${req.url.split("?")[0]}` });
  });

  app.register(authRoutes);
  app.register(healthRoutes);
  app.register(symbolRoutes);
  app.register(strategyRoutes);
  app.register(backtestRoutes);
  app.register(dataRoutes);
  app.register(deploymentRoutes(getRunner));
  app.register(optimizerRoutes);
  app.register(layoutRoutes);
  app.register(pineRoutes);
  app.register(pushRoutes);
  app.register(maAlertRoutes);
  app.register(watchlistRoutes);
  app.register(operationsRoutes(getRunner));
  app.register(manualTradingRoutes);
  app.register(scannerRoutes);
  app.register(tradingTimelineRoutes);
  app.register(journalRoutes);

  return app;
}
