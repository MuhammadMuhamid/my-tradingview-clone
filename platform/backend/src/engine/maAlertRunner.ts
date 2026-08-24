/**
 * MA alert runner — the always-on half of the notification system.
 *
 *   enabled ma_alerts ─▶ subscribe every distinct (symbol, timeframe) stream
 *   barClose           ─▶ backfill any gap ─▶ compute the needed SMA/EMAs
 *                        ─▶ evaluate each alert on that feed
 *                        ─▶ Web Push to every registered device
 *
 * It runs in the backend process, independent of any open browser tab, which
 * is the whole point: the phone must buzz while the chart is closed.
 *
 * Evaluation is on CLOSED bars only. An intrabar "near the 15 SMA" reading
 * flickers in and out as price wobbles and would notify continuously; the
 * closed bar is a single, stable decision point per candle. The `cooldown_min`
 * window then suppresses repeats across consecutive bars of a slow approach.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";
import { type MaType } from "../types/maAlerts";
import type { MaAlertRow } from "../types/maAlerts";
import * as maAlertRepo from "../repositories/maAlerts";
import * as candleRepo from "../repositories/candles";
import { ensureCandles } from "../data/binanceRest";
import { BinanceWsManager, type BarCloseEvent } from "../data/binanceWs";
import { sma, ema } from "./ta";
import { evaluateMaAlert, cooldownElapsed, formatMaAlertPush, type Side } from "../alerts/maEvaluator";
import { sendPush } from "../alerts/webPush";

/** Bars of history pulled per evaluation: enough to seed the longest MA. */
const HISTORY_BARS = 1200;
/** How often the runner re-reads the alert table to pick up UI edits. */
const REFRESH_MS = 30_000;

const feedKey = (symbol: string, interval: Interval): string => `${symbol}|${interval}`;

export class MaAlertRunner {
  private ws = new BinanceWsManager();
  private feeds = new Set<string>();
  private processing = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.log = log;
    this.ws.on("barClose", (e) => void this.onBarClose(e));
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
    }
  }

  private async onBarClose(e: BarCloseEvent): Promise<void> {
    const key = feedKey(e.symbol, e.interval);
    // A slow evaluation must not overlap the next bar on the same feed, or the
    // same alert could be read and written twice with stale cross state.
    if (this.processing.has(key)) return;
    this.processing.add(key);
    try {
      await this.evaluateFeed(e.symbol, e.interval, e.candle);
    } catch (err) {
      this.log.error({ key, err: (err as Error).message }, "ma alert evaluation failed");
    } finally {
      this.processing.delete(key);
    }
  }

  private async evaluateFeed(symbol: string, interval: Interval, closed: Candle): Promise<void> {
    const alerts = (await maAlertRepo.listAlerts({ symbol, timeframe: interval, enabledOnly: true }));
    if (alerts.length === 0) return;

    const bars = await this.loadHistory(symbol, interval, closed);
    const closes = bars.map((b) => b.close);
    const last = bars[bars.length - 1]!;

    // One series per distinct (type, length) across this feed's alerts — the
    // 15 SMA shared by a touch alert and a near alert is computed once.
    const cache = new Map<string, number[]>();
    const seriesFor = (type: MaType, length: number): number[] => {
      const k = `${type}${length}`;
      let s = cache.get(k);
      if (!s) { s = type === "sma" ? sma(closes, length) : ema(closes, length); cache.set(k, s); }
      return s;
    };

    for (const alert of alerts) {
      const value = seriesFor(alert.maType, alert.maLength)[closes.length - 1];
      // Not enough history to seed this MA yet — leave the alert untouched so
      // its cross state is not corrupted by a NaN comparison.
      if (value === undefined || !Number.isFinite(value)) continue;

      const result = evaluateMaAlert(alert, last, value, alert.lastSide as Side | null);
      const fire = result.triggered && cooldownElapsed(alert.lastFiredAt, alert.cooldownMin);

      if (fire) {
        await this.fire(alert, last, value, result.distancePct);
      }
      await maAlertRepo.recordEvaluation(alert.id, result.side, fire);
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
      this.log.warn({ symbol, interval, err: (err as Error).message }, "ma alert backfill failed");
    }
    const bars = await candleRepo.getCandles(symbol, interval, { limit: HISTORY_BARS });
    const lastStored = bars[bars.length - 1];
    if (!lastStored || lastStored.openTime < closed.openTime) bars.push(closed);
    else if (lastStored.openTime === closed.openTime) bars[bars.length - 1] = closed;
    return bars;
  }

  private async fire(
    alert: MaAlertRow, bar: Candle, maValue: number, distancePct: number
  ): Promise<void> {
    const { title, body, tag, url } = formatMaAlertPush(alert, bar, maValue, distancePct);

    let pushedTo = 0;
    try {
      const res = await sendPush({ title, body, tag, url }, this.log);
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
    this.log.info({ alertId: alert.id, symbol: alert.symbol, mode: alert.mode, pushedTo }, "ma alert fired");
  }
}
