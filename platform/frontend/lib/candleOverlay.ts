"use client";
/**
 * Candlestick patterns on the chart — the Screener's, not a second opinion.
 *
 * ── Why this file contains no pattern logic at all ─────────────────────────
 *
 * Because there must be exactly one implementation of "is this a hammer", and
 * it already exists: `screener/backend/app/indicators/candles.py`, with every
 * threshold a named parameter and every strength a documented function of the
 * bar's own ratios. Writing a TypeScript port here would produce a second
 * implementation that agrees on the day it is written and drifts thereafter —
 * and the failure mode is the worst kind: the Screener says a bar is a Bullish
 * Engulfing, the chart does not mark it, and the user has to decide which of
 * their own tools to believe.
 *
 * So the chart READS what the Screener reports for this instrument and
 * timeframe and places it on the bars it names. Agreement is by construction
 * rather than by discipline.
 *
 * ── What that costs, stated honestly ───────────────────────────────────────
 *
 * The Screener reports the patterns it found in its own recent window
 * (`lookback`, five closed bars by default), for the symbols and timeframes it
 * tracks. So this is NOT a full-history pattern overlay and does not pretend
 * to be: it marks what the Screener is reporting NOW. `overlayNotice` says so
 * on the chart rather than leaving a user to conclude that the last five bars
 * are the only patterns that ever formed.
 *
 * ── Off by default ─────────────────────────────────────────────────────────
 *
 * Pattern marks are opinions about bars, drawn on top of the bars themselves.
 * A chart that arrives already covered in them has made a choice on the user's
 * behalf about what matters.
 */
import type { ChartMarker } from "@/components/CandleChart";
import type { CandlePattern, Snapshot } from "@/lib/scanner/types";
import { sameInstrument } from "@/lib/instrument";
import type { Candle } from "@/lib/types";
import type { Resolution } from "@/lib/resolution";

export const CANDLE_OVERLAY_KEY = "tv.candleOverlay.v1";

/** A pattern the Screener reported, placed on the bar it belongs to. */
export interface PlacedPattern {
  pattern: CandlePattern;
  /** Index into the chart's bars. */
  index: number;
  /** Bar open time in seconds, which is what the chart marks against. */
  time: number;
}

/**
 * Which chart bar a `bars_ago` refers to.
 *
 * `bars_ago: 0` is the Screener's newest CLOSED bar. The chart's newest bar is
 * usually the one still FORMING, so the anchor is the last closed bar, not the
 * last bar. Getting this wrong by one would put every mark on the bar after
 * the one that formed the pattern — which is exactly the kind of off-by-one
 * that looks plausible and is completely wrong.
 */
export function anchorIndex(candles: readonly Candle[], now: number): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i]!.closeTime < now) return i;
  }
  return -1;
}

/**
 * Place the Screener's patterns onto this chart's bars.
 *
 * Returns nothing at all when the snapshot has no row for this instrument and
 * timeframe — an absent row means the Screener does not track this pair, not
 * that the pair has no patterns, and inventing marks from the chart's own bars
 * is precisely what this module exists to avoid.
 */
export function placePatterns(
  snapshot: Snapshot | null,
  symbol: string,
  timeframe: Resolution,
  candles: readonly Candle[],
  now: number
): PlacedPattern[] {
  if (!snapshot || candles.length === 0) return [];
  const row = findRow(snapshot, symbol, timeframe);
  if (!row) return [];
  const patterns = row.patterns ?? [];
  const anchor = anchorIndex(candles, now);
  if (anchor < 0) return [];

  const out: PlacedPattern[] = [];
  for (const pattern of patterns) {
    const index = anchor - Math.max(0, Math.trunc(pattern.bars_ago));
    // A pattern older than the chart's own window has no bar to sit on. Better
    // to omit it than to clamp it onto the first bar, where it would claim a
    // pattern formed on a bar it did not.
    if (index < 0 || index >= candles.length) continue;
    out.push({ pattern, index, time: Math.floor(candles[index]!.openTime / 1000) });
  }
  return out;
}

/**
 * Find the Screener row for this instrument and timeframe.
 *
 * Matched through the canonical instrument resolver rather than by string
 * equality: the Screener names pairs `SOL/USDT` and the chart names them
 * `SOLUSDT`, and comparing those directly would silently never match.
 */
function findRow(
  snapshot: Snapshot, symbol: string, timeframe: Resolution
): { patterns?: CandlePattern[] } | null {
  const rows = (snapshot as unknown as {
    rows?: { symbol?: string; market?: { native_symbol?: string | null; config_symbol?: string };
      timeframe?: string; indicators?: { candles?: { patterns?: CandlePattern[] } } }[];
  }).rows ?? [];
  for (const row of rows) {
    if (row.timeframe !== timeframe) continue;
    const candidates = [
      row.market?.native_symbol ?? undefined,
      row.market?.config_symbol,
      row.symbol?.replace("/", ""),
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    if (candidates.some((c) => sameInstrument(c, symbol))) {
      return row.indicators?.candles ?? null;
    }
  }
  return null;
}

/** Chart markers for placed patterns, coloured by the direction they claim. */
export function patternMarkers(placed: readonly PlacedPattern[]): ChartMarker[] {
  return placed.map(({ pattern, time }) => ({
    time,
    position: pattern.direction === "bear" ? "aboveBar" : "belowBar",
    color: pattern.direction === "bull" ? "#2ebd85"
      : pattern.direction === "bear" ? "#f6465d" : "#8b93a7",
    // The name, and how textbook the example is. `strength` is comparable
    // within a pattern and only loosely across patterns — the Screener says so
    // itself, so the label does not present it as a score.
    text: `${pattern.name} · ${(pattern.strength * 100).toFixed(0)}%`,
    shape: pattern.direction === "bull" ? "arrowUp"
      : pattern.direction === "bear" ? "arrowDown" : "circle",
  }));
}

/**
 * What the reader is owed about this overlay, or null when nothing is.
 *
 * Three separate truths, and each of them changes what the marks mean:
 * whether the Screener tracks this pair at all, that its window is recent
 * rather than complete, and that the strengths measure textbook-ness rather
 * than a prediction.
 */
export function overlayNotice(
  snapshot: Snapshot | null, placed: readonly PlacedPattern[], symbol: string
): string | null {
  if (!snapshot) {
    return "The Screener has not answered, so no patterns are shown. Nothing is inferred from the chart's own bars.";
  }
  if (placed.length === 0) {
    return `The Screener reports no recent pattern for ${symbol} on this timeframe.`;
  }
  return "The Screener's own recent window — these are the patterns it is reporting now, " +
    "not every pattern in the chart's history.";
}
