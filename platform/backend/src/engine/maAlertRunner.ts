/**
 * Alert runner — the always-on half of the notification system.
 *
 *   active alerts ─▶ subscribe every distinct (symbol, timeframe) stream
 *   barClose      ─▶ backfill any gap ─▶ compute the needed SMA/EMAs
 *                   ─▶ evaluate every alert on that feed
 *                   ─▶ Web Push to every registered device
 *   barUpdate     ─▶ same evaluation against the FORMING candle, but only for
 *                   the alerts whose frequency asked for it
 *
 * It runs in the backend process, independent of any open browser tab, which is
 * the whole point: the phone must buzz while the chart is closed.
 *
 * ── What this runner does not do ───────────────────────────────────────────
 *
 * It notifies. It has no path to a deployment, a webhook, an order or an
 * exchange, and `tests/alertIsolation.test.ts` fails the build if one is ever
 * introduced. Alerts and automated trading are two different promises to the
 * user, and an alert that could place an order would be the worst possible way
 * to discover they had been merged.
 *
 * ── Bar close versus intrabar ──────────────────────────────────────────────
 *
 * The decision logic lives in `alerts/alertPlan.ts` and is pure. This file is
 * the IO shell: subscriptions, history, push delivery, persistence. The one
 * rule it enforces structurally is that a `once_per_bar_close` alert is never
 * shown a forming candle — see `shouldEvaluate`.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";
import type { MaAlertRow, MaType } from "../types/maAlerts";
import * as maAlertRepo from "../repositories/maAlerts";
import * as candleRepo from "../repositories/candles";
import { ensureCandles } from "../data/binanceRest";
import { BinanceWsManager, type BarCloseEvent, type BarUpdateEvent } from "../data/binanceWs";
import { sma, ema } from "./ta";
import { conditionFromRow, type AlertCondition, type Side } from "../alerts/alertConditions";
import { acceptsIntrabarSample } from "../alerts/alertFrequency";
import {
  planAlert, stateAfterPlan, type AlertSpec, type FeedSample,
} from "../alerts/alertPlan";
import { formatAlertPush } from "../alerts/alertMessage";
import { sendPush } from "../alerts/webPush";

/** Bars of history pulled per evaluation: enough to seed the longest MA. */
const HISTORY_BARS = 1200;
/** How often the runner re-reads the alert table to pick up UI edits. */
const REFRESH_MS = 30_000;
/**
 * Floor between two intrabar evaluations of the same feed.
 *
 * Binance sends a kline update roughly every second. Evaluating every one of
 * them would recompute the moving averages of a 1 200-bar window per second per
 * feed for no benefit: the fastest frequency mode caps at one notification a
 * minute, and `once_per_bar` at one a candle. Two seconds is far below either
 * cap and far above the cost.
 */
const INTRABAR_MIN_MS = 2_000;

const feedKey = (symbol: string, interval: Interval): string => `${symbol}|${interval}`;

/** One alert, resolved into the pure planner's view of it. */
function toSpec(alert: MaAlertRow, condition: AlertCondition): AlertSpec {
  return {
    id: alert.id,
    symbol: alert.symbol,
    timeframe: alert.timeframe,
    enabled: alert.enabled && alert.completedAt === null,
    condition,
    frequency: alert.frequency,
    lastSide: alert.lastSide as Side | null,
    fireState: {
      lastFiredAt: alert.lastFiredAt === null ? null : Date.parse(alert.lastFiredAt),
      lastFiredBarTime: alert.lastFiredBarTime === null ? null : Date.parse(alert.lastFiredBarTime),
      completed: alert.completedAt !== null,
      cooldownMin: alert.cooldownMin,
    },
    lastBarTime: alert.lastBarTime === null ? null : Date.parse(alert.lastBarTime),
  };
}

export class MaAlertRunner {
  private ws = new BinanceWsManager();
  private feeds = new Set<string>();
  private processing = new Set<string>();
  /**
   * Closed-bar history per feed, so an intrabar evaluation costs a moving
   * average over an array already in memory rather than a database read.
   * Refreshed on every bar close, which is also the only time it can change.
   */
  private history = new Map<string, Candle[]>();
  private lastIntrabarAt = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
    this.ws.on("barClose", (e) => void this.onBarClose(e));
    this.ws.on("barUpdate", (e) => void this.onBarUpdate(e));
    this.ws.on("error", (err) => this.log.error({ err: err.message }, "alert ws error"));
  }

  async start(): Promise<void> {
    await this.syncFeeds();
    this.refreshTimer = setInterval(() => void this.syncFeeds(), REFRESH_MS);
    this.log.info({ feeds: this.feeds.size }, "alert runner started");
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const key of this.feeds) {
      const [symbol, interval] = key.split("|") as [string, Interval];
      this.ws.unsubscribe(symbol, interval);
    }
    this.feeds.clear();
    this.history.clear();
    this.lastIntrabarAt.clear();
    this.ws.close();
  }

  /**
   * Reconcile live subscriptions with the active alerts. Called on a timer so
   * an alert armed in the UI starts being watched without a server restart.
   */
  async syncFeeds(): Promise<void> {
    let alerts: MaAlertRow[];
    try {
      alerts = await maAlertRepo.listAlerts({ activeOnly: true });
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "alert feed sync failed");
      return;
    }
    const wanted = new Set(alerts.map((a) => feedKey(a.symbol, a.timeframe)));

    for (const key of wanted) {
      if (this.feeds.has(key)) continue;
      const [symbol, interval] = key.split("|") as [string, Interval];
      try {
        this.ws.subscribe(symbol, interval);
        this.feeds.add(key);
      } catch (err) {
        this.log.error({ key, err: (err as Error).message }, "alert subscribe failed");
      }
    }
    for (const key of [...this.feeds]) {
      if (wanted.has(key)) continue;
      const [symbol, interval] = key.split("|") as [string, Interval];
      this.ws.unsubscribe(symbol, interval);
      this.feeds.delete(key);
      this.history.delete(key);
      this.lastIntrabarAt.delete(key);
    }
  }

  private async onBarClose(e: BarCloseEvent): Promise<void> {
    const key = feedKey(e.symbol, e.interval);
    // A slow evaluation must not overlap the next bar on the same feed, or the
    // same alert could be read and written twice with stale cross state.
    if (this.processing.has(key)) return;
    this.processing.add(key);
    try {
      const bars = await this.loadHistory(e.symbol, e.interval, e.candle);
      this.history.set(key, bars);
      await this.evaluate(e.symbol, e.interval, bars, e.candle, true);
    } catch (err) {
      this.log.error({ key, err: (err as Error).message }, "alert evaluation failed");
    } finally {
      this.processing.delete(key);
    }
  }

  /**
   * A forming candle. Cheap by construction: it reuses the cached closed-bar
   * history and never touches the database or the REST API, so the per-second
   * websocket cadence costs an array copy and a few moving averages.
   */
  private async onBarUpdate(e: BarUpdateEvent): Promise<void> {
    const key = feedKey(e.symbol, e.interval);
    if (this.processing.has(key)) return;

    const now = Date.now();
    const last = this.lastIntrabarAt.get(key) ?? 0;
    if (now - last < INTRABAR_MIN_MS) return;

    // Only closed bars are cached, and they are cached by the bar-close path.
    // Until the first close arrives there is no history to compute an MA over,
    // so intrabar evaluation simply has not started yet for this feed.
    const closedBars = this.history.get(key);
    if (!closedBars || closedBars.length === 0) return;

    this.processing.add(key);
    this.lastIntrabarAt.set(key, now);
    try {
      // The forming bar replaces its own slot if the cache already holds it —
      // it never accumulates a growing tail of provisional candles.
      const bars = [...closedBars];
      const tail = bars[bars.length - 1]!;
      if (tail.openTime === e.candle.openTime) bars[bars.length - 1] = e.candle;
      else if (e.candle.openTime > tail.openTime) bars.push(e.candle);
      else return; // a frame for an older bar than the cache: ignore it

      await this.evaluate(e.symbol, e.interval, bars, e.candle, false);
    } catch (err) {
      this.log.error({ key, err: (err as Error).message }, "intrabar alert evaluation failed");
    } finally {
      this.processing.delete(key);
    }
  }

  /**
   * Evaluate every alert on one feed against one sample.
   *
   * `isClosedBar` is passed through rather than inferred, because it is the
   * single fact that separates the two cadences and inferring it from, say, a
   * timestamp comparison would be a guess in the place a guess is least
   * affordable.
   */
  private async evaluate(
    symbol: string, interval: Interval, bars: Candle[], sampleBar: Candle, isClosedBar: boolean
  ): Promise<void> {
    const alerts = await maAlertRepo.listAlerts({
      symbol, timeframe: interval, activeOnly: true,
    });
    const relevant = isClosedBar
      ? alerts
      : alerts.filter((a) => acceptsIntrabarSample(a.frequency));
    if (relevant.length === 0) return;

    const closes = bars.map((b) => b.close);

    // One series per distinct (type, length) across this feed's alerts — the
    // 15 SMA shared by a touch alert and a near alert is computed once.
    const cache = new Map<string, number[]>();
    const seriesFor = (type: MaType, length: number): number | undefined => {
      const k = `${type}${length}`;
      let s = cache.get(k);
      if (!s) { s = type === "sma" ? sma(closes, length) : ema(closes, length); cache.set(k, s); }
      const v = s[closes.length - 1];
      return v === undefined || !Number.isFinite(v) ? undefined : v;
    };

    const sample: FeedSample = {
      symbol, timeframe: interval,
      barTime: sampleBar.openTime,
      isClosedBar,
      high: sampleBar.high,
      low: sampleBar.low,
      close: sampleBar.close,
      series: seriesFor,
    };
    const now = Date.now();

    for (const alert of relevant) {
      const condition = conditionFromRow(alert);
      if (!condition) {
        this.log.warn({ alertId: alert.id, kind: alert.conditionKind }, "alert row is not evaluable");
        continue;
      }
      const spec = toSpec(alert, condition);
      const plan = planAlert(spec, sample, now);
      if (!plan.act) continue;

      let delivered = false;
      if (plan.fire) {
        delivered = await this.fire(alert, condition, sampleBar, plan.reference, plan.distancePct, !isClosedBar);
      }
      const next = stateAfterPlan(spec, plan, {
        barTime: sampleBar.openTime, now, delivered,
      });
      await maAlertRepo.recordEvaluation({
        id: alert.id,
        side: next.lastSide,
        barTime: next.lastBarTime,
        fired: plan.fire,
        complete: next.fireState.completed && !spec.fireState.completed,
      });
    }
  }

  /**
   * Bars for the MA computation. The websocket bar is appended explicitly
   * because the DB copy of the just-closed candle may not have landed yet.
   */
  private async loadHistory(symbol: string, interval: Interval, closed: Candle): Promise<Candle[]> {
    const span = INTERVAL_MS[interval] * HISTORY_BARS;
    const endMs = closed.openTime + INTERVAL_MS[interval];
    try {
      await ensureCandles(symbol, interval, endMs - span, endMs);
    } catch (err) {
      this.log.warn({ symbol, interval, err: (err as Error).message }, "alert backfill failed");
    }
    const bars = await candleRepo.getCandles(symbol, interval, { limit: HISTORY_BARS });
    const lastStored = bars[bars.length - 1];
    if (!lastStored || lastStored.openTime < closed.openTime) bars.push(closed);
    else if (lastStored.openTime === closed.openTime) bars[bars.length - 1] = closed;
    return bars;
  }

  /** Deliver one notification. Returns whether it reached at least one device. */
  private async fire(
    alert: MaAlertRow, condition: AlertCondition, bar: Candle,
    reference: number, distancePct: number, intrabar: boolean
  ): Promise<boolean> {
    const { title, body, tag, url } = formatAlertPush(
      alert, condition, bar, reference, distancePct, intrabar
    );

    let pushedTo = 0;
    try {
      const res = await sendPush({ title, body, tag, url }, this.log);
      pushedTo = res.sent;
    } catch (err) {
      this.log.error({ alertId: alert.id, err: (err as Error).message }, "alert push failed");
    }

    // The event row is written whether or not a device was reachable, so the
    // in-app feed still shows what fired when the phone was offline.
    await maAlertRepo.createEvent({
      alertId: alert.id,
      barTime: bar.openTime,
      price: bar.close,
      maValue: reference,
      distancePct,
      title,
      body,
      pushedTo,
      intrabar,
      frequency: alert.frequency,
    });
    this.log.info(
      { alertId: alert.id, symbol: alert.symbol, kind: alert.conditionKind, intrabar, pushedTo },
      "alert fired"
    );
    return pushedTo > 0;
  }
}
