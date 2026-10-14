/**
 * Arming one alert across many coins: a watchlist, or every tracked coin.
 *
 * "RSI 50 crossing above 50 on 15m and 1h, on every coin in my watchlist" is
 * one decision, not forty repetitions of the same dialog. The dialogs keep
 * their own body-building and their own rule for "this is the same alert";
 * this file decides WHICH coins, checks the alert engine can actually watch
 * the result, and runs the requests.
 *
 * Pure apart from `armAcross`, which only calls the function it is handed.
 */
import type { MaAlert, ServerWatchlist } from "@/lib/api";
import {
  CRYPTO_SPOT, DEFAULT_ASSET_CLASS, DEFAULT_VENUE, legacyBinanceSpotTicker,
} from "@/lib/instrument";
import type { Interval, SymbolInfo } from "@/lib/types";

/**
 * How many coin × timeframe feeds the alert engine can watch at once.
 *
 * The runner streams every alert's candles over ONE combined Binance
 * connection, capped at `MAX_STREAMS_PER_CONN` in
 * `backend/src/data/binanceWs.ts`. Past the cap `subscribe()` throws and the
 * runner only LOGS it: the alert still shows as armed and simply never fires.
 * That is the failure this budget exists to make impossible from a dialog —
 * "all coins on four timeframes" can need several times the cap.
 *
 * Mirrored rather than fetched, and pinned to the backend value by
 * `tests/alertScope.test.ts`, which reads that file.
 */
export const ALERT_FEED_CAP = 200;

export type AlertScope =
  | { kind: "symbol" }
  | { kind: "watchlist"; id: string }
  | { kind: "all" };

/** A `<select>` value for a scope, and back. */
export const scopeValue = (scope: AlertScope): string =>
  scope.kind === "symbol" ? "" : scope.kind === "all" ? "all" : `wl:${scope.id}`;

export const parseScope = (value: string): AlertScope =>
  value === "all" ? { kind: "all" }
    : value.startsWith("wl:") ? { kind: "watchlist", id: value.slice(3) }
      : { kind: "symbol" };

/**
 * Whether the alert engine can evaluate this instrument at all.
 *
 * It streams Binance spot klines and nothing else, so an alert on a stock, an
 * FX pair or a derivative would arm and never be evaluated. Rows that predate
 * the venue fields carry neither and are Binance spot by the catalogue's own
 * default.
 */
export function isAlertable(info: Pick<SymbolInfo, "venue" | "assetClass">): boolean {
  return (info.venue ?? DEFAULT_VENUE) === DEFAULT_VENUE
    && (info.assetClass ?? DEFAULT_ASSET_CLASS) === CRYPTO_SPOT;
}

/**
 * The bare Binance spot ticker an alert is stored under, or null.
 *
 * Watchlists hold CANONICAL instrument ids
 * (`instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot`), alerts are stored under
 * the bare ticker (`BTCUSDT`), and the two are not equal as strings —
 * `sameInstrument` itself reports them as different. Everything here is keyed
 * through this one projection, so a watchlist entry, a catalogue row and an
 * existing alert for the same coin meet on one key. A canonical id that is not
 * Binance SPOT (a perpetual, a stock) has no ticker the alert engine can
 * stream, and comes back null.
 */
export const alertTicker = (raw: string): string | null => {
  const t = legacyBinanceSpotTicker(String(raw ?? "").trim());
  return t ? t.toUpperCase() : null;
};

const keyOf = (raw: string): string => alertTicker(raw) ?? String(raw).toUpperCase();

/** "All coins": every active, tracked Binance spot symbol, once, sorted. */
export function allAlertableSymbols(tracked: readonly SymbolInfo[]): string[] {
  const out = new Set<string>();
  for (const s of tracked) {
    if (!s.isActive || !isAlertable(s)) continue;
    const t = alertTicker(s.symbol);
    if (t) out.add(t);
  }
  return [...out].sort();
}

export interface ScopeTargets {
  /** Bare Binance spot tickers, the form alerts are stored under. */
  symbols: string[];
  /** Watchlist entries the alert engine cannot watch, as written, left out. */
  excluded: string[];
}

/**
 * The coins a scope means.
 *
 * A watchlist is the user's own explicit list, so its coins are kept as
 * written — except any the catalogue positively knows the alert engine cannot
 * watch, which are reported rather than silently dropped. A coin the catalogue
 * has never seen is kept: watchlists hold tickers the user typed.
 */
export function scopeTargets(
  scope: AlertScope,
  chartSymbol: string,
  watchlists: readonly ServerWatchlist[],
  tracked: readonly SymbolInfo[],
): ScopeTargets {
  if (scope.kind === "symbol") return { symbols: [keyOf(chartSymbol)], excluded: [] };
  if (scope.kind === "all") return { symbols: allAlertableSymbols(tracked), excluded: [] };

  const list = watchlists.find((w) => w.id === scope.id);
  if (!list) return { symbols: [], excluded: [] };
  const known = new Map(tracked.map((s) => [keyOf(s.symbol), s]));
  const symbols = new Set<string>();
  const excluded: string[] = [];
  for (const raw of list.symbols) {
    const ticker = alertTicker(raw);
    const info = ticker ? known.get(ticker) : undefined;
    if (!ticker || (info && !isAlertable(info))) excluded.push(raw);
    else symbols.add(ticker);
  }
  return { symbols: [...symbols], excluded };
}

export interface FeedBudget {
  /** Distinct coin × timeframe feeds the engine watches now. */
  inUse: number;
  /** Feeds after this save. Equal to `inUse` when the alerts are saved paused. */
  after: number;
  cap: number;
  fits: boolean;
}

const feedKey = (symbol: string, timeframe: string) => `${keyOf(symbol)}|${timeframe}`;

/**
 * Whether the engine can watch everything after this save.
 *
 * Counted the way the runner counts: one feed per distinct symbol × timeframe
 * among alerts that are enabled and not yet completed. Ten alerts on BTCUSDT
 * 15m are one feed; a paused alert is none. Alerts saved PAUSED add nothing.
 */
export function feedBudget(
  existing: readonly MaAlert[],
  targets: readonly { symbol: string; timeframe: Interval }[],
  arming: boolean,
  cap: number = ALERT_FEED_CAP,
): FeedBudget {
  const live = new Set(
    existing.filter((a) => a.enabled && !a.completedAt).map((a) => feedKey(a.symbol, a.timeframe)),
  );
  const inUse = live.size;
  if (arming) for (const t of targets) live.add(feedKey(t.symbol, t.timeframe));
  return { inUse, after: live.size, cap, fits: live.size <= cap };
}

export interface ArmPlanItem {
  symbol: string;
  timeframe: Interval;
  /** The alert this save EDITS instead of creating a twin, or null to create. */
  existingId: string | null;
}

/**
 * One request per coin × timeframe, each either an edit or a create.
 *
 * `sameAlert` is the dialog's own rule for "this is the alert you already
 * have" — the indicator dialog matches on family and timeframe, the level
 * dialog also on mode and side. It is applied per coin, so arming a watchlist
 * edits each coin's existing alert exactly as arming that coin alone would,
 * instead of leaving the old one behind beside a new twin.
 */
export function planArming(
  symbols: readonly string[],
  timeframes: readonly Interval[],
  existing: readonly MaAlert[],
  sameAlert: (alert: MaAlert, timeframe: Interval) => boolean,
): ArmPlanItem[] {
  const plan: ArmPlanItem[] = [];
  for (const symbol of symbols) {
    const mine = existing.filter((a) => keyOf(a.symbol) === keyOf(symbol));
    for (const timeframe of timeframes) {
      const match = mine.find((a) => sameAlert(a, timeframe));
      plan.push({ symbol, timeframe, existingId: match ? match.id : null });
    }
  }
  return plan;
}

export interface ArmResult {
  done: ArmPlanItem[];
  failed: { item: ArmPlanItem; reason: string }[];
}

/**
 * Run the plan one request at a time, carrying on past a failure.
 *
 * Sequential on purpose: the backend runs on one small instance, and a
 * watchlist fired as a burst of parallel writes competes with the alert
 * runner it is arming. One coin failing — a delisted ticker, say — is
 * reported, not allowed to abandon the other thirty-nine half done.
 */
export async function armAcross(
  plan: readonly ArmPlanItem[],
  act: (item: ArmPlanItem) => Promise<void>,
  onProgress?: (completed: number, total: number) => void,
): Promise<ArmResult> {
  const result: ArmResult = { done: [], failed: [] };
  for (const [index, item] of plan.entries()) {
    try {
      await act(item);
      result.done.push(item);
    } catch (error) {
      result.failed.push({ item, reason: (error as Error).message || "request failed" });
    }
    onProgress?.(index + 1, plan.length);
  }
  return result;
}

/** "38 alerts armed across 19 coins · 15m, 1h (4 updated) · 2 failed: …" */
export function armingSummary(
  result: ArmResult, timeframes: readonly Interval[], verb: "armed" | "saved" = "armed",
): string {
  const coins = new Set(result.done.map((i) => i.symbol)).size;
  const updated = result.done.filter((i) => i.existingId !== null).length;
  let text = `${result.done.length} alert${result.done.length === 1 ? "" : "s"} ${verb} across `
    + `${coins} coin${coins === 1 ? "" : "s"} · ${timeframes.join(", ")}`;
  if (updated > 0) text += ` (${updated} existing updated, not duplicated)`;
  if (result.failed.length > 0) {
    const shown = result.failed.slice(0, 3)
      .map((f) => `${f.item.symbol} ${f.item.timeframe}: ${f.reason}`).join("; ");
    text += ` · ${result.failed.length} failed — ${shown}`
      + (result.failed.length > 3 ? ` and ${result.failed.length - 3} more` : "");
  }
  return text;
}
