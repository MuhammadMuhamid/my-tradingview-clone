/**
 * Web Push registration. The browser needs the VAPID public key BEFORE it can
 * call pushManager.subscribe(), so the key is served unauthenticated — it is
 * public by design; only the private half signs.
 */
import type { FastifyInstance } from "fastify";
import * as pushRepo from "../../repositories/pushSubscriptions";
import { getVapidKeys, sendPush, validatePushEndpoint } from "../../alerts/webPush";

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/push/vapid", async () => {
    const { publicKey } = await getVapidKeys();
    return { publicKey, devices: await pushRepo.countSubscriptions() };
  });

  app.post("/api/push/subscribe", async (req, reply) => {
    const body = req.body as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      return reply
        .code(400)
        .send({ error: "endpoint and keys.p256dh / keys.auth are required" });
    }
    try {
      // Validated, but the row keeps the browser's exact string: unsubscribe
      // matches on the endpoint the client sends back, and storing a
      // normalised variant would leave rows that can never be deleted.
      validatePushEndpoint(endpoint);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const row = await pushRepo.saveSubscription({
      endpoint,
      p256dh,
      auth,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    });
    return reply.code(201).send({ id: row.id, devices: await pushRepo.countSubscriptions() });
  });

  app.post("/api/push/unsubscribe", async (req, reply) => {
    const { endpoint } = (req.body ?? {}) as { endpoint?: string };
    if (!endpoint) return reply.code(400).send({ error: "endpoint is required" });
    await pushRepo.deleteByEndpoint(endpoint);
    return { ok: true, devices: await pushRepo.countSubscriptions() };
  });

  /** Round-trip check so the user can confirm the phone actually buzzes. */
  app.post("/api/push/test", async (req) => {
    return sendPush(
      {
        title: "Test alert",
        body: "Push notifications are working.",
        tag: "push-test",
        url: "/chart",
      },
      req.log
    );
  });
}
