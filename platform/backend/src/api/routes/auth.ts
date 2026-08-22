/**
 * Sign-in for the single admin user. Successful login sets a 90-day signed
 * cookie; every authenticated request slides the expiry forward, so an
 * actively used browser is never signed out.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../../config";
import {
  SESSION_COOKIE, clearCookie, readCookie, safeEqual, sessionCookie,
  signSession, verifyPassword, verifySession,
} from "../../security/session";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/auth/me", async (req) => {
    if (!config.authEnabled) return { authenticated: true, username: null, authEnabled: false };
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const claims = token ? verifySession(token, config.sessionSecret) : null;
    return {
      authenticated: !!claims,
      username: claims?.username ?? null,
      authEnabled: true,
    };
  });

  app.post("/api/auth/login", async (req, reply) => {
    if (!config.authEnabled) return { ok: true, authEnabled: false };
    const { username, password } = (req.body ?? {}) as {
      username?: string; password?: string;
    };
    if (!username || !password) {
      return reply.code(400).send({ error: "username and password are required" });
    }
    const userOk = safeEqual(username, config.adminUsername);
    const passOk = verifyPassword(password, config.adminPasswordHash);
    // Both checks always run, and the message never says which half failed.
    if (!userOk || !passOk) {
      req.log.warn({ ip: req.ip }, "failed sign-in attempt");
      return reply.code(401).send({ error: "Incorrect username or password" });
    }
    reply.header(
      "set-cookie",
      sessionCookie(signSession(username, config.sessionSecret), config.cookieSecure)
    );
    return { ok: true, username };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.header("set-cookie", clearCookie(config.cookieSecure));
    return { ok: true };
  });
}
