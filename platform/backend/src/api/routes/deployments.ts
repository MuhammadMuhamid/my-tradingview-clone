import type { FastifyInstance } from "fastify";
import * as deploymentRepo from "../../repositories/deployments";
import * as alertRepo from "../../repositories/alerts";
import * as strategyRepo from "../../repositories/strategies";
import * as symbolRepo from "../../repositories/symbols";
import { isInterval } from "../../types/market";
import { deliversLiveOrders, type DeliveryMode } from "../../types/deployments";
import type { StrategyParams } from "../../types/strategy";
import type { LiveRunner } from "../../engine/liveRunner";
import {
  buildPayload, deliver, validateWebhookUrl, withShariahEvidence, type SignalContext,
} from "../../alerts/dispatcher";
import { validateDeploymentPatch, type DeploymentPatchInput } from "../deploymentPatch";
import { config as appConfig } from "../../config";
import * as paperRepo from "../../repositories/paperFills";
import { PAPER_COMMISSION_PCT, summarisePaper } from "../../engine/paperBroker";
import { evaluateShariahGate, type ShariahGateDeps } from "../../shariah/gate";

const DELIVERY_MODES: DeliveryMode[] = ["3commas", "custom", "off", "paper"];
const publicDeployment = <T extends { secret: string | null; botUuid: string | null }>(d: T) => ({
  ...d,
  secret: d.secret ? "[CONFIGURED]" : null,
  botUuid: d.botUuid ? "[CONFIGURED]" : null,
});

export function deploymentRoutes(
  getRunner: () => LiveRunner,
  deps: { shariah?: ShariahGateDeps } = {}
) {
  return async function (app: FastifyInstance): Promise<void> {
    const runner = { activate: (id: string) => getRunner().activate(id), deactivate: (id: string) => getRunner().deactivate(id) };
    app.post("/api/deployments", async (req, reply) => {
      const body = req.body as {
        strategyKey?: string;
        configId?: string;
        symbol?: string;
        timeframe?: string;
        params?: StrategyParams;
        delivery?: string;
        webhookUrl?: string;
        secret?: string;
        botUuid?: string;
        buyQuoteQty?: number;
      };
      if (!body?.strategyKey) return reply.code(400).send({ error: "strategyKey is required" });
      const strategy = await strategyRepo.getStrategyByKey(body.strategyKey);
      if (!strategy) return reply.code(404).send({ error: "strategy not found" });

      let baseParams: StrategyParams = {};
      let symbol = body.symbol?.toUpperCase();
      let timeframe = body.timeframe;
      if (body.configId) {
        const config = await strategyRepo.getConfig(body.configId);
        if (!config) return reply.code(404).send({ error: "config not found" });
        baseParams = config.params;
        symbol = symbol ?? config.symbol ?? undefined;
        timeframe = timeframe ?? config.timeframe;
      }
      if (!symbol) return reply.code(400).send({ error: "symbol is required" });
      if (!(await symbolRepo.getSymbol(symbol))) {
        return reply.code(404).send({ error: `unknown symbol: ${symbol}` });
      }
      if (!timeframe || !isInterval(timeframe)) {
        return reply.code(400).send({ error: `invalid timeframe: ${timeframe}` });
      }
      const delivery = (body.delivery ?? "custom") as DeliveryMode;
      if (!DELIVERY_MODES.includes(delivery)) {
        return reply.code(400).send({ error: `delivery must be one of ${DELIVERY_MODES.join(", ")}` });
      }
      if (delivery === "custom" && !body.webhookUrl) {
        return reply.code(400).send({ error: "custom delivery requires webhookUrl" });
      }
      if (body.webhookUrl) {
        try { body.webhookUrl = validateWebhookUrl(body.webhookUrl); }
        catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
      }
      // A secret is a credential for an outbound call. `off` and `paper` make
      // no outbound call, so requiring one would mean holding a credential for
      // a deployment that cannot use it.
      if (deliversLiveOrders(delivery) && (!body.secret || body.secret.length < 32)) {
        return reply.code(400).send({ error: "a webhook secret of at least 32 characters is required" });
      }
      // Paper needs an order size for the same reason a live deployment does:
      // a simulated fill of an unstated size is not a simulation of anything.
      if (delivery === "paper" && (!Number.isFinite(body.buyQuoteQty) || (body.buyQuoteQty ?? 0) <= 0)) {
        return reply.code(400).send({ error: "paper delivery requires buyQuoteQty, the size to simulate" });
      }
      if (delivery === "custom" && (!Number.isFinite(body.buyQuoteQty) || (body.buyQuoteQty ?? 0) <= 0 || (body.buyQuoteQty ?? 0) > 10_000)) {
        return reply.code(400).send({ error: "buyQuoteQty must be greater than 0 and at most 10000" });
      }
      if (delivery === "3commas" && !body.botUuid) {
        return reply.code(400).send({ error: "3commas delivery requires botUuid" });
      }

      const created = await deploymentRepo.createDeployment({
        strategyId: strategy.id,
        configId: body.configId,
        symbol,
        timeframe,
        params: { ...baseParams, ...(body.params ?? {}) },
        delivery,
        webhookUrl: body.webhookUrl,
        secret: body.secret,
        botUuid: body.botUuid,
        buyQuoteQty: body.buyQuoteQty,
      });
      return reply.code(201).send(publicDeployment(created));
    });

    app.get("/api/deployments", async () => (await deploymentRepo.listDeployments()).map(publicDeployment));

    app.get("/api/deployments/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const dep = await deploymentRepo.getDeployment(id);
      if (!dep) return reply.code(404).send({ error: "deployment not found" });
      return publicDeployment(dep);
    });

    /**
     * Edit an alert's delivery settings (TradingView "edit alert"): buy
     * amount, webhook URL, secret, bot UUID, delivery mode. Strategy identity
     * (symbol/timeframe/params) is not editable — recreate the alert instead.
     * Takes effect on the next confirmed bar; no pause needed.
     */
    app.patch("/api/deployments/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const dep = await deploymentRepo.getDeployment(id);
      if (!dep) return reply.code(404).send({ error: "deployment not found" });
      const result = validateDeploymentPatch(dep, (req.body ?? {}) as DeploymentPatchInput);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      const updated = await deploymentRepo.updateDeployment(id, result.patch);
      return updated ? publicDeployment(updated) : reply.code(404).send({ error: "deployment not found" });
    });

    app.post("/api/deployments/:id/activate", async (req, reply) => {
      const { id } = req.params as { id: string };
      const dep = await deploymentRepo.getDeployment(id);
      if (!dep) return reply.code(404).send({ error: "deployment not found" });
      await runner.activate(id);
      const updated = await deploymentRepo.getDeployment(id);
      return updated ? publicDeployment(updated) : null;
    });

    app.post("/api/deployments/:id/pause", async (req, reply) => {
      const { id } = req.params as { id: string };
      const dep = await deploymentRepo.getDeployment(id);
      if (!dep) return reply.code(404).send({ error: "deployment not found" });
      await runner.deactivate(id);
      const updated = await deploymentRepo.getDeployment(id);
      return updated ? publicDeployment(updated) : null;
    });

    app.delete("/api/deployments/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      await runner.deactivate(id);
      const deleted = await deploymentRepo.deleteDeployment(id);
      if (!deleted) return reply.code(404).send({ error: "deployment not found" });
      return reply.code(204).send();
    });

    app.get("/api/deployments/:id/alerts", async (req) => {
      const { id } = req.params as { id: string };
      const q = req.query as { limit?: string };
      return alertRepo.listAlerts({
        deploymentId: id,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
      });
    });

    /**
     * Guarded end-to-end webhook test for a PAUSED deployment. This exercises
     * the same payload builder, alert persistence, dedupe and HTTP dispatcher
     * as a real strategy signal without waiting for a market setup.
     *
     * Safety constraints: explicit confirmation phrase, paused deployment,
     * custom delivery only, and a hard $20 ceiling on test buys.
     */
    app.post("/api/deployments/:id/test-signal", async (req, reply) => {
      if (!appConfig.liveTestEnabled) return reply.code(404).send({ error: "not found" });
      const { id } = req.params as { id: string };
      const body = req.body as { action?: "buy" | "sell"; confirmation?: string };
      if (body.confirmation !== "LIVE_TEST") {
        return reply.code(400).send({ error: "confirmation must equal LIVE_TEST" });
      }
      if (body.action !== "buy" && body.action !== "sell") {
        return reply.code(400).send({ error: "action must be buy or sell" });
      }
      const dep = await deploymentRepo.getDeployment(id);
      if (!dep) return reply.code(404).send({ error: "deployment not found" });
      if (dep.status !== "paused") {
        return reply.code(409).send({ error: "test-signal requires a paused deployment" });
      }
      if (dep.delivery !== "custom" || !dep.webhookUrl) {
        return reply.code(409).send({ error: "test-signal requires custom webhook delivery" });
      }
      if (body.action === "buy" && ((dep.buyQuoteQty ?? 0) <= 0 || (dep.buyQuoteQty ?? 0) > 20)) {
        return reply.code(409).send({ error: "test buy must be greater than 0 and at most 20 USDT" });
      }

      /*
       * This route places a REAL order through the same dispatcher the live
       * runner uses, so it is a real new-exposure path and is gated like one.
       * A $20 ceiling bounds the size of a mistake; it does not make buying a
       * non-ELIGIBLE asset acceptable while Shariah Mode is on.
       */
      const shariah = await evaluateShariahGate(
        { symbol: dep.symbol, side: body.action === "buy" ? "BUY" : "SELL" },
        deps.shariah ?? {}
      );
      if (!shariah.allowed) {
        return reply.code(403).send({ error: shariah.reason, shariah: shariah.context });
      }

      const tickerRes = await fetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(dep.symbol)}`
      );
      if (!tickerRes.ok) {
        return reply.code(502).send({ error: `Binance ticker failed (${tickerRes.status})` });
      }
      const ticker = await tickerRes.json() as { price?: string };
      const price = Number(ticker.price);
      if (!Number.isFinite(price) || price <= 0) {
        return reply.code(502).send({ error: "invalid Binance ticker price" });
      }

      const barTime = Date.now();
      const barIndex = Math.floor(barTime / 60_000);
      const estimatedQty = (dep.buyQuoteQty ?? 0) / price;
      const ctx: SignalContext = {
        action: body.action,
        price,
        barTime,
        barIndex,
        marketPosition: body.action === "buy" ? "long" : "flat",
        positionSize: body.action === "buy" ? estimatedQty : 0,
        prevMarketPosition: body.action === "buy" ? "flat" : "long",
        prevPositionSize: body.action === "buy" ? 0 : estimatedQty,
        contracts: estimatedQty,
      };
      // Same reasoning as LiveRunner: the gate above decided, and the decision
      // has to travel with the order so the receiver can apply it too.
      const built = withShariahEvidence(buildPayload(dep, ctx),
        { symbol: dep.symbol, side: body.action, context: shariah.context });
      if (built.dedupeKey && await alertRepo.dedupeKeyExists(dep.id, built.dedupeKey)) {
        return reply.code(409).send({ error: "duplicate test signal" });
      }
      const alert = await alertRepo.createAlert({
        deploymentId: dep.id,
        barTime,
        action: body.action,
        marketPosition: ctx.marketPosition,
        positionSize: ctx.positionSize,
        triggerPrice: price,
        reason: "manual-live-test",
        payload: built.payload,
        dedupeKey: built.dedupeKey,
        deliveryStatus: "pending",
      });
      const result = await deliver(built.url, built.payload, { maxAttempts: 1, timeoutMs: 12_000 });
      await alertRepo.markDelivery(alert.id, result);
      return {
        alertId: alert.id,
        action: body.action,
        symbol: dep.symbol,
        quoteOrderQty: body.action === "buy" ? dep.buyQuoteQty : undefined,
        triggerPrice: price,
        dedupeKey: built.dedupeKey,
        delivery: result,
      };
    });

    app.get("/api/alerts", async (req) => {
      const q = req.query as { limit?: string };
      return alertRepo.listAlerts({ limit: q.limit !== undefined ? Number(q.limit) : undefined });
    });

    /**
     * A paper deployment's simulated fills and their running result.
     *
     * Separate from `/api/deployments/:id/alerts`, which is the signal log: an
     * alert is what the strategy decided, a paper fill is what the simulation did
     * with it, and conflating them is how a refused simulation would read as a
     * successful one.
     */
    app.get("/api/deployments/:id/paper", async (req, reply) => {
      const { id } = req.params as { id: string };
      const dep = await deploymentRepo.getDeployment(id);
      if (!dep) return reply.code(404).send({ error: "deployment not found" });
      if (dep.delivery !== "paper") {
        return reply.code(409).send({
          error: `deployment ${id} has delivery "${dep.delivery}", not "paper" — it has no simulated fills`,
          delivery: dep.delivery,
        });
      }
      const fills = await paperRepo.listFills(id);
      // Newest-first from the database; the summary needs them in fill order.
      const ordered = [...fills].reverse();
      const summary = summarisePaper(
        ordered.map((f) => ({
          action: f.action, barTime: f.barTime, price: f.price, qty: f.qty,
          quote: f.quote, commission: f.commission, realisedPnl: f.realisedPnl,
          positionAfter: {
            qty: f.positionQty, costBasis: f.costBasis,
            entryPrice: f.entryPrice, entryBarTime: null,
          },
        })),
        { markPrice: null }
      );
      return {
        deploymentId: id,
        symbol: dep.symbol,
        timeframe: dep.timeframe,
        buyQuoteQty: dep.buyQuoteQty,
        commissionPctPerSide: PAPER_COMMISSION_PCT,
        /*
         * Said plainly, because a paper result reads like a backtest result and
         * is a weaker claim than one: it is forward-simulated on live bars at the
         * live cost model, and it assumes every market order fills at the signal
         * bar's close with no slippage and no partial fill.
         */
        caveat:
          "Simulated. Fills are assumed at the signal bar's close with no slippage and no "
          + "partial fill, at 0.1 % commission per side. A live order is a market order and "
          + "will differ.",
        summary,
        fills: fills.map((f) => ({
          ...f,
          barTime: new Date(f.barTime).toISOString(),
          filledAt: new Date(f.filledAt).toISOString(),
        })),
      };
    });

  };

}
