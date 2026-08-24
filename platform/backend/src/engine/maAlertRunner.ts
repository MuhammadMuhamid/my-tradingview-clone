/**
 * MA alert runner — the always-on half of the notification system.
 *
 *   enabled ma_alerts ─▶ subscribe every distinct (symbol, timeframe) stream
 *   barClose           ─▶ backfill any gap ─▶ recompute the MA baselines
 *                        ─▶ evaluate the `once_per_bar_close` alerts
 *   barUpdate (tick)   ─▶ roll each MA forward one provisional bar in O(1)
 *                        ─▶ evaluate the `once` / `once_per_bar` alerts
 *   fire               ─▶ Web Push to every registered device
 *
 * It runs in the backend process, independent of any open browser tab, which
 * is the whole point: the phone must buzz while the chart is closed.
 *
 * ── why the baselines exist ──
 * A forming candle ticks several times a second. Recomputing a 200-period MA
 * over 1200 bars on every tick, across 39 feeds, would burn CPU for no reason.
 * Instead each closed bar leaves behind two numbers per MA — the closed value,
 * and (for SMA) the sum of the closes still inside the window — from which the
 * provisional value of the forming bar is one arithmetic step:
 *
 *   SMA = (sum of the last len-1 closed closes + forming close) / len
 *   EMA = alpha x forming close + (1 - alpha) x last closed EMA
 *
 * Both are exact, not approximations: they are the definitions, evaluated with
 * the forming bar as the newest sample.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";
import { isIntrabar, maLabel, describeMode, type MaType } from "../types/maAlerts";
import type { MaAlertRow } from "../types/maAlerts";
import * as maAlertRepo from "../repositories/maAlerts";
import * as candleRepo from "../repositories/candles";
import { ensureCandles } from "../data/binanceRest";
import { BinanceWsManager, type BarCloseEvent } from "../data/binanceWs";
import { sma, ema } from "./ta";
import {
  cooldownElapsed, evaluateMaAlert, provisionalEma, provisionalSma, type Side,
} from "../alerts/maEvaluator";
import { sendPush } from "../alerts/webPush";

/** Bars of history pulled per rebuild: enough to seed the longest MA. */
const HISTORY_BARS = 1200;
/** How often the runner re-reads the alert table to pick up UI edits. */
const REFRESH_MS = 30_000;
/**
 * Floor on intrabar work per feed. Binance sends roughly a tick a second per
 * stream; anything faster than this adds latency no human perceives while
 * multiplying database writes on a fire.
 */
const INTRABAR_THROTTLE_MS = 1_000;

const feedKey = (symbol: string, interval: Interval): string => `${symbol}|${interval}`;
const maKey = (type: MaType, length: number): string => `${type}${length}`;

/** Everything needed to advance this feed's MAs by one provisional bar. */
interface FeedState {
  /** Value of each MA at the most recent CLOSED bar. */
  closedMa: Map<string, number>;
  /** SMA only: sum of the closes that stay in the window (the last len-1). */
  smaTailSum: Map<string, number>;
  /** Open time of the most recent closed bar, to detect a stale baseline. */
  closedOpenTime: number;
  lastIntrabarAt: number;
}

export class MaAlertRunner {
  private ws = new BinanceWsManager();
  private feeds = new Set<string>();
  private state = new Map<string, FeedState>();
  private processing = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
    this.ws.on("barClose", (e) => void this.onBarClose(e));
    this.ws.on("barUpdate", (e) => void this.onBarUpdate(e));
    this.ws.on("error", (err) => this.log.error({ err: err.message }, "ma alert ws error"));
  }

  async start(): Promise<void> {
    await this.syncFeeds();
    this.refreshTimer = setInterval(() => void this.syncFeeds(), REFRESH_MS);
    this.log.info({ feeds: this.feeds.size }, "ma alert runner started");
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const key of this.feeds) {
      const [symbol, interval] = key.split("|") as [string, Interval];
      this.ws.unsubscribe(symbol, interval);
    }
    this.feeds.clear();
    this.state.clear();
    this.ws.close();
  }

  /**
   * Reconcile live subscriptions with the enabled alerts. Called on a timer so
   * an alert armed in the UI starts being watched without a server restart.
   */
  async syncFeeds(): Promise<void> {
    let alerts: MaAlertRow[];
    try {
      alerts = await maAlertRepo.listAlerts({ enabledOnly: true });
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "ma alert feed sync failed");
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
        this.log.error({ key, err: (err as Error).message }, "ma alert subscribe failed");
      }
    }
    for (const key of [...this.feeds]) {
      if (wanted.has(key)) continue;
      const [symbol, interval] = key.split("|") as [string, Interval];
      this.ws.unsubscribe(symbol, interval);
      this.feeds.delete(key);
      this.state.delete(key);
    }
  }

  // ── closed bars ────────────────────────────────────────────────────────────

  private async onBarClose(e: BarCloseEvent): Promise<void> {
    const key = feedKey(e.symbol, e.interval);
    // A slow evaluation must not overlap the next bar on the same feed, or the
    // same alert could be read and written twice with stale cross state.
    if (this.processing.has(key)) return;
    this.processing.add(key);
    try {
      const alerts = await maAlertRepo.listAlerts({
        symbol: e.symbol, timeframe: e.interval, enabledOnly: true,
      });
      if (alerts.length === 0) return;

      const bars = await this.loadHistory(e.symbol, e.interval, e.candle);
      const values = this.rebuildBaseline(key, bars, alerts);

      for (const alert of alerts) {
        const value = values.get(maKey(alert.maType, alert.maLength));
        if (value === undefined || !Number.isFinite(value)) continue;

        const result = evaluateMaAlert(alert, e.candle, value, alert.lastSide as Side | null);
        // Only the bar-close trigger fires here; the intrabar modes have
        // already had their chance on the ticks that made up this candle.
        const fire =
          alert.trigger === "once_per_bar_close" &&
          result.triggered &&
          cooldownElapsed(alert.lastFiredAt, alert.cooldownMin);

        if (fire) await this.fire(alert, e.candle, value, result.distancePct);

        // The side is a property of a CLOSED bar, so it is recorded only here.
        // Intrabar cross checks compare against this last confirmed side.
        await maAlertRepo.recordEvaluation(alert.id, {
          side: result.side,
          fired: fire,
          barTime: fire ? e.candle.openTime : null,
          disable: fire && alert.trigger === "once",
        });
      }
    } catch (err) {
      this.log.error({ key, err: (err as Error).message }, "ma alert evaluation failed");
    } finally {
      this.processing.delete(key);
    }
  }

  // ── forming bars ───────────────────────────────────────────────────────────

  private async onBarUpdate(e: BarCloseEvent): Promise<void> {
    const key = feedKey(e.symbol, e.interval);
    if (!this.feeds.has(key) || this.processing.has(key)) return;

    const st = this.state.get(key);
    // No baseline yet (first tick after boot): the next bar close builds it.
    if (!st) return;
    const now = Date.now();
    if (now - st.lastIntrabarAt < INTRABAR_THROTTLE_MS) return;
    st.lastIntrabarAt = now;

    this.processing.add(key);
    try {
      const alerts = (await maAlertRepo.listAlerts({
        symbol: e.symbol, timeframe: e.interval, enabledOnly: true,
      })).filter((a) => isIntrabar(a.trigger));
      if (alerts.length === 0) return;

      // A baseline built from an older bar would roll the MA forward from the
      // wrong anchor. Wait for the close that refreshes it.
      if (st.closedOpenTime + INTERVAL_MS[e.interval] !== e.candle.openTime) return;

      for (const alert of alerts) {
        const value = this.provisionalMa(st, alert.maType, alert.maLength, e.candle.close);
        if (value === null) continue;

        const result = evaluateMaAlert(alert, e.candle, value, alert.lastSide as Side | null);
        if (!result.triggered) continue;
        if (!cooldownElapsed(alert.lastFiredAt, alert.cooldownMin)) continue;
        // "Once per bar": stay silent for the rest of a candle already announced.
        if (
          alert.trigger === "once_per_bar" &&
          alert.lastFiredBarTime !== null &&
          Date.parse(alert.lastFiredBarTime) === e.candle.openTime
        ) continue;

        await this.fire(alert, e.candle, value, result.distancePct, true);
        await maAlertRepo.recordEvaluation(alert.id, {
          fired: true,
          barTime: e.candle.openTime,
          disable: alert.trigger === "once",
        });
      }
    } catch (err) {
      this.log.error({ key, err: (err as Error).message }, "ma alert intrabar evaluation failed");
    } finally {
      this.processing.delete(key);
    }
  }

  /**
   * The MA including the forming bar, in constant time. Returns null when this
   * feed has no baseline for that MA yet (not enough history).
   */
  private provisionalMa(
    st: FeedState, type: MaType, length: number, formingClose: number
  ): number | null {
    const k = maKey(type, length);
    if (type === "sma") {
      const tail = st.smaTailSum.get(k);
      return tail === undefined ? null : provisionalSma(tail, formingClose, length);
    }
    const prev = st.closedMa.get(k);
    return prev === undefined ? null : provisionalEma(prev, formingClose, length);
  }

  /** Recompute every MA this feed needs, and cache what the ticks will need. */
  private rebuildBaseline(
    key: string, bars: Candle[], alerts: MaAlertRow[]
  ): Map<string, number> {
    const closes = bars.map((b) => b.close);
    const last = bars[bars.length - 1]!;
    const closedMa = new Map<string, number>();
    const smaTailSum = new Map<string, number>();
    const values = new Map<string, number>();

    // One series per distinct (type, length) across this feed's alerts — the
    // 15 SMA shared by a touch alert and a near alert is computed once.
    const seen = new Set<string>();
    for (const a of alerts) {
      const k = maKey(a.maType, a.maLength);
      if (seen.has(k)) continue;
      seen.add(k);

      const series = a.maType === "sma" ? sma(closes, a.maLength) : ema(closes, a.maLength);
      const value = series[closes.length - 1];
      if (value === undefined || !Number.isFinite(value)) continue;
      values.set(k, value);
      closedMa.set(k, value);

      if (a.maType === "sma") {
        // The closes that remain in the window once the forming bar joins it.
        const tail = closes.slice(closes.length - (a.maLength - 1));
        if (tail.length === a.maLength - 1) {
          smaTailSum.set(k, tail.reduce((x, y) => x + y, 0));
        }
      }
    }

    this.state.set(key, {
      closedMa, smaTailSum, closedOpenTime: last.openTime, lastIntrabarAt: 0,
    });
    return values;
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
      this.log.warn({ symbol, interval, err: (err as Error).message }, "ma alert backfill failed");
    }
    const bars = await candleRepo.getCandles(symbol, interval, { limit: HISTORY_BARS });
    const lastStored = bars[bars.length - 1];
    if (!lastStored || lastStored.openTime < closed.openTime) bars.push(closed);
    else if (lastStored.openTime === closed.openTime) bars[bars.length - 1] = closed;
    return bars;
  }

  private async fire(
    alert: MaAlertRow, bar: Candle, maValue: number, distancePct: number, intrabar = false
  ): Promise<void> {
    const line = maLabel(alert.maType, alert.maLength);
    const title = `${alert.symbol} ${alert.timeframe} — ${line}`;
    const body =
      `Price ${describeMode(alert)} the ${line} ` +
      `(${intrabar ? "now" : "close"} ${fmt(bar.close)}, ${line} ${fmt(maValue)}, ` +
      `${distancePct >= 0 ? "+" : ""}${distancePct.toFixed(2)}%)`;

    let pushedTo = 0;
    try {
      const res = await sendPush(
        { title, body, tag: `ma-${alert.id}`, url: `/chart?symbol=${alert.symbol}&interval=${alert.timeframe}` },
        this.log
      );
      pushedTo = res.sent;
    } catch (err) {
      this.log.error({ alertId: alert.id, err: (err as Error).message }, "ma alert push failed");
    }

    // The event row is written whether or not a device was reachable, so the
    // in-app feed still shows what fired when the phone was offline.
    await maAlertRepo.createEvent({
      alertId: alert.id,
      barTime: bar.openTime,
      price: bar.close,
      maValue,
      distancePct,
      title,
      body,
      pushedTo,
    });
    this.log.info(
      { alertId: alert.id, symbol: alert.symbol, mode: alert.mode, trigger: alert.trigger, intrabar, pushedTo },
      "ma alert fired"
    );
  }
}

/** Price formatting that keeps sub-cent alt pairs readable. */
function fmt(n: number): string {
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return n.toFixed(d).replace(/\.?0+$/, "");
}
