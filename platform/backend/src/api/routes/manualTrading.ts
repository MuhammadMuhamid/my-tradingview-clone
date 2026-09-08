import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config";
import { ManualBotError, manualBotRequest } from "../../manualTrading/client";
import {
  ShariahExposureBlockedError, assertShariahExposureAllowed,
  normalizeSpotSide, type ShariahGateDeps, type SpotSide,
} from "../../shariah/gate";

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
    // A refused new-exposure intent is an operator-readable 403, not a generic
    // failure: the panel shows this string verbatim so the user learns WHY the
    // BUY was blocked and that SELL is still available.
    if (error instanceof ShariahExposureBlockedError) {
      return reply.code(error.status).send({ error: error.message, shariah: error.context });
    }
    if (error instanceof ManualBotError) return reply.code(error.status).send({ error: error.message });
    throw error;
  }
}

/**
 * Fail closed on an unreadable side.
 *
 * The route is otherwise a pass-through — the Bot owns command validation — so
 * a body with a missing or malformed `side` reaches here. Treating it as BUY
 * means the Shariah gate applies to it; the Bot then rejects the malformed
 * command on its own terms, exactly as before. Treating it as SELL would make
 * `side: "bUy "` a bypass.
 */
function gatedSide(command: Record<string, unknown>): SpotSide {
  return normalizeSpotSide(command.side) ?? "BUY";
}

export async function manualTradingRoutes(
  app: FastifyInstance,
  dependencies: { shariah?: ShariahGateDeps } = {}
): Promise<void> {
  const shariahDeps = dependencies.shariah ?? {};

  /**
   * Advisory account context for the ticket: free and locked for the two assets
   * of one symbol, plus the exchange's own size and price rules.
   *
   * A pure pass-through to the Bot, deliberately. Binance credentials stay on
   * the execution side and never come here; this is the same authenticated
   * boundary the order itself crosses. It is read-only and it authorises
   * nothing — the Bot re-derives everything it needs at submission time, so a
   * figure shown here can inform a human but can never widen what executes.
   */
  app.get("/api/manual-trading/account-state", async (req, reply) => send(reply, async () => {
    if (!config.manualTradingEnabled) throw new ManualBotError("manual trading is disabled", 404);
    const query = req.query as { symbol?: unknown; accountId?: unknown };
    const symbol = typeof query.symbol === "string" ? query.symbol : "";
    const accountId = typeof query.accountId === "string" ? query.accountId : "";
    if (!symbol || !accountId) throw new ManualBotError("symbol and accountId are required", 400);
    return manualBotRequest({ method: "GET",
      path: `/api/manual-trading/account-state?accountId=${encodeURIComponent(accountId)}`
        + `&symbol=${encodeURIComponent(symbol)}` });
  }));

  app.get("/api/manual-trading/state", async (req, reply) => send(reply, async () => {
    if (!config.manualTradingEnabled) {
      // This read is also the browser's capability handshake. A stable 200
      // keeps an intentionally disabled installation out of the error console;
      // no Bot is contacted, and every mutating route remains fail-closed.
      return {
        enabled: false,
        mainnetEnabled: false,
        dryRun: true,
        mixed: false,
        accounts: [],
        orders: [],
        positions: [],
        protection: {
          type: "bot-managed",
          exchangeResting: false,
          note: "Manual trading is disabled; no execution Bot was contacted.",
        },
      };
    }
    const symbol = (req.query as { symbol?: unknown }).symbol;
    const query = typeof symbol === "string" ? `?symbol=${encodeURIComponent(symbol)}` : "";
    return manualBotRequest({ method: "GET", path: `/api/manual-trading/state${query}` });
  }));

  /**
   * The manual BUY/SELL path. This is a new-exposure path, so it is gated
   * BEFORE the Bot is contacted; the browser is never trusted to have applied
   * the rule, and any client-supplied `shariah` key is discarded rather than
   * forwarded — the block that ships is the one this backend just computed.
   */
  app.post("/api/manual-trading/orders", async (req, reply) => send(reply, async () => {
    const body = bodyRecord(req.body); const requestId = requestIdentity(body);
    const { requestId: _browserOnly, shariah: _neverTrustedFromClient, ...command } = body;

    const context = await assertShariahExposureAllowed(
      { symbol: String(command.symbol ?? ""), side: gatedSide(command) },
      shariahDeps
    );

    /*
     * The block rides inside the signed request body — `client.ts`
     * canonicalises the WHOLE body into the HMAC — so it cannot be added,
     * removed or edited in flight, and needs no signature of its own. It ships
     * unconditionally: an installation where the operator has turned Shariah
     * Mode on must not depend on a second, hidden switch to actually send the
     * evidence that lets the Bot enforce it.
     */
    return manualBotRequest({ method: "POST", path: "/api/manual-trading/orders",
      body: { ...command, shariah: context }, requestId });
  }));

  // Cancelling an order and editing stop-loss/take-profit protection can only
  // reduce or bound existing exposure, never create it, so neither is gated —
  // and neither must be, since an EXCLUDED position still has to be exitable.
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
