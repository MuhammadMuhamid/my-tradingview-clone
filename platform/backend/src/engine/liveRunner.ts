/**
 * Live runner — the Stage 3 orchestrator.
 *
 *   deployments(active) ─▶ subscribe every required (symbol, interval) stream
 *   barClose(chartTf)   ─▶ backfill any gap ─▶ evaluate the closed bar
 *                          ─▶ persist runtime state ─▶ build + deliver alert
 *
 * MTF feeds: a signal needs its higher-timeframe inputs too, but higher-TF bars
 * close less often than the chart bar. We evaluate whenever the CHART bar
 * closes and read the most recent CLOSED htf bars from the DB — matching the
 * backtester's gaps_off/lookahead_off merge. HTF streams are also subscribed so
 * their closed bars land in the DB promptly.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Interval } from "../types/market";
import type { DeploymentRow } from "../types/deployments";
import * as deploymentRepo from "../repositories/deployments";
import * as strategyRepo from "../repositories/strategies";
import * as alertRepo from "../repositories/alerts";
import * as candleRepo from "../repositories/candles";
import { ensureCandles } from "../data/binanceRest";
import { BinanceWsManager, BarCloseEvent } from "../data/binanceWs";
import { FeedStore, toBars } from "./mtf";
import { evaluateBar } from "./liveEvaluator";
import { buildPayload, deliver, SignalContext } from "../alerts/dispatcher";
import { maRrV9Module } from "./strategies/ma_rr_v9";
import { srTrendV10Module } from "./strategies/srtrend_v10";
import { evaluateSrTrendBar } from "./srTrendLiveEvaluator";
import { mtfLeanModule } from "./strategies/mtf_lean";
import { evaluateMtfLeanBar, type MtfLeanDecision } from "./mtfLeanLiveEvaluator";
import { INTERVAL_MS } from "../types/market";

const MODULES: Record<string, unknown> = {
  [maRrV9Module.key]: maRrV9Module,
  [srTrendV10Module.key]: srTrendV10Module,
  [mtfLeanModule.key]: mtfLeanModule,
};

interface ActiveDeployment {
  row: DeploymentRow;
  params: Record<string, unknown>;
  strategyKey: string;
  feeds: { symbol: string; interval: Interval; warmupBars: number }[];
  barIndexBase: number; // stable-ish bar index for dedupe keys (openTime/intervalMs)
}

export class LiveRunner {
  private ws = new BinanceWsManager();
  private active = new Map<string, ActiveDeployment>();
  private refCounts = new Map<string, number>(); // "symbol|interval" → subscriber count
  private processing = new Set<string>();         // deployment ids mid-evaluation
  private receiverSyncTimer: ReturnType<typeof setInterval> | undefined;
  private receiverSyncRunning = false;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
    this.ws.on("barClose", (e) => void this.onBarClose(e));
    this.ws.on("open", () => this.log.info({ streams: this.ws.subscriptionCount }, "binance ws open"));
    this.ws.on("close", () => this.log.warn("binance ws closed"));
    this.ws.on("error", (err) => this.log.error({ err: err.message }, "binance ws error"));
  }

  /** Load all active deployments and subscribe their streams. */
  async start(): Promise<void> {
    const deployments = await deploymentRepo.listDeployments("active");
    for (const dep of deployments) {
      try {
        await this.addDeployment(dep);
      } catch (err) {
        this.log.error({ deploymentId: dep.id, err: (err as Error).message }, "failed to activate deployment");
      }
    }
    this.log.info({ count: this.active.size }, "live runner started");
    await this.syncReceiverPositions();
    this.receiverSyncTimer = setInterval(() => void this.syncReceiverPositions(), 30_000);
  }

  /**
   * Pull active-position state from custom webhook receivers. A public cloud
   * receiver cannot call a localhost clone, so authenticated polling provides
   * reliable two-way synchronization without exposing the clone to the web.
   */
  private async syncReceiverPositions(): Promise<void> {
    if (this.receiverSyncRunning) return;
    this.receiverSyncRunning = true;
    try {
      const groups = new Map<string, { url: string; secret: string; deps: ActiveDeployment[] }>();
      for (const dep of this.active.values()) {
        if (dep.row.delivery !== "custom" || !dep.row.webhookUrl || !dep.row.secret) continue;
        let statusUrl: string;
        try {
          const url = new URL(dep.row.webhookUrl);
          if (!/\/signal_bots\/?$/.test(url.pathname)) continue;
          url.pathname = url.pathname.replace(/\/signal_bots\/?$/, "/signal_bots/status");
          statusUrl = url.toString();
        } catch {
          continue;
        }
        const key = `${statusUrl}\u0000${dep.row.secret}`;
        const group = groups.get(key) ?? { url: statusUrl, secret: dep.row.secret, deps: [] };
        group.deps.push(dep);
        groups.set(key, group);
      }

      for (const group of groups.values()) {
        try {
          const response = await fetch(group.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              secret: group.secret,
              symbols: [...new Set(group.deps.map((d) => d.row.symbol))],
            }),
            signal: AbortSignal.timeout(8_000),
          });
          if (!response.ok) {
            this.log.warn({ http: response.status }, "receiver position sync rejected");
            continue;
          }
          const body = await response.json() as { positions?: Record<string, "flat" | "long"> };
          if (!body.positions || typeof body.positions !== "object") continue;
          for (const dep of group.deps) {
            if (body.positions[dep.row.symbol] !== "flat" || this.processing.has(dep.row.id)) continue;
            const changed = await deploymentRepo.reconcileReceiverFlat(dep.row.id);
            if (changed) {
              this.log.info(
                { deploymentId: dep.row.id, symbol: dep.row.symbol },
                "receiver manual close synchronized"
              );
            }
          }
        } catch (err) {
          this.log.warn({ err: (err as Error).message }, "receiver position sync failed");
        }
      }
    } finally {
      this.receiverSyncRunning = false;
    }
  }

  async activate(deploymentId: string): Promise<void> {
    const dep = await deploymentRepo.getDeployment(deploymentId);
    if (!dep) throw new Error("deployment not found");
    const updated = await deploymentRepo.setDeploymentStatus(deploymentId, "active");
    await this.addDeployment(updated ?? dep);
  }

  async deactivate(deploymentId: string): Promise<void> {
    await deploymentRepo.setDeploymentStatus(deploymentId, "paused");
    this.removeDeployment(deploymentId);
  }

  private async addDeployment(dep: DeploymentRow): Promise<void> {
    if (this.active.has(dep.id)) this.removeDeployment(dep.id);
    const strategy = await strategyRepo.getStrategyById(dep.strategyId);
    const module = (strategy ? MODULES[strategy.key] : undefined) as typeof maRrV9Module | undefined;
    if (!module) throw new Error(`no engine module for strategy id ${dep.strategyId}`);
    const params = module.resolveParams(dep.params);
    const needs = module.requiredFeeds(params, dep.timeframe).map((n) => ({
      symbol: n.symbol ?? dep.symbol,
      interval: n.interval,
      warmupBars: n.warmupBars,
    }));

    this.active.set(dep.id, {
      row: dep,
      params,
      strategyKey: strategy!.key,
      feeds: needs,
      barIndexBase: 0,
    });
    for (const feed of needs) this.subscribeFeed(feed.symbol, feed.interval);
    this.log.info(
      { deploymentId: dep.id, symbol: dep.symbol, tf: dep.timeframe, feeds: needs.length },
      "deployment activated"
    );
  }

  private removeDeployment(deploymentId: string): void {
    const dep = this.active.get(deploymentId);
    if (!dep) return;
    for (const feed of dep.feeds) this.unsubscribeFeed(feed.symbol, feed.interval);
    this.active.delete(deploymentId);
  }

  private subscribeFeed(symbol: string, interval: Interval): void {
    const key = `${symbol}|${interval}`;
    const n = (this.refCounts.get(key) ?? 0) + 1;
    this.refCounts.set(key, n);
    if (n === 1) this.ws.subscribe(symbol, interval);
  }

  private unsubscribeFeed(symbol: string, interval: Interval): void {
    const key = `${symbol}|${interval}`;
    const n = (this.refCounts.get(key) ?? 1) - 1;
    if (n <= 0) {
      this.refCounts.delete(key);
      this.ws.unsubscribe(symbol, interval);
    } else {
      this.refCounts.set(key, n);
    }
  }

  /** A closed bar arrived. Evaluate every deployment whose chart TF matches. */
  private async onBarClose(e: BarCloseEvent): Promise<void> {
    for (const [id, dep] of this.active) {
      if (dep.row.symbol !== e.symbol || dep.row.timeframe !== e.interval) continue;
      if (this.processing.has(id)) continue; // never overlap evaluations of one deployment
      this.processing.add(id);
      try {
        await this.evaluateDeployment(id, dep, e.candle.openTime);
      } catch (err) {
        this.log.error({ deploymentId: id, err: (err as Error).message }, "live evaluation failed");
      } finally {
        this.processing.delete(id);
      }
    }
  }

  private async evaluateDeployment(
    id: string, dep: ActiveDeployment, barTime: number
  ): Promise<void> {
    const chartTf = dep.row.timeframe;
    // Fresh deployment row for current runtime state (may have been edited).
    const fresh = await deploymentRepo.getDeployment(id);
    if (!fresh || fresh.status !== "active") { this.removeDeployment(id); return; }

    // Build feeds with warmup up to and including the just-closed bar.
    const feeds = new FeedStore();
    for (const need of dep.feeds) {
      const warmupMs = need.warmupBars * INTERVAL_MS[need.interval];
      const from = barTime - warmupMs;
      // Backfill any gap (covers reconnect windows) then read from DB.
      await ensureCandles(need.symbol, need.interval, from, barTime, () => {});
      const candles = await candleRepo.getCandles(need.symbol, need.interval, { from, to: barTime });
      if (candles.length === 0) throw new Error(`no ${need.interval} data for ${need.symbol}`);
      feeds.set(toBars(candles));
    }

    // Skip if we already processed this bar (idempotent on restart / duplicate msg).
    if (fresh.lastBarTime && new Date(fresh.lastBarTime).getTime() >= barTime) return;

    if (dep.strategyKey === mtfLeanModule.key) {
      const result = evaluateMtfLeanBar(
        feeds, dep.row.symbol, chartTf, dep.params as never, fresh.runtimeState, barTime
      );
      if (result.steps.length === 0) {
        await deploymentRepo.saveRuntimeState(id, result.next, barTime);
        return;
      }
      for (let idx = 0; idx < result.steps.length; idx++) {
        const step = result.steps[idx]!;
        const accepted = await this.fireAlert(fresh, step.decision, step.stateAfter);
        if (!accepted) return;
        // Persist each accepted leg immediately. Do not mark this candle done
        // until every ordered leg has been accepted downstream.
        if (idx < result.steps.length - 1) {
          await deploymentRepo.saveRuntimeStateOnly(id, step.stateAfter);
        } else {
          await deploymentRepo.saveRuntimeState(id, step.stateAfter, barTime);
        }
      }
      return;
    }

    const { next, decision } = dep.strategyKey === srTrendV10Module.key
      ? evaluateSrTrendBar(feeds, dep.row.symbol, chartTf, dep.params as never, fresh.runtimeState, barTime)
      : evaluateBar(feeds, dep.row.symbol, chartTf, dep.params as never, fresh.runtimeState, barTime);
    if (!decision) {
      await deploymentRepo.saveRuntimeState(id, next, barTime);
      return;
    }
    // Advance live strategy state only after the downstream bot accepted the
    // order. A failed webhook must not make the clone believe it owns a
    // position that was never opened (or closed).
    const accepted = await this.fireAlert(fresh, decision, next);
    if (accepted) await deploymentRepo.saveRuntimeState(id, next, barTime);
  }

  private async fireAlert(
    dep: DeploymentRow,
    decision: MtfLeanDecision,
    nextState: { position: "flat" | "long" },
  ): Promise<boolean> {
    const barIndex = Math.floor(decision.barTime / INTERVAL_MS[dep.timeframe]);
    const ctx: SignalContext = {
      action: decision.action,
      price: decision.price,
      barTime: decision.barTime,
      barIndex,
      marketPosition: nextState.position,
      positionSize: nextState.position === "long" ? (dep.buyQuoteQty ?? 0) / decision.price : 0,
      prevMarketPosition: decision.action === "buy" ? "flat" : "long",
      prevPositionSize: decision.action === "buy" ? 0 : (dep.buyQuoteQty ?? 0) / decision.price,
      contracts:
        decision.action === "buy"
          ? (dep.buyQuoteQty ?? 0) / decision.price
          : (dep.buyQuoteQty ?? 0) / decision.price,
      sellPercent: decision.sellPercent,
      exitLeg: decision.exitLeg,
    };
    const built = buildPayload(dep, ctx);

    // Idempotency: skip if this dedupe key already fired.
    if (built.dedupeKey && (await alertRepo.dedupeKeyExists(dep.id, built.dedupeKey))) {
      this.log.warn({ deploymentId: dep.id, dedupeKey: built.dedupeKey }, "duplicate signal skipped");
      return true;
    }

    const alert = await alertRepo.createAlert({
      deploymentId: dep.id,
      barTime: decision.barTime,
      action: decision.action,
      marketPosition: ctx.marketPosition,
      positionSize: ctx.positionSize,
      triggerPrice: decision.price,
      reason: decision.reason,
      payload: built.payload,
      dedupeKey: built.dedupeKey,
      deliveryStatus: dep.delivery === "off" ? "skipped" : "pending",
    });
    this.log.info(
      { deploymentId: dep.id, action: decision.action, reason: decision.reason, price: decision.price },
      "signal fired"
    );

    if (dep.delivery === "off") return true;
    const result = await deliver(built.url, built.payload);
    await alertRepo.markDelivery(alert.id, result);
    if (result.status === "sent") {
      this.log.info({ deploymentId: dep.id, alertId: alert.id, http: result.httpStatus }, "alert delivered");
    } else {
      this.log.error(
        { deploymentId: dep.id, alertId: alert.id, status: result.status, http: result.httpStatus },
        "alert delivery failed"
      );
    }
    return result.status === "sent" || result.reconciled === true;
  }

  stop(): void {
    if (this.receiverSyncTimer) clearInterval(this.receiverSyncTimer);
    this.receiverSyncTimer = undefined;
    this.ws.close();
    this.active.clear();
    this.refCounts.clear();
  }
}
