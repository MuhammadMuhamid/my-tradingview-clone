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
import {
  adx, autoFib, autoFibLevelPrice, enteredZone, liquiditySwings, marketStructure,
  type ObZoneChoice, type SwingArea, bollinger, ema, macd, rsi, sma, stochastic, supertrend,
} from "./ta";
import { buildZones, nearestZones, DEFAULT_SR_OPTIONS } from "./srZones";
import {
  levelByName, nearestLevel, pivotLevels, type PivotType, type Period,
} from "./pivotLevels";
import { conditionFromRow, type AlertCondition, type Side } from "../alerts/alertConditions";
import { acceptsIntrabarSample } from "../alerts/alertFrequency";
import {
  planAlert, stateAfterPlan, type AlertSpec, type FeedSample,
} from "../alerts/alertPlan";
import { formatAlertPush } from "../alerts/alertMessage";
import { sendPush, type PushResult } from "../alerts/webPush";
import { scannerRequest } from "../scanner/client";

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
  claimDelivery?: typeof maAlertRepo.claimDelivery;
  completeDelivery?: typeof maAlertRepo.completeDelivery;
  sendPush: typeof sendPush;
  now: () => number;
  analyzePatterns: (input: {
    symbol: string; interval: Interval; bars: Candle[]; asOf: number;
    settings: Record<string, unknown>;
  }) => Promise<{
    detector_id: string; detector_version: string; settings_hash: string;
    patterns: Array<{ id: string; name: string; open_time: number; occurrence_id?: string } & Record<string, unknown>>;
  }>;
}

const DEFAULT_DEPENDENCIES: MaAlertRunnerDependencies = {
  listAlerts: maAlertRepo.listAlerts,
  recordEvaluation: maAlertRepo.recordEvaluation,
  createEvent: maAlertRepo.createEvent,
  claimDelivery: maAlertRepo.claimDelivery,
  completeDelivery: maAlertRepo.completeDelivery,
  sendPush,
  now: Date.now,
  analyzePatterns: ({ symbol, interval, bars, asOf, settings }) => scannerRequest({
    method: "POST", path: "/api/patterns/analyze",
    body: {
      venue: "BINANCE", market_type: "spot", symbol, timeframe: interval, as_of: asOf,
      candles: bars.slice(-HISTORY_BARS).map((bar) => ({
        open_time: bar.openTime, open: bar.open, high: bar.high, low: bar.low,
        close: bar.close, close_time: bar.closeTime,
      })),
      settings,
    },
  }),
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
      // Every account's alerts: the runner is the one reader with no owner.
      alerts = await this.dependencies.listAlerts({ userId: null, activeOnly: true });
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
      userId: null, symbol, timeframe: interval, activeOnly: true,
    });
    const relevant = isClosedBar
      ? alerts
      : alerts.filter((a) => acceptsIntrabarSample(a.frequency));
    if (relevant.length === 0) return;

    type PatternHit = {
      id: string; name: string; open_time: number; occurrence_id?: string;
    } & Record<string, unknown>;
    type CanonicalProfile = {
      ids: readonly string[];
      nameFor: (id: string) => string | undefined;
      occurrenceFor: (id: string) => PatternHit | undefined;
    };
    const patternProfileKey = (alert: MaAlertRow): string =>
      `${alert.patternDetectorId ?? ""}\u0000${alert.patternDetectorVersion ?? ""}` +
      `\u0000${alert.patternSettingsHash ?? ""}`;
    const canonicalPatterns = new Map<string, CanonicalProfile>();
    if (isClosedBar) {
      const profiles = new Map<string, MaAlertRow>();
      for (const alert of relevant) {
        if (alert.conditionKind !== "candlestick_pattern") continue;
        if (!alert.patternDetectorId || !alert.patternDetectorVersion
            || !alert.patternSettingsHash || !alert.patternSettings) {
          this.log.warn({ alertId: alert.id }, "candlestick alert requires re-arm for provenance");
          continue;
        }
        profiles.set(patternProfileKey(alert), alert);
      }
      for (const [profileKey, profile] of profiles) {
        const profileHash = profile.patternSettingsHash!;
        try {
          const result = await this.dependencies.analyzePatterns({
            symbol, interval, bars, asOf: sampleBar.closeTime,
            settings: profile.patternSettings!,
          });
          if (result.detector_id !== profile.patternDetectorId
              || result.detector_version !== profile.patternDetectorVersion
              || result.settings_hash !== profileHash) {
            this.log.error({ alertId: profile.id, profileHash },
              "candlestick detector profile changed; re-arm required");
            continue;
          }
          const exact = result.patterns.filter((hit) => hit.open_time === sampleBar.openTime);
          const hits = new Map(exact.map((hit) => [hit.id, hit]));
          canonicalPatterns.set(profileKey, {
            ids: [...hits.keys()],
            nameFor: (id) => hits.get(id)?.name,
            occurrenceFor: (id) => hits.get(id),
          });
        } catch (err) {
          // Do not advance pattern-alert state when canonical truth is
          // unavailable. The next closed-bar pass can recover.
          this.log.error({ symbol, interval, profileHash, err: (err as Error).message },
            "canonical candlestick analysis unavailable");
        }
      }
    }

    const closes = bars.map((b) => b.close);
    // Supertrend needs the full range, not just closes: its bands are built
    // from true range, which is a high/low/close quantity.
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    // Only a VWMA-based Bollinger basis reads volume, but building the array
    // once is cheaper than deciding whether to.
    const volumes = bars.map((b) => b.volume);
    const opens = bars.map((b) => b.open);

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
    /**
     * One Auto Fib level on this feed's own bars.
     *
     * `autoFib` is `ta/core`'s — the function the chart's Auto Fib study draws
     * with — over the same bounded history every family here uses. The latest
     * swing is stable well inside that window (measured: identical from 150
     * bars to 1000 on BTC, NEAR and SOL at 15m, 1h and 4h), so the level an
     * alert fires on is the level the chart shows. Cached per zig-zag input:
     * five alerts at different ratios share one zig-zag.
     */
    const fibCache = new Map<string, ReturnType<typeof autoFib>>();
    const fibFor = (
      deviation: number, depth: number, reverse: boolean, level: number
    ): { price: number; label: string } | undefined => {
      const key = `${deviation}|${depth}|${reverse}`;
      let fib = fibCache.get(key);
      if (fib === undefined) {
        fib = autoFib(highs, lows, closes, deviation, depth, reverse);
        fibCache.set(key, fib);
      }
      if (!fib) return undefined;
      const price = autoFibLevelPrice(fib, level);
      return Number.isFinite(price) ? { price, label: String(level) } : undefined;
    };

    /**
     * The MSB-OB study and the Liquidity Swings study on this feed's bars —
     * `marketStructure` / `liquiditySwings` from `ta/core`, the functions the
     * chart's studies draw with. The evaluated bar is the last one in `bars`.
     * Cached per input set: an MSB alert and an order-block alert with the
     * same zig-zag share one computation.
     */
    const at = bars.length - 1;
    const msCache = new Map<string, ReturnType<typeof marketStructure>>();
    const msOf = (zigzagLength: number, fibFactor: number) => {
      const key = `${zigzagLength}|${fibFactor}`;
      let ms = msCache.get(key);
      if (!ms) { ms = marketStructure(opens, highs, lows, closes, zigzagLength, fibFactor); msCache.set(key, ms); }
      return ms;
    };
    const msbFor = (zigzagLength: number, fibFactor: number) => {
      if (at < 1) return undefined;
      const ms = msOf(zigzagLength, fibFactor);
      const brk = ms.breaks.find((b) => b.index === at);
      return { market: ms.market[at]!, broke: brk ? brk.direction : 0, price: brk ? brk.price : NaN };
    };
    const ZONE_NAMES: Record<string, string> = { bu_ob: "Bu-OB", be_ob: "Be-OB", bu_bb: "Bu-BB", be_bb: "Be-BB" };
    const orderBlockFor = (zigzagLength: number, fibFactor: number, zone: ObZoneChoice) => {
      if (at < 1) return undefined;
      const hit = enteredZone(msOf(zigzagLength, fibFactor), at, zone);
      if (!hit) return { entered: false, price: NaN, label: "" };
      const bullish = hit.kind.startsWith("bu");
      return { entered: true, price: bullish ? hit.top : hit.bottom, label: ZONE_NAMES[hit.kind] ?? hit.kind };
    };
    const lsCache = new Map<string, ReturnType<typeof liquiditySwings>>();
    const liquidityFor = (length: number, area: SwingArea, side: "high" | "low" | "either") => {
      const key = `${length}|${area}`;
      let ls = lsCache.get(key);
      if (!ls) { ls = liquiditySwings(opens, highs, lows, closes, volumes, length, area); lsCache.set(key, ls); }
      const hi = ls.liveHigh[at] ?? NaN;
      const lo = ls.liveLow[at] ?? NaN;
      if (side === "high") return Number.isFinite(hi) ? { price: hi, label: "high" } : undefined;
      if (side === "low") return Number.isFinite(lo) ? { price: lo, label: "low" } : undefined;
      const c = closes[at]!;
      const cands = [
        ...(Number.isFinite(hi) ? [{ price: hi, label: "high" }] : []),
        ...(Number.isFinite(lo) ? [{ price: lo, label: "low" }] : []),
      ];
      return cands.sort((a, b) => Math.abs(a.price - c) - Math.abs(b.price - c))[0];
    };

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
      // The RSI-based MA, in whichever average the alert named. Delegated to
      // the filter's own resolver so an alert and a filter on "RSI 50 vs its
      // EMA 14" are one computation and cannot disagree about the line.
      return rsiMaFor(length, target, maLength);
    };

    /**
     * RSI against a moving average OF THE RSI, in the type the gate named.
     *
     * Also the RSI alert family's MA target (`rsiFor` delegates here for
     * "sma" and "ema"), so the alert and the filter share one line. It began
     * life separate because the family once offered only an SMA; measuring a
     * filter's EMA as an SMA would have made the rule a different rule while
     * still looking right.
     */
    const rsiMaFor = (
      length: number, maType: MaType, maLength: number
    ): { value: number; reference: number } | undefined => {
      const series = rsiSeries(length);
      const value = series[series.length - 1];
      if (value === undefined || !Number.isFinite(value)) return undefined;
      // Smoothed from the RSI series INCLUDING its leading NaNs, so it appears
      // at the bar the indicator would show it and not earlier.
      const line = maType === "sma" ? sma(series, maLength) : ema(series, maLength);
      const reference = line[line.length - 1];
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
      fibLevel: fibFor,
      msb: msbFor,
      orderBlock: orderBlockFor,
      liquiditySwing: liquidityFor,
      rsi: rsiFor,
      rsiMa: rsiMaFor,
      macd: macdFor,
      supertrend: stFor,
      bollinger: bbFor,
      stochastic: stochFor,
      adx: adxFor,
    };
    const now = replayNow ?? this.dependencies.now();

    // Read every condition once, before the loop: the gate feeds are fetched
    // per DISTINCT timeframe across ALL of these alerts, so they have to be
    // known up front to be shared rather than fetched per alert.
    const conditions = new Map<string, AlertCondition | null>(
      relevant.map((a) => [a.id, conditionFromRow(a)])
    );
    const gateFeeds = await this.gateFeeds(
      symbol, interval, [...conditions.values()], sampleBar.openTime
    );
    const sampleWithGates: FeedSample =
      Object.keys(gateFeeds).length > 0 ? { ...sample, gateFeeds } : sample;

    for (const alert of relevant) {
      const canonical = alert.conditionKind === "candlestick_pattern"
        ? canonicalPatterns.get(patternProfileKey(alert)) : undefined;
      if (alert.conditionKind === "candlestick_pattern" && !canonical) continue;
      const evaluationSample = canonical
        ? { ...sampleWithGates, patterns: canonical } : sampleWithGates;
      const condition = conditions.get(alert.id) ?? null;
      if (!condition) {
        this.log.warn({ alertId: alert.id, kind: alert.conditionKind }, "alert row is not evaluable");
        continue;
      }
      const spec = toSpec(alert, condition);
      const plan = planAlert(spec, evaluationSample, now);
      if (!plan.act) continue;

      let delivered = false;
      let claimed = true;
      if (plan.fire) {
        const preDeliveryState = stateAfterPlan(spec, plan, {
          barTime: sampleBar.openTime, now, delivered: false,
        });
        const delivery = await this.fire(
          alert, condition, sampleBar, plan.reference, plan.distancePct,
          !isClosedBar, plan.label, preDeliveryState.lastSide,
          condition.kind === "candlestick_pattern"
            ? canonical?.occurrenceFor(condition.patternId) : undefined,
        );
        delivered = delivery.delivered;
        claimed = delivery.claimed;
      }
      if (!claimed) continue;
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
   * Bars for the MA computation. The websocket bar is appended explicitly
   * because the DB copy of the just-closed candle may not have landed yet.
   */
  /**
   * A feed carrying only what a GATE can read, for one other timeframe.
   *
   * Gates use five resolvers and no more: the moving average, RSI, RSI against
   * its own MA, MACD and Supertrend. The support/resistance, pivot, Bollinger,
   * stochastic, ADX and pattern resolvers are deliberately absent — no gate
   * kind reads them, and building them would scan the history for answers
   * nobody asks for.
   */
  private gateFeed(symbol: string, interval: Interval, bars: Candle[]): FeedSample | undefined {
    const last = bars[bars.length - 1];
    if (!last) return undefined;

    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);

    const maCache = new Map<string, number[]>();
    const seriesFor = (type: MaType, length: number): number | undefined => {
      const k = `${type}${length}`;
      let a = maCache.get(k);
      if (!a) { a = type === "sma" ? sma(closes, length) : ema(closes, length); maCache.set(k, a); }
      const v = a[a.length - 1];
      return v === undefined || !Number.isFinite(v) ? undefined : v;
    };

    const rsiCache = new Map<number, number[]>();
    const rsiSeries = (length: number): number[] => {
      let a = rsiCache.get(length);
      if (!a) { a = rsi(closes, length); rsiCache.set(length, a); }
      return a;
    };

    const rsiFor = (
      length: number, target: RsiTarget, level: number, maLength: number
    ): { value: number; reference: number } | undefined => {
      const series = rsiSeries(length);
      const value = series[series.length - 1];
      if (value === undefined || !Number.isFinite(value)) return undefined;
      if (target === "level") return { value, reference: level };
      const line = sma(series, maLength);
      const reference = line[line.length - 1];
      if (reference === undefined || !Number.isFinite(reference)) return undefined;
      return { value, reference };
    };

    const rsiMaFor = (
      length: number, maType: MaType, maLength: number
    ): { value: number; reference: number } | undefined => {
      const series = rsiSeries(length);
      const value = series[series.length - 1];
      if (value === undefined || !Number.isFinite(value)) return undefined;
      const line = maType === "sma" ? sma(series, maLength) : ema(series, maLength);
      const reference = line[line.length - 1];
      if (reference === undefined || !Number.isFinite(reference)) return undefined;
      return { value, reference };
    };

    const macdCache = new Map<string, ReturnType<typeof macd>>();
    const macdFor = (
      fast: number, slow: number, signal: number, target: MacdTarget
    ): { value: number; reference: number } | undefined => {
      const k = `${fast}|${slow}|${signal}`;
      let m = macdCache.get(k);
      if (!m) { m = macd(closes, fast, slow, signal); macdCache.set(k, m); }
      const value = m.macd[m.macd.length - 1];
      if (value === undefined || !Number.isFinite(value)) return undefined;
      if (target === "zero") return { value, reference: 0 };
      const reference = m.signal[m.signal.length - 1];
      if (reference === undefined || !Number.isFinite(reference)) return undefined;
      return { value, reference };
    };

    const stCache = new Map<string, ReturnType<typeof supertrend>>();
    const stFor = (
      period: number, multiplier: number, atrMethod: StAtrMethod
    ): { trend: number; line: number } | undefined => {
      const k = `${period}|${multiplier}|${atrMethod}`;
      let t = stCache.get(k);
      if (!t) {
        t = supertrend(highs, lows, closes, period, multiplier, atrMethod === "rma");
        stCache.set(k, t);
      }
      const trend = t.trend[t.trend.length - 1];
      const line = t.line[t.line.length - 1];
      if (trend === undefined || !Number.isFinite(trend)) return undefined;
      return { trend, line: line ?? NaN };
    };

    return {
      symbol, timeframe: interval,
      barTime: last.openTime,
      // A gate asks "is this true NOW", so a still-forming higher-timeframe bar
      // is the right bar to read. It is never used to decide a cross.
      isClosedBar: false,
      high: last.high, low: last.low, close: last.close,
      series: seriesFor,
      rsi: rsiFor,
      rsiMa: rsiMaFor,
      macd: macdFor,
      supertrend: stFor,
    };
  }

  /**
   * One feed per DISTINCT timeframe any of these alerts gates on.
   *
   * Fetched once and shared across every alert on the symbol, so ten gates
   * spread over two timeframes cost the two fetches that two gates would. The
   * alert's own timeframe is never fetched here — a gate that does not name one
   * reads the sample the caller already built.
   *
   * Bounded by `uptoMs`, the open time of the bar being evaluated, so a replay
   * cannot read a candle from after the moment it is replaying. A timeframe
   * that fails to load is simply absent, and `filtersPass` treats a gate with
   * no reading as SHUT rather than open.
   */
  private async gateFeeds(
    symbol: string, own: Interval, conditions: readonly (AlertCondition | null)[], uptoMs: number
  ): Promise<Record<string, FeedSample | undefined>> {
    const wanted = new Set<Interval>();
    for (const condition of conditions) {
      for (const gate of condition?.filters ?? []) {
        if (gate.timeframe && gate.timeframe !== own) wanted.add(gate.timeframe as Interval);
      }
    }
    if (wanted.size === 0) return {};

    const feeds: Record<string, FeedSample | undefined> = {};
    await Promise.all([...wanted].map(async (interval) => {
      try {
        const span = INTERVAL_MS[interval] * HISTORY_BARS;
        await ensureCandles(symbol, interval, uptoMs - span, uptoMs);
        const bars = await candleRepo.getCandles(symbol, interval, {
          to: uptoMs, limit: HISTORY_BARS,
        });
        feeds[interval] = this.gateFeed(symbol, interval, bars);
      } catch (err) {
        // Left absent on purpose: a gate the runner cannot measure must shut
        // the alert, not wave it through.
        this.log.warn(
          { symbol, interval, err: (err as Error).message },
          "gate timeframe unavailable; gates on it are shut"
        );
      }
    }));
    return feeds;
  }

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
    label: string | null, nextSide: Side | null,
    patternOccurrence?: Record<string, unknown>,
  ): Promise<{ delivered: boolean; claimed: boolean }> {
    const { title, body, tag, url } = formatAlertPush(
      alert, condition, bar, reference, distancePct, intrabar, label ?? undefined
    );
    const occurrenceKey = [
      alert.id,
      bar.openTime,
      intrabar ? "intrabar" : "closed",
      alert.frequency === "once_per_minute"
        ? Math.floor(this.dependencies.now() / 60_000)
        : "bar",
    ].join(":");
    if (this.dependencies.claimDelivery) {
      const claimed = await this.dependencies.claimDelivery({
        occurrenceKey,
        id: alert.id,
        side: nextSide,
        barTime: bar.openTime,
        payload: { title, body, tag, url },
      });
      if (!claimed) {
        this.log.warn({ alertId: alert.id, occurrenceKey },
          "alert occurrence already claimed; external push not repeated");
        return { delivered: false, claimed: false };
      }
    }

    let delivery: PushResult = { sent: 0, pruned: 0, failed: 0 };
    try {
      // To the alert's owner's devices, and nobody else's.
      delivery = await this.dependencies.sendPush({ title, body, tag, url }, this.log, { userId: alert.userId });
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
    const event = {
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
      patternDetectorId: alert.conditionKind === "candlestick_pattern"
        ? alert.patternDetectorId : null,
      patternDetectorVersion: alert.conditionKind === "candlestick_pattern"
        ? alert.patternDetectorVersion : null,
      patternSettingsHash: alert.conditionKind === "candlestick_pattern"
        ? alert.patternSettingsHash : null,
      patternOccurrenceId: alert.conditionKind === "candlestick_pattern" && patternOccurrence
        ? String(patternOccurrence.occurrence_id ?? `${patternOccurrence.id}:${patternOccurrence.open_time}`)
        : null,
      patternOccurrence: alert.conditionKind === "candlestick_pattern"
        ? patternOccurrence ?? null : null,
    };
    if (this.dependencies.completeDelivery) {
      await this.dependencies.completeDelivery(occurrenceKey, event);
    } else {
      await this.dependencies.createEvent(event);
    }
    this.log.info(
      {
        alertId: alert.id, symbol: alert.symbol, kind: alert.conditionKind,
        intrabar, pushedTo: delivery.sent, pushFailed: delivery.failed,
        pushPruned: delivery.pruned, deliveryStatus,
      },
      "alert fired"
    );
    return { delivered: delivery.sent > 0, claimed: true };
  }
}
