import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config";
import { ManualBotError, manualBotRequest } from "../../manualTrading/client";

/**
 * The Bot section's reads.
 *
 * An explicit list of three read-only operations rather than a proxy: the
 * browser never names a Bot path, and the only values it supplies are checked
 * here and rebuilt into the signed query. Nothing here can place, change or
 * cancel anything. Admin-only because `userMayReach` doesn't list `/api/bot`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 100;

function positiveInt(raw: unknown, fallback: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) {
    throw new ManualBotError(`${name} must be a whole number from 1 to ${max}`, 400);
  }
  return Number(raw);
}

export function botTradesPath(query: Record<string, unknown>): string {
  if (query.status !== "active" && query.status !== "closed") {
    throw new ManualBotError("status must be active or closed", 400);
  }
  const params = new URLSearchParams({ status: query.status });
  if (query.botId !== undefined) {
    if (typeof query.botId !== "string" || !UUID.test(query.botId)) {
      throw new ManualBotError("botId must be a bot id", 400);
    }
    params.set("botId", query.botId);
  }
  // Feature B: only sent when asked for, so an older Bot (whose query is
  // strict and predates `tradeArchive.v1`) keeps answering the default view.
  if (query.archived !== undefined) {
    if (query.archived !== "exclude" && query.archived !== "include" && query.archived !== "only") {
      throw new ManualBotError("archived must be exclude, include or only", 400);
    }
    params.set("archived", query.archived);
  }
  params.set("page", String(positiveInt(query.page, 1, 100_000, "page")));
  params.set("pageSize", String(positiveInt(query.pageSize, 50, MAX_PAGE_SIZE, "pageSize")));
  return `/api/manual-trading/bot-view/trades?${params.toString()}`;
}

/**
 * The Bot refusing this Platform is not the signed-in person's problem.
 *
 * Passed through as it stands, the Bot's 401 for a mismatched key would reach
 * `lib/api.ts`, which sends the administrator to the sign-in page for a fault no
 * sign-in can fix. The proxy's 403 and a replay's 409 are the same kind of fault.
 */
function asPlatformError(error: ManualBotError): ManualBotError {
  if (error.status === 401 || error.status === 403 || error.status === 409) {
    return new ManualBotError(`the execution bot refused this Platform's request: ${error.message}`, 502);
  }
  return error;
}

async function send<T>(reply: FastifyReply, action: () => Promise<T>) {
  if (!config.manualTradingEnabled) {
    return reply.code(404).send({ error: "manual trading is disabled" });
  }
  try { return await action(); }
  catch (error) {
    if (error instanceof ManualBotError) {
      const mapped = asPlatformError(error);
      return reply.code(mapped.status).send({ error: mapped.message });
    }
    throw error;
  }
}

export async function botViewRoutes(
  app: FastifyInstance,
  dependencies: { botRequest?: typeof manualBotRequest } = {}
): Promise<void> {
  const botRequest = dependencies.botRequest ?? manualBotRequest;

  app.get("/api/bot/summary", async (_req, reply) => send(reply, () =>
    botRequest({ method: "GET", path: "/api/manual-trading/bot-view/summary" })));

  app.get("/api/bot/bots", async (_req, reply) => send(reply, () =>
    botRequest({ method: "GET", path: "/api/manual-trading/bot-view/bots" })));

  app.get("/api/bot/trades", async (req, reply) => send(reply, () =>
    botRequest({ method: "GET", path: botTradesPath(req.query as Record<string, unknown>) })));
}
