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
import {
  buildPayload, deliver, deliveryAdvancesState, deliveryPlacedOrder,
  sellContracts, validateWebhookUrl, type SignalContext,
} from "../alerts/dispatcher";
import * as liveSafety from "../repositories/liveSafety";
import {
  countOpenPositions, describeRiskState, evaluateRisk, intendedExposure,
  realisedPnlInWindow, shouldLatchHalt, type RiskSnapshot,
} from "./riskControls";
import { assessForEvaluation } from "../data/feedHealth";
import { config } from "../config";
import { maRrV9Module } from "./strategies/ma_rr_v9";
import { srTrendV10Module } from "./strategies/srtrend_v10";
import { evaluateSrTrendBar } from "./srTrendLiveEvaluator";
import { mtfLeanModule } from "./strategies/mtf_lean";
import { evaluateMtfLeanBar, type MtfLeanDecision } from "./mtfLeanLiveEvaluator";
import { INTERVAL_MS } from "../types/market";
import { deliversLiveOrders } from "../types/deployments";
import { applyPaperSignal } from "./paperBroker";
import * as paperRepo from "../repositories/paperFills";

/**
 * How long a lease is granted for, and how often it is renewed. The renewal
 * period must be comfortably shorter than the TTL, or a slow tick would let the
 * lease lapse and a second emitter take over while this one is still running.
 */
const LEASE_TTL_MS = 90_000;
const LEASE_RENEW_MS = 30_000;

/**
 * Percentage of the original position already taken by the take-profit tiers.
 *
 * The tier SIZES live in strategy params, which this function does not have —
 * only the deployment row. `mtf_lean`'s shipped defaults are 40 % at TP1 and
 * 30 % at TP2 (`mtf_lean/params.ts`), and a strategy without partial tiers
 * never sets these flags at all, so reading the flags with the default sizes is
 * correct for every strategy that currently exists and conservative for any
 * that overrides them: it can understate what was taken, never overstate it,
 * so the receiver is never asked to sell more than the position holds.
 */
const DEFAULT_TP1_SIZE_PCT = 40;
const DEFAULT_TP2_SIZE_PCT = 30;

function exitedPctSoFar(dep: DeploymentRow): number {
  const params = dep.params as { rrTp1Size?: unknown; rrTp2Size?: unknown };
  const tp1 = typeof params.rrTp1Size === "number" ? params.rrTp1Size : DEFAULT_TP1_SIZE_PCT;
  const tp2 = typeof params.rrTp2Size === "number" ? params.rrTp2Size : DEFAULT_TP2_SIZE_PCT;
  return (dep.runtimeState.tp1Done ? tp1 : 0) + (dep.runtimeState.tp2Done ? tp2 : 0);
}

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
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  /** False whenever this process does not hold the emitter lease. */
  private holdsLease = false;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
    this.ws.on("barClose", (e) => void this.onBarClose(e));
    this.ws.on("open", () => this.log.info({ streams: this.ws.subscriptionCount }, "binance ws open"));
    this.ws.on("close", () => this.log.warn("binance ws closed"));
    this.ws.on("error", (err) => this.log.error({ err: err.message }, "binance ws error"));
    this.ws.on("stale", (e) =>
      this.log.error(
        { silentForMs: e.silentForMs, streams: e.streams },
        "binance ws went silent while still open — rebuilding. No evaluation " +
        "will run until the feed is contiguous again."
      )
    );
  }

  /** True only while this process holds the single-emitter lease. */
  get isEmitter(): boolean {
    return this.holdsLease;
  }

  /** Load all active deployments and subscribe their streams. */
  async start(): Promise<void> {
    // The lease is taken BEFORE anything subscribes. A process that cannot get
    // it must not open a websocket, must not evaluate, and above all must not
    // emit — the failure this prevents is two emitters with runtime state in
    // different databases issuing conflicting BUY/SELL (X-06, BE-18).
    this.holdsLease = await liveSafety.acquireEmitterLease(config.emitterId, LEASE_TTL_MS, {
      hostname: process.env.HOSTNAME,
      pid: process.pid,
    });
    if (!this.holdsLease) {
      const lease = await liveSafety.getEmitterLease();
      this.log.error(
        { holder: lease?.holder, expiresAt: lease ? new Date(lease.expiresAt).toISOString() : null },
        "another process holds the emitter lease — this runner will NOT emit"
      );
      return;
    }
    this.leaseTimer = setInterval(() => void this.renewLease(), LEASE_RENEW_MS);
    this.leaseTimer.unref?.();

    await this.recoverUnresolvedIntents();

    const deployments = await deploymentRepo.listDeployments("active");
    for (const dep of deployments) {
      try {
        await this.addDeployment(dep);
      } catch (err) {
        this.log.error({ deploymentId: dep.id, err: (err as Error).message }, "failed to activate deployment");
      }
    }
    const limits = await liveSafety.getRiskLimits();
    this.log.info(
      { count: this.active.size, emitter: config.emitterId, halted: limits.tradingHalted },
      "live runner started"
    );
    if (limits.tradingHalted) {
      this.log.warn(
        { reason: limits.haltedReason, by: limits.haltedBy },
        "TRADING IS HALTED — evaluation continues, no signal will be delivered"
      );
    }
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
          // This request carries the decrypted webhook secret and runs
          // unattended every 30 seconds. `deliver` validates the host, scheme
          // and port on every send; this path must apply the same rule, or a
          // deployment row edited to point elsewhere would leak the credential.
          statusUrl = validateWebhookUrl(url.toString());
        } catch (err) {
          this.log.warn(
            { deploymentId: dep.row.id, err: (err as Error).message },
            "receiver status URL rejected — position sync skipped for this deployment"
          );
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
            if (this.processing.has(dep.row.id)) continue;
            const reported = body.positions[dep.row.symbol];
            if (reported !== "flat" && reported !== "long") continue;

            if (reported === "flat") {
              const changed = await deploymentRepo.reconcileReceiverFlat(dep.row.id);
              if (changed) {
                this.log.info(
                  { deploymentId: dep.row.id, symbol: dep.row.symbol },
                  "receiver manual close synchronized"
                );
              }
              continue;
            }

            /*
             * X-03: the mirror case the reconciler could not see.
             *
             * The receiver holds a position this platform believes it does not
             * have — the exact state left behind by BE-13 (crash between
             * delivery and persistence) and BE-16 (a dedupe skip that advanced
             * state with no order placed). Continuing would issue a fresh BUY
             * into a position the platform cannot size, stop or target,
             * because it does not know the entry price.
             *
             * The deployment is paused instead of adopted. Guessing the entry
             * price would put real money behind a fabricated number.
             */
            const localPosition = (
              (await deploymentRepo.getDeployment(dep.row.id))?.runtimeState.position ?? "flat"
            );
            if (localPosition === "long") continue; // states agree; nothing to do
            const paused = await deploymentRepo.pauseOnReceiverLong(
              dep.row.id,
              `receiver reports ${dep.row.symbol} long while this deployment is flat`
            );
            if (paused) {
              this.removeDeployment(dep.row.id);
              this.log.error(
                { deploymentId: dep.row.id, symbol: dep.row.symbol },
                "STATE DIVERGENCE: the receiver holds a position this deployment " +
                "does not know about. Deployment PAUSED — it will not emit again " +
                "until an operator reconciles the entry price, stop and targets."
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
      /*
       * BE-01: the upper bound must be the LAST millisecond of the chart bar,
       * not its open time. `getCandles` applies `to` as `open_time <= to`, so
       * `to: barTime` selected the higher-timeframe bar that OPENED at or
       * before the chart bar's open — while the backtest's merge cuts off at
       * the chart bar's CLOSE. For mtf_lean's default 5m feed on a 15m chart
       * that is a two-bar, ten-minute lag on the Supertrend and volume filters
       * that gate entries. The backtest is the correct side.
       */
      const to = barTime + INTERVAL_MS[chartTf] - 1;
      // Backfill any gap (covers reconnect windows) then read from DB.
      await ensureCandles(need.symbol, need.interval, from, to, () => {});
      const candles = await candleRepo.getCandles(need.symbol, need.interval, { from, to });
      if (candles.length === 0) throw new Error(`no ${need.interval} data for ${need.symbol}`);

      /*
       * BE-14: refuse to evaluate on a feed with a hole in it.
       *
       * `ensureCandles` accepts 98.5% coverage with no contiguity check, and
       * `toBars` then packs whatever rows exist into a contiguous array — so a
       * gap silently compresses the timeline every rolling indicator is
       * computed over. For a 2100-bar 15m warmup the old tolerance was 31
       * absent bars: nearly eight hours, with no log line.
       *
       * The bar being evaluated is the chart bar; a higher-timeframe feed is
       * legitimately behind it, so each feed is judged against its own newest
       * expected bar.
       */
      const feedBarTime = need.interval === chartTf
        ? barTime
        : Math.floor(to / INTERVAL_MS[need.interval]) * INTERVAL_MS[need.interval];
      const health = assessForEvaluation(candles, need.interval, feedBarTime);
      await liveSafety.recordFeedHealth({
        symbol: need.symbol,
        interval: need.interval,
        state: health.state,
        lastBarOpenTime: health.lastBarOpenTime,
        missingBars: health.missingBars,
        detail: health.detail,
      }).catch(() => { /* health is telemetry; never let it block the gate */ });

      if (!health.evaluable) {
        this.log.error(
          {
            deploymentId: id, symbol: need.symbol, interval: need.interval,
            state: health.state, missingBars: health.missingBars,
          },
          `refusing to evaluate: ${health.detail}`
        );
        // Not an exception: this is an expected, recoverable condition. The
        // next bar close re-runs the backfill and re-checks.
        return;
      }

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

  /** The risk picture at this instant, read once per emission. */
  private async riskSnapshot(limits: { dailyLossWindowHours: number }): Promise<RiskSnapshot> {
    const deployments = [...this.active.values()].map((d) => ({
      position: (d.row.runtimeState.position ?? "flat") as "flat" | "long",
      buyQuoteQty: d.row.buyQuoteQty,
    }));
    const pnlRows = await liveSafety.listRealisedPnl(limits.dailyLossWindowHours);
    return {
      currentExposureQuote: intendedExposure(deployments),
      openPositions: countOpenPositions(deployments),
      realisedPnlInWindow: realisedPnlInWindow(pnlRows, limits.dailyLossWindowHours),
    };
  }

  private async fireAlert(
    dep: DeploymentRow,
    decision: MtfLeanDecision,
    nextState: { position: "flat" | "long" },
  ): Promise<boolean> {
    // Losing the lease mid-bar must stop emission immediately.
    if (!this.holdsLease) {
      this.log.error({ deploymentId: dep.id }, "not the emitter — signal not delivered");
      return false;
    }
    const barIndex = Math.floor(decision.barTime / INTERVAL_MS[dep.timeframe]);
    const ctx: SignalContext = {
      action: decision.action,
      price: decision.price,
      barTime: decision.barTime,
      barIndex,
      marketPosition: nextState.position,
      positionSize: nextState.position === "long" ? (dep.buyQuoteQty ?? 0) / decision.price : 0,
      prevMarketPosition: decision.action === "buy" ? "flat" : "long",
      prevPositionSize:
        decision.action === "buy"
          ? 0
          : sellContracts({
              buyQuoteQty: dep.buyQuoteQty,
              entryPrice: dep.runtimeState.entryPrice,
              exitPrice: decision.price,
            }),
      /*
       * BE-20: the base quantity to sell is what the ENTRY bought, reduced by
       * whatever the take-profit tiers have already taken — not the original
       * notional divided by the exit price, which is what the old dead ternary
       * computed for both branches.
       *
       * Only the 3Commas payload reads this. The custom path uses
       * `sell_percent` against the receiver's own tracked position, which is
       * the more robust design.
       */
      contracts:
        decision.action === "buy"
          ? sellContracts({
              buyQuoteQty: dep.buyQuoteQty,
              entryPrice: decision.price,
              exitPrice: decision.price,
            })
          : sellContracts({
              buyQuoteQty: dep.buyQuoteQty,
              entryPrice: dep.runtimeState.entryPrice,
              exitPrice: decision.price,
              alreadyExitedPct: exitedPctSoFar(dep),
            }),
      sellPercent: decision.sellPercent,
      exitLeg: decision.exitLeg,
    };
    const built = buildPayload(dep, ctx);

    /*
     * BE-11: the risk gate, immediately before anything is written or sent.
     *
     * Every limit is opt-in and off by default, so this is a no-op until an
     * operator configures one — but the kill switch is checked here and nowhere
     * else, which is what makes "halted" mean something.
     *
     * An EXIT is never refused by a numeric limit: refusing a sell because
     * exposure is too high would trap the position that caused the problem.
     * Only an explicit operator halt stops an exit.
     */
    const limits = await liveSafety.getRiskLimits();
    const snapshot = await this.riskSnapshot(limits);
    const risk = evaluateRisk(limits, snapshot, {
      action: decision.action,
      quoteQty: decision.action === "buy" ? (dep.buyQuoteQty ?? 0) : 0,
      alreadyLong: (dep.runtimeState.position ?? "flat") === "long",
    });
    if (!risk.allowed) {
      this.log.error(
        { deploymentId: dep.id, code: risk.code, state: describeRiskState(limits, snapshot) },
        `signal BLOCKED by risk controls: ${risk.reason}`
      );
      await alertRepo.createAlert({
        deploymentId: dep.id,
        barTime: decision.barTime,
        action: decision.action,
        marketPosition: ctx.marketPosition,
        positionSize: ctx.positionSize,
        triggerPrice: decision.price,
        reason: `${decision.reason} [blocked: ${risk.code}]`,
        payload: built.payload,
        dedupeKey: built.dedupeKey,
        deliveryStatus: "blocked",
      });
      const latch = shouldLatchHalt(risk);
      if (latch) {
        await liveSafety.setTradingHalted(true, { reason: risk.reason, by: latch });
        this.log.error({ by: latch }, "kill switch LATCHED by a risk limit breach");
      }
      // Never advance state on a blocked order: the receiver did not act.
      return false;
    }

    /*
     * BE-13 / BE-16: claim the intent BEFORE delivering.
     *
     * The old order was deliver-then-persist, so a process death between the
     * two left `runtime_state.position = 'flat'` while the bot was long, and
     * the next bar produced a different dedupe key — a second BUY, sent and
     * accepted. The old idempotency guard was also a read followed by a write,
     * a TOCTOU against the very unique index that exists to prevent it, and it
     * reported a skip to the caller as "accepted" — advancing runtime state
     * with no order placed.
     *
     * The database now decides. A claim that loses returns the EXISTING row, so
     * "already delivered" and "key exists but delivery failed" are different
     * answers instead of one boolean.
     */
    let intentId: number | null = null;
    if (built.dedupeKey) {
      const claim = await liveSafety.claimIntent({
        deploymentId: dep.id,
        dedupeKey: built.dedupeKey,
        action: decision.action,
        barTime: decision.barTime,
        exitLeg: decision.exitLeg ?? null,
        emitterId: config.emitterId,
      });
      if (!claim.claimed) {
        const prior = claim.existing;
        const advanceable = prior.state === "delivered" || prior.state === "duplicate";
        this.log.warn(
          { deploymentId: dep.id, dedupeKey: built.dedupeKey, priorState: prior.state },
          advanceable
            ? "this logical order was already delivered — skipping, state may advance"
            : "this logical order was already attempted and did NOT deliver — " +
              "skipping, state must NOT advance"
        );
        return advanceable;
      }
      intentId = claim.intent.id;
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
      // `off` and `paper` never contact anything, so their alert is terminal at
      // creation. Only a mode that actually POSTs starts as `pending`.
      deliveryStatus: deliversLiveOrders(dep.delivery) ? "pending" : "skipped",
    });
    this.log.info(
      { deploymentId: dep.id, action: decision.action, reason: decision.reason, price: decision.price },
      "signal fired"
    );

    if (intentId !== null) await liveSafety.linkIntentAlert(intentId, alert.id);

    if (dep.delivery === "off") {
      if (intentId !== null) {
        await liveSafety.resolveIntent(intentId, "delivered", "delivery is off; nothing was sent");
      }
      return true;
    }

    /*
     * PAPER. Simulate the fill and return — this branch is BEFORE the dispatcher
     * and there is no path from here to it.
     *
     * `engine/paperBroker.ts` is a pure function of the signal and the current
     * simulated position; it holds no credentials and imports nothing that can
     * place an order, which `tests/paperIsolation.test.ts` asserts over its
     * whole transitive import graph. The cost model is the live one, because a
     * paper run at zero fees flatters a configuration exactly where it matters
     * least (X-09).
     */
    if (dep.delivery === "paper") {
      const position = await paperRepo.currentPosition(dep.id);
      const outcome = applyPaperSignal(position, {
        action: decision.action,
        price: decision.price,
        barTime: decision.barTime,
        buyQuoteQty: dep.buyQuoteQty ?? 0,
        sellPercent: decision.sellPercent ?? null,
        reason: decision.reason,
      });
      if (outcome.filled) {
        await paperRepo.recordFill({
          deploymentId: dep.id, alertId: alert.id, fill: outcome.fill, reason: decision.reason,
        });
        this.log.info(
          {
            deploymentId: dep.id, action: decision.action, price: decision.price,
            qty: outcome.fill.qty, realisedPnl: outcome.fill.realisedPnl,
          },
          "PAPER fill simulated — nothing was sent"
        );
      } else {
        // A refusal is not a silent no-op: it means the platform's idea of the
        // position and the simulation's have diverged, which is one of the
        // things a paper run exists to surface.
        this.log.warn(
          { deploymentId: dep.id, action: decision.action, reason: outcome.reason },
          "PAPER signal not filled"
        );
      }
      if (intentId !== null) {
        await liveSafety.resolveIntent(
          intentId, "delivered",
          outcome.filled ? "paper fill simulated; nothing was sent" : `paper: ${outcome.reason}`
        );
      }
      // State advances either way: the live path advances on a delivered
      // signal, and a paper deployment must track the same state machine or it
      // is simulating a different strategy.
      return true;
    }

    // The 3Commas payload carries no idempotency key, so a client-side timeout
    // that actually succeeded would be duplicated by a retry (BE-12).
    const result = await deliver(built.url, built.payload, {
      idempotent: built.dedupeKey !== null,
    });
    await alertRepo.markDelivery(alert.id, result);

    const advances = deliveryAdvancesState(result);
    if (intentId !== null) {
      const intentState =
        result.outcome === "ignored_duplicate" ? "duplicate"
        : result.status === "sent" ? "delivered"
        : result.status === "blocked" ? "blocked"
        : result.status === "skipped" ? "duplicate"
        : result.httpStatus !== undefined && result.httpStatus >= 400 && result.httpStatus < 500
          ? "rejected"
          : "failed";
      await liveSafety.resolveIntent(
        intentId,
        intentState,
        `${result.status}${result.outcome ? ` (${result.outcome})` : ""} http=${result.httpStatus ?? "-"}`
      );
    }

    if (deliveryPlacedOrder(result)) {
      this.log.info(
        { deploymentId: dep.id, alertId: alert.id, http: result.httpStatus },
        "alert delivered — order placed"
      );
    } else if (advances) {
      this.log.warn(
        { deploymentId: dep.id, alertId: alert.id, outcome: result.outcome },
        "no order placed, but the receiver is already in the requested state"
      );
    } else {
      /*
       * X-12: this is the branch that used to be indistinguishable from
       * success. `ignored_stale_sell` arrives as HTTP 200, means NO order was
       * placed, and means the receiver is STILL LONG — so advancing to flat
       * here is precisely how the platform ends up issuing a fresh BUY into a
       * position it does not know it holds.
       */
      this.log.error(
        {
          deploymentId: dep.id, alertId: alert.id,
          status: result.status, outcome: result.outcome, http: result.httpStatus,
        },
        "signal did NOT result in an order — local state deliberately NOT advanced"
      );
    }
    return advances;
  }

  stop(): void {
    if (this.receiverSyncTimer) clearInterval(this.receiverSyncTimer);
    this.receiverSyncTimer = undefined;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    this.ws.close();
    this.active.clear();
    this.refCounts.clear();
    if (this.holdsLease) {
      // Release on a clean shutdown so a restart does not have to wait out the
      // TTL before it can emit again.
      this.holdsLease = false;
      void liveSafety.releaseEmitterLease(config.emitterId).catch(() => {
        /* a lapsed lease expires on its own; nothing to recover here */
      });
    }
  }

  private async renewLease(): Promise<void> {
    try {
      const held = await liveSafety.acquireEmitterLease(config.emitterId, LEASE_TTL_MS, {
        hostname: process.env.HOSTNAME,
        pid: process.pid,
      });
      if (held) return;
      // Losing the lease mid-flight means another process has taken over. Stop
      // emitting immediately rather than racing it.
      this.holdsLease = false;
      const lease = await liveSafety.getEmitterLease();
      this.log.error(
        { holder: lease?.holder },
        "LOST the emitter lease — this runner has stopped emitting"
      );
    } catch (err) {
      // A database blip must not silently un-arm the emitter, but it also must
      // not be treated as continued ownership past the TTL.
      this.log.error({ err: (err as Error).message }, "emitter lease renewal failed");
    }
  }

  /**
   * Intents left `pending` by a process that died between delivering an order
   * and persisting the resulting state.
   *
   * The outcome of each is UNKNOWN: the request may have reached the receiver
   * and placed an order, or it may not have. Re-firing is the one response that
   * must not happen (BE-13). They are marked `stale` and the operator is told,
   * loudly, which deployments need reconciling — the 30-second receiver sync
   * then adopts the receiver's actual state.
   */
  private async recoverUnresolvedIntents(): Promise<void> {
    const orphans = await liveSafety.listUnresolvedIntents();
    if (orphans.length === 0) return;
    for (const intent of orphans) {
      await liveSafety.resolveIntent(
        intent.id,
        "stale",
        `unresolved at startup of emitter ${config.emitterId}; outcome unknown, not retried`
      );
    }
    this.log.error(
      {
        count: orphans.length,
        deployments: [...new Set(orphans.map((o) => o.deploymentId))],
        keys: orphans.map((o) => o.dedupeKey),
      },
      "UNRESOLVED ORDER INTENTS found at startup. A previous process died " +
      "mid-delivery, so these orders may or may not exist at the exchange. " +
      "They will NOT be retried. Verify the receiver's positions before resuming."
    );
  }
}
