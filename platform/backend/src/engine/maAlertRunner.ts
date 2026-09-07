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
import { INTERVAL_MS, isInterval } from "../types/market";
import { ALERT_HISTORY_BARS, PIVOT_LEVEL_ANY } from "../types/maAlerts";
import type {
  MaAlertRow, MaType, SrSide, RsiTarget, MacdTarget, StAtrMethod, BollingerBand, StochasticTarget,
} from "../types/maAlerts";
import * as maAlertRepo from "../repositories/maAlerts";
import * as candleRepo from "../repositories/candles";
import { ensureCandles } from "../data/binanceRest";
import { BinanceWsManager, type BarCloseEvent, type BarUpdateEvent } from "../data/binanceWs";
import { adx, bollinger, ema, macd, rsi, sma, stochastic, supertrend } from "./ta";
import { buildZones, nearestZones, DEFAULT_SR_OPTIONS } from "./srZones";
import {
  levelByName, nearestLevel, pivotLevels, type PivotType, type Period,
} from "./pivotLevels";
import {
  conditionFromRow,
  type AlertCondition, type AlertFilter, type Side,
} from "../alerts/alertConditions";
import { acceptsIntrabarSample } from "../alerts/alertFrequency";
import {
  planAlert, stateAfterPlan, type AlertSpec, type FeedSample,
} from "../alerts/alertPlan";
import { gateReading } from "../alerts/filterSeries";
import { formatAlertPush } from "../alerts/alertMessage";
import { sendPush, type PushResult } from "../alerts/webPush";

/**
 * Bars of history pulled per evaluation: enough to seed the longest MA.
 *
 * The number lives in `types/maAlerts.ts` because the request validator has to
 * refuse any length combination that would not warm up inside it.
 */
const HISTORY_BARS = ALERT_HISTORY_BARS;
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

export interface MaAlertRunnerDependencies {
  listAlerts: typeof maAlertRepo.listAlerts;
  recordEvaluation: typeof maAlertRepo.recordEvaluation;
  createEvent: typeof maAlertRepo.createEvent;
  sendPush: typeof sendPush;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: MaAlertRunnerDependencies = {
  listAlerts: maAlertRepo.listAlerts,
  recordEvaluation: maAlertRepo.recordEvaluation,
  createEvent: maAlertRepo.createEvent,
  sendPush,
  now: Date.now,
};

/** A deterministic local frame that enters the same evaluator as live bars. */
export interface AlertReplayFrame {
  symbol: string;
  interval: Interval;
  bars: Candle[];
  sampleBar: Candle;
  isClosedBar: boolean;
  now?: number;
  /** Completed pivot-anchor periods keyed by interval, e.g. `{ "1d": ... }`. */
  anchorPeriods?: Partial<Record<Interval, Period>>;
}

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
  /**
   * The last COMPLETED period per `symbol|anchor`, for pivot alerts.
   *
   * Held separately from the alert feeds because the anchor is not the
   * evaluation cadence: daily pivots watched on a 5m chart need daily bars that
   * no 5m feed carries. Refreshed on the same timer as the alert list, which is
   * far more often than a daily period can change.
   */
  private anchorPeriods = new Map<string, Period>();
  private log: FastifyBaseLogger;
  private dependencies: MaAlertRunnerDependencies;

  constructor(log: FastifyBaseLogger, dependencies: Partial<MaAlertRunnerDependencies> = {}) {
    this.log = log;
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
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
      alerts = await this.dependencies.listAlerts({ activeOnly: true });
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "alert feed sync failed");
      return;
    }
    const wanted = new Set(alerts.map((a) => feedKey(a.symbol, a.timeframe)));
    await this.refreshAnchorPeriods(alerts);

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

  /**
   * Load the last COMPLETED period for every anchor a pivot alert names.
   *
   * "Completed" is the point: a pivot level derived from the period still
   * forming would move under the alert during the day, and would be a level the
   * chart never drew. The newest bar of the anchor feed is dropped for exactly
   * that reason.
   */
  private async refreshAnchorPeriods(alerts: MaAlertRow[]): Promise<void> {
    const wanted = new Set<string>();
    for (const a of alerts) {
      if (a.conditionKind !== "pivot_level" || !a.pivotAnchor) continue;
      wanted.add(`${a.symbol}|${a.pivotAnchor}`);
    }
    for (const key of [...this.anchorPeriods.keys()]) {
      if (!wanted.has(key)) this.anchorPeriods.delete(key);
    }

    for (const key of wanted) {
      const [symbol, rawAnchor] = key.split("|") as [string, string];
      if (!isInterval(rawAnchor)) {
        this.log.warn({ symbol, anchor: rawAnchor }, "pivot anchor is not a supported interval");
        continue;
      }
      const anchor = rawAnchor;
      try {
        const endMs = Date.now();
        const startMs = endMs - INTERVAL_MS[anchor] * 5;
        await ensureCandles(symbol, anchor, startMs, endMs);
        const rows = await candleRepo.getCandles(symbol, anchor, { limit: 3 });
        // The last row is the period currently forming; the one before it is
        // the most recent completed period.
        const completed = rows.length >= 2 ? rows[rows.length - 2] : undefined;
        if (!completed) continue;
        this.anchorPeriods.set(key, {
          open: completed.open, high: completed.high,
          low: completed.low, close: completed.close,
        });
      } catch (err) {
        this.log.warn(
          { symbol, anchor, err: (err as Error).message },
          "pivot anchor period unavailable"
        );
      }
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
   * Replay a synthetic/local bar through real runner orchestration.
   *
   * No websocket, REST backfill, database, or Web Push service is contacted
   * when repository and transport fakes are supplied to the constructor. The
   * condition resolution, frequency transition, event/persistence writes, and
   * payload formatting remain the production implementations.
   */
  async replay(frame: AlertReplayFrame): Promise<void> {
    for (const [anchor, period] of Object.entries(frame.anchorPeriods ?? {})) {
      if (period) this.anchorPeriods.set(`${frame.symbol}|${anchor}`, period);
    }
    await this.evaluate(
      frame.symbol, frame.interval, frame.bars, frame.sampleBar,
      frame.isClosedBar, frame.now
    );
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
    symbol: string, interval: Interval, bars: Candle[], sampleBar: Candle,
    isClosedBar: boolean, replayNow?: number
  ): Promise<void> {
    const alerts = await this.dependencies.listAlerts({
      symbol, timeframe: interval, activeOnly: true,
    });
    const relevant = isClosedBar
      ? alerts
      : alerts.filter((a) => acceptsIntrabarSample(a.frequency));
    if (relevant.length === 0) return;

    /*
     * Gates naming another timeframe need that timeframe's bars, and fetching
     * them is asynchronous, so it happens here — once for the whole feed,
     * before the per-alert loop — rather than inside a resolver the evaluator
     * calls synchronously.
     *
     * Collecting the distinct set first matters: twelve alerts each gated on
     * the 1h RSI are one fetch, not twelve.
     */
    const gateBars = await this.loadFilterTimeframes(symbol, interval, relevant);

    const closes = bars.map((b) => b.close);
    // Supertrend needs the full range, not just closes: its bands are built
    // from true range, which is a high/low/close quantity.
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    // Only a VWMA-based Bollinger basis reads volume, but building the array
    // once is cheaper than deciding whether to.
    const volumes = bars.map((b) => b.volume);

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

    /**
     * Support/resistance zones for this feed.
     *
     * Cached per (pivotLength, invalidation) because the detection is a scan of
     * the whole history, and several alerts on one symbol normally share the
     * same settings. `zonesAsOf` then answers each alert from the same scan.
     */
    const srCache = new Map<string, ReturnType<typeof buildZones>>();
    const srFor = (
      side: SrSide, pivotLength: number, invalidation: "close" | "wick"
    ): { price: number; label: string } | undefined => {
      const key = `${pivotLength}|${invalidation}`;
      let zones = srCache.get(key);
      if (!zones) {
        zones = buildZones(
          { high: bars.map((b) => b.high), low: bars.map((b) => b.low), close: closes },
          { ...DEFAULT_SR_OPTIONS, pivotLength, invalidation }
        );
        srCache.set(key, zones);
      }
      const last = bars.length - 1;
      const { support, resistance } = nearestZones(zones, last, sampleBar.close, {
        ...DEFAULT_SR_OPTIONS, pivotLength, invalidation,
      });
      // `either` reports whichever of the two price is closer to, which is what
      // "the nearest zone" means when the alert does not name a side.
      const pick = side === "support" ? support
        : side === "resistance" ? resistance
        : (() => {
            if (!support) return resistance;
            if (!resistance) return support;
            const ds = Math.abs(sampleBar.close - support.price);
            const dr = Math.abs(sampleBar.close - resistance.price);
            return ds <= dr ? support : resistance;
          })();
      if (!pick) return undefined;
      return { price: pick.price, label: `${interval} ${pick.kind}` };
    };

    /** Pivot levels from the completed anchor period, cached per anchor+type. */
    const pivotFor = (
      type: PivotType, anchor: string, levelName: string
    ): { price: number; label: string } | undefined => {
      const period = this.anchorPeriods.get(`${symbol}|${anchor}`);
      if (!period) return undefined;
      const levels = pivotLevels(period, type);
      if (levels.length === 0) return undefined;
      const match = levelName === PIVOT_LEVEL_ANY
        ? nearestLevel(levels, sampleBar.close)
        : levelByName(levels, levelName);
      if (!match || !Number.isFinite(match.price)) return undefined;
      return { price: match.price, label: match.name };
    };

    /**
     * RSI, and whatever it is compared against.
     *
     * Cached per length because the SMA target needs the same RSI series the
     * level target does, and an alert on the level plus one on the MA is the
     * normal pairing rather than an unusual one.
     */
    const rsiCache = new Map<number, number[]>();
    const rsiSeries = (length: number): number[] => {
      let s = rsiCache.get(length);
      if (!s) { s = rsi(closes, length); rsiCache.set(length, s); }
      return s;
    };
    const rsiFor = (
      length: number, target: RsiTarget, level: number, maLength: number
    ): { value: number; reference: number } | undefined => {
      const series = rsiSeries(length);
      const value = series[series.length - 1];
      if (value === undefined || !Number.isFinite(value)) return undefined;
      if (target === "level") return { value, reference: level };
      // The RSI-based MA is smoothed from the RSI series including its leading
      // NaNs, so it appears at the bar the indicator would show it, not earlier.
      const ma = sma(series, maLength);
      const reference = ma[ma.length - 1];
      if (reference === undefined || !Number.isFinite(reference)) return undefined;
      return { value, reference };
    };

    /** MACD line against its signal, or against zero. */
    const macdCache = new Map<string, ReturnType<typeof macd>>();
    const macdFor = (
      fast: number, slow: number, signal: number, target: MacdTarget
    ): { value: number; reference: number } | undefined => {
      const key = `${fast}|${slow}|${signal}`;
      let m = macdCache.get(key);
      if (!m) { m = macd(closes, fast, slow, signal); macdCache.set(key, m); }
      const value = m.macd[m.macd.length - 1];
      if (value === undefined || !Number.isFinite(value)) return undefined;
      if (target === "zero") return { value, reference: 0 };
      const reference = m.signal[m.signal.length - 1];
      if (reference === undefined || !Number.isFinite(reference)) return undefined;
      return { value, reference };
    };

    /**
     * Supertrend, cached per parameter set.
     *
     * Recomputed from the whole bar history rather than incrementally: the
     * bands are stateful, so their value at the last bar depends on the entire
     * chain before it and cannot be derived from the previous cached result
     * plus one new candle.
     */
    const stCache = new Map<string, ReturnType<typeof supertrend>>();
    const stFor = (
      period: number, multiplier: number, atrMethod: StAtrMethod
    ): { trend: number; line: number } | undefined => {
      const key = `${period}|${multiplier}|${atrMethod}`;
      let st = stCache.get(key);
      if (!st) {
        st = supertrend(highs, lows, closes, period, multiplier, atrMethod === "rma");
        stCache.set(key, st);
      }
      const trend = st.trend[st.trend.length - 1];
      const line = st.line[st.line.length - 1];
      if (trend === undefined || !Number.isFinite(trend)) return undefined;
      return { trend, line: line ?? NaN };
    };

    /**
     * One Bollinger band's price, cached per parameter set.
     *
     * A band is a price level, so it is resolved here the way a pivot level
     * and an S/R zone are, and compared by the same shared evaluator. All
     * three lines come from one computation because an alert on the upper band
     * and one on the lower band are the normal pairing.
     */
    const bbCache = new Map<string, ReturnType<typeof bollinger>>();
    const bbFor = (
      length: number, mult: number, maType: MaType, band: BollingerBand
    ): { price: number; label: string } | undefined => {
      const key = `${length}|${mult}|${maType}`;
      let b = bbCache.get(key);
      if (!b) {
        b = bollinger(closes, length, mult, maType === "ema" ? "EMA" : "SMA", volumes);
        bbCache.set(key, b);
      }
      const series = band === "upper" ? b.upper : band === "lower" ? b.lower : b.middle;
      const price = series[series.length - 1];
      if (price === undefined || !Number.isFinite(price)) return undefined;
      const label = band === "basis" ? "Bollinger basis" : `${band} Bollinger band`;
      return { price, label };
    };

    /** Stochastic %K, against its %D or against a level. */
    const stochCache = new Map<string, ReturnType<typeof stochastic>>();
    const stochFor = (
      kLength: number, kSmooth: number, dSmooth: number,
      target: StochasticTarget, level: number
    ): { value: number; reference: number } | undefined => {
      const key = `${kLength}|${kSmooth}|${dSmooth}`;
      let st = stochCache.get(key);
      if (!st) {
        st = stochastic(highs, lows, closes, kLength, kSmooth, dSmooth);
        stochCache.set(key, st);
      }
      const value = st.k[st.k.length - 1];
      if (value === undefined || !Number.isFinite(value)) return undefined;
      if (target === "level") return { value, reference: level };
      const reference = st.d[st.d.length - 1];
      if (reference === undefined || !Number.isFinite(reference)) return undefined;
      return { value, reference };
    };

    /** ADX against a strength threshold. */
    const adxCache = new Map<string, ReturnType<typeof adx>>();
    const adxFor = (
      diLength: number, smoothing: number, level: number
    ): { value: number; reference: number } | undefined => {
      const key = `${diLength}|${smoothing}`;
      let a = adxCache.get(key);
      if (!a) {
        a = adx(highs, lows, closes, diLength, smoothing);
        adxCache.set(key, a);
      }
      const value = a.adx[a.adx.length - 1];
      if (value === undefined || !Number.isFinite(value)) return undefined;
      return { value, reference: level };
    };

    /**
     * One gate's reading on a timeframe that is not this feed's.
     *
     * The truncation and the indicator both live in `alerts/filterSeries.ts`,
     * which is pure — the look-ahead boundary is the part most worth testing
     * directly, and it should not need a runner, a feed or a database to pin.
     */
    const otherTimeframe = (
      timeframe: Interval, filter: AlertFilter
    ): number | undefined => {
      const all = gateBars.get(timeframe);
      if (!all) return undefined;
      return gateReading(all, sampleBar.closeTime, filter);
    };

    const sample: FeedSample = {
      symbol, timeframe: interval,
      barTime: sampleBar.openTime,
      isClosedBar,
      high: sampleBar.high,
      low: sampleBar.low,
      close: sampleBar.close,
      series: seriesFor,
      srZone: srFor,
      pivotLevel: pivotFor,
      rsi: rsiFor,
      macd: macdFor,
      supertrend: stFor,
      otherTimeframe,
      bollinger: bbFor,
      stochastic: stochFor,
      adx: adxFor,
    };
    const now = replayNow ?? this.dependencies.now();

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
        delivered = await this.fire(
          alert, condition, sampleBar, plan.reference, plan.distancePct,
          !isClosedBar, plan.label
        );
      }
      const next = stateAfterPlan(spec, plan, {
        barTime: sampleBar.openTime, now, delivered,
      });
      await this.dependencies.recordEvaluation({
        id: alert.id,
        side: next.lastSide,
        barTime: next.lastBarTime,
        fired: plan.fire,
        complete: next.fireState.completed && !spec.fireState.completed,
      });
    }
  }

  /**
   * Bars for every timeframe a gate on this feed names, other than its own.
   *
   * Distinct timeframes only — twelve alerts gated on the 1h RSI cost one
   * fetch. Backfill failures are logged and the timeframe is left absent,
   * which makes the gate unresolved, which fails it closed: an alert gated on
   * data the runner could not fetch stays silent rather than firing on a guess.
   */
  private async loadFilterTimeframes(
    symbol: string, own: Interval, alerts: MaAlertRow[]
  ): Promise<Map<Interval, Candle[]>> {
    const wanted = new Set<Interval>();
    for (const alert of alerts) {
      const condition = conditionFromRow(alert);
      for (const filter of condition?.filters ?? []) {
        if (filter.timeframe && filter.timeframe !== own) wanted.add(filter.timeframe);
      }
    }

    const out = new Map<Interval, Candle[]>();
    for (const timeframe of wanted) {
      try {
        const endMs = Date.now();
        await ensureCandles(
          symbol, timeframe, endMs - INTERVAL_MS[timeframe] * HISTORY_BARS, endMs
        );
      } catch (err) {
        this.log.warn(
          { symbol, timeframe, err: (err as Error).message },
          "gate timeframe backfill failed"
        );
      }
      const rows = await candleRepo.getCandles(symbol, timeframe, { limit: HISTORY_BARS });
      if (rows.length > 0) out.set(timeframe, rows);
    }
    return out;
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
    reference: number, distancePct: number, intrabar: boolean,
    /** What the reference resolved to — the zone's side, or the pivot level. */
    label: string | null
  ): Promise<boolean> {
    const { title, body, tag, url } = formatAlertPush(
      alert, condition, bar, reference, distancePct, intrabar, label ?? undefined
    );

    let delivery: PushResult = { sent: 0, pruned: 0, failed: 0 };
    try {
      delivery = await this.dependencies.sendPush({ title, body, tag, url }, this.log);
    } catch (err) {
      // A failure before fan-out (VAPID setup or subscription lookup) has no
      // per-device count. Persist one failure without storing the raw error,
      // endpoint, or any credential-bearing transport detail.
      delivery.failed = Math.max(1, delivery.failed);
      this.log.error({ alertId: alert.id, err: (err as Error).message }, "alert push failed");
    }

    const deliveryStatus: "delivered" | "partial_failure" | "failed" | "no_devices" =
      delivery.sent > 0
        ? (delivery.failed > 0 || delivery.pruned > 0 ? "partial_failure" : "delivered")
        : delivery.failed > 0
          ? "failed"
          : "no_devices";

    // The event row is written whether or not a device was reachable, so the
    // in-app feed still shows what fired when the phone was offline.
    await this.dependencies.createEvent({
      alertId: alert.id,
      barTime: bar.openTime,
      price: bar.close,
      maValue: reference,
      distancePct,
      title,
      body,
      pushedTo: delivery.sent,
      pushFailed: delivery.failed,
      pushPruned: delivery.pruned,
      deliveryStatus,
      intrabar,
      frequency: alert.frequency,
    });
    this.log.info(
      {
        alertId: alert.id, symbol: alert.symbol, kind: alert.conditionKind,
        intrabar, pushedTo: delivery.sent, pushFailed: delivery.failed,
        pushPruned: delivery.pruned, deliveryStatus,
      },
      "alert fired"
    );
    return delivery.sent > 0;
  }
}
