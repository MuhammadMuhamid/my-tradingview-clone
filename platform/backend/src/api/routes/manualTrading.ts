import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config";
import { ManualBotError, manualBotRequest } from "../../manualTrading/client";

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ManualBotError("invalid request body", 400);
  return body as Record<string, unknown>;
}

function requestIdentity(body: Record<string, unknown>): string {
  const id = body.requestId;
  if (typeof id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(id)) return id;
  return randomUUID();
}

async function send<T>(reply: FastifyReply, action: () => Promise<T>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ManualBotError) return reply.code(error.status).send({ error: error.message });
    throw error;
  }
}

export async function manualTradingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/manual-trading/state", async (req, reply) => send(reply, async () => {
    if (!config.manualTradingEnabled) throw new ManualBotError("manual trading is disabled", 404);
    const symbol = (req.query as { symbol?: unknown }).symbol;
    const query = typeof symbol === "string" ? `?symbol=${encodeURIComponent(symbol)}` : "";
    return manualBotRequest({ method: "GET", path: `/api/manual-trading/state${query}` });
  }));

  app.post("/api/manual-trading/orders", async (req, reply) => send(reply, async () => {
    const body = bodyRecord(req.body); const requestId = requestIdentity(body);
    const { requestId: _browserOnly, ...command } = body;
    return manualBotRequest({ method: "POST", path: "/api/manual-trading/orders",
      body: command, requestId });
  }));

  app.post<{ Params: { id: string } }>("/api/manual-trading/orders/:id/cancel", async (req, reply) =>
    send(reply, async () => { const body = bodyRecord(req.body); const requestId = requestIdentity(body);
      const { requestId: _browserOnly, ...command } = body;
      return manualBotRequest({ method: "POST",
        path: `/api/manual-trading/orders/${encodeURIComponent(req.params.id)}/cancel`,
        body: command, requestId });
    }));

  app.patch<{ Params: { id: string } }>("/api/manual-trading/positions/:id/protection", async (req, reply) =>
    send(reply, async () => { const body = bodyRecord(req.body); const requestId = requestIdentity(body);
      const { requestId: _browserOnly, ...command } = body;
      return manualBotRequest({ method: "PATCH",
        path: `/api/manual-trading/positions/${encodeURIComponent(req.params.id)}/protection`,
        body: command, requestId });
    }));
}
