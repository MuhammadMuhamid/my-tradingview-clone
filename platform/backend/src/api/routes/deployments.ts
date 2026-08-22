import type { FastifyInstance } from "fastify";
import * as deploymentRepo from "../../repositories/deployments";
import * as alertRepo from "../../repositories/alerts";
import * as strategyRepo from "../../repositories/strategies";
import * as symbolRepo from "../../repositories/symbols";
import { isInterval } from "../../types/market";
import type { DeliveryMode } from "../../types/deployments";
import type { StrategyParams } from "../../types/strategy";
import type { LiveRunner } from "../../engine/liveRunner";
import { buildPayload, deliver, validateWebhookUrl, type SignalContext } from "../../alerts/dispatcher";
import { validateDeploymentPatch, type DeploymentPatchInput } from "../deploymentPatch";
import { config as appConfig } from "../../config";

const DELIVERY_MODES: DeliveryMode[] = ["3commas", "custom", "off"];
const publicDeployment = <T extends { secret: string | null; botUuid: string | null }>(d: T) => ({
  ...d,
  secret: d.secret ? "[CONFIGURED]" : null,
  botUuid: d.botUuid ? "[CONFIGURED]" : null,
});

export function deploymentRoutes(getRunner: () => LiveRunner) {
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
      if (delivery !== "off" && (!body.secret || body.secret.length < 32)) {
        return reply.code(400).send({ error: "a webhook secret of at least 32 characters is required" });
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
      const built = buildPayload(dep, ctx);
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
  };
}
