/**
 * Bot execution notifications (P-81): the signed-in ADMIN's opt-in and the
 * status the /bot card shows. Admin-only twice: `/api/bot` is not in
 * `userMayReach`, and each handler checks the role itself, so a Standard user
 * can neither read Bot executions nor subscribe to them.
 *
 * Opting in only records a preference. The browser's own permission prompt
 * and device subscription stay on the existing `/api/push/*` routes, so there
 * is one push subscription system, not two.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config";
import * as pushRepo from "../../repositories/pushSubscriptions";
import { isAdmin, userIdOf } from "../../security/requestUser";
import { isManualControlChannelConfigured } from "../../manualTrading/client";
import {
  botSupportsFeed, defaultDeps, readPreference, recentExecutions, writePreference,
} from "../../botExecutions/notifier";

export type BotFeedSupport = "yes" | "no" | "unreachable" | "not_configured";

export async function botNotificationRoutes(
  app: FastifyInstance,
  dependencies: { feedSupport?: () => Promise<BotFeedSupport> } = {}
): Promise<void> {
  const feedSupport = dependencies.feedSupport ?? (async (): Promise<BotFeedSupport> => {
    if (!isManualControlChannelConfigured()) return "not_configured";
    const supported = await botSupportsFeed(defaultDeps(app.log)).catch(() => null);
    return supported === null ? "unreachable" : supported ? "yes" : "no";
  });

  const refuse = (req: FastifyRequest) => (isAdmin(req) ? null : { error: "admin only" });

  app.get("/api/bot/notifications", async (req, reply) => {
    const refused = refuse(req);
    if (refused) return reply.code(403).send(refused);
    const userId = userIdOf(req);
    return {
      featureEnabled: config.botExecutionNotificationsEnabled,
      botFeed: config.botExecutionNotificationsEnabled ? await feedSupport() : "not_configured",
      enabled: await readPreference(userId),
      devices: await pushRepo.countSubscriptions(userId),
      recent: await recentExecutions(10),
    };
  });

  app.put("/api/bot/notifications", async (req, reply) => {
    const refused = refuse(req);
    if (refused) return reply.code(403).send(refused);
    const body = req.body as { enabled?: unknown } | undefined;
    if (!body || typeof body.enabled !== "boolean" || Object.keys(body).length !== 1) {
      return reply.code(400).send({ error: "body must be { enabled: true | false }" });
    }
    const userId = userIdOf(req);
    await writePreference(userId, body.enabled);
    return { enabled: body.enabled, devices: await pushRepo.countSubscriptions(userId) };
  });
}
