import Fastify, { FastifyError, FastifyInstance } from "fastify";
import { config } from "../config";
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
import type { LiveRunner } from "../engine/liveRunner";
import {
  SESSION_COOKIE, readCookie, sessionCookie, signSession, verifySession,
} from "../security/session";

/** Reachable without a session: health probes and the sign-in flow itself. */
const PUBLIC_PATHS = new Set([
  "/health", "/healthz", "/api/auth/login", "/api/auth/logout", "/api/auth/me",
]);

export function buildServer(getRunner: () => LiveRunner): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 256 * 1024,
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
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
    const claims = token ? verifySession(token, config.sessionSecret) : null;
    if (!claims) {
      return reply.code(401).send({ error: "not authenticated" });
    }
    // Slide the expiry so an actively used browser never has to sign in again.
    reply.header(
      "set-cookie",
      sessionCookie(signSession(claims.username, config.sessionSecret), config.cookieSecure)
    );
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error(err);
    const status = err.statusCode ?? 500;
    reply.code(status).send({
      error: status === 500 ? "internal server error" : err.message,
    });
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

  return app;
}
