/** Exact-bar view models for the canonical server-side candlestick detector. */
import type { ChartMarker } from "@/components/CandleChart";
import type { Candle } from "@/lib/types";

export const CANDLE_OVERLAY_KEY = "tv.candleOverlay.v2";

export type PatternDirection = "bull" | "bear" | "none";

export interface PatternCatalogItem {
  id: string;
  name: string;
  direction: PatternDirection;
  bars: number;
  confirmation: "bar_close";
  predictive_claim: false;
}

export interface PatternOccurrence extends PatternCatalogItem {
  strength: number;
  basis: string;
  open_time: number;
  confirmed_at: number;
  detector_id: string;
  detector_version: string;
  settings_hash: string;
}

export interface PatternCatalog {
  detector_id: string;
  detector_version: string;
  catalog_observed_at: string;
  confirmation: "bar_close";
  causal: true;
  predictive_claim: false;
  settings: Record<string, unknown>;
  settings_hash: string;
  patterns: PatternCatalogItem[];
}

export interface PatternAnalysis extends Omit<PatternCatalog, "patterns"> {
  catalog_size: number;
  input_end_open_time: number | null;
  patterns: PatternOccurrence[];
  source: {
    venue: "BINANCE";
    market_type: "spot";
    symbol: string;
    timeframe: string;
    ohlc: string;
    as_of: number;
    closed_bars_analyzed: number;
    forming_bars_excluded: number;
  };
}

export interface PlacedPattern {
  pattern: PatternOccurrence;
  index: number;
  time: number;
}

/** Place only against an exact source open-time; never infer or clamp a bar. */
export function placePatterns(
  analysis: PatternAnalysis | null,
  candles: readonly Candle[],
  selectedIds: ReadonlySet<string> | null = null,
): PlacedPattern[] {
  if (!analysis || candles.length === 0) return [];
  const byOpen = new Map(candles.map((bar, index) => [bar.openTime, index]));
  const out: PlacedPattern[] = [];
  for (const pattern of analysis.patterns) {
    if (selectedIds && !selectedIds.has(pattern.id)) continue;
    const index = byOpen.get(pattern.open_time);
    if (index === undefined) continue;
    out.push({ pattern, index, time: Math.floor(pattern.open_time / 1000) });
  }
  return out;
}

export function patternMarkers(placed: readonly PlacedPattern[]): ChartMarker[] {
  return placed.map(({ pattern, time }) => ({
    time,
    position: pattern.direction === "bear" ? "aboveBar" : "belowBar",
    color: pattern.direction === "bull" ? "#2ebd85"
      : pattern.direction === "bear" ? "#f6465d" : "#9c9c9c",
    text: `${pattern.name} · ${(pattern.strength * 100).toFixed(0)}% fit`,
    shape: pattern.direction === "bull" ? "arrowUp"
      : pattern.direction === "bear" ? "arrowDown" : "circle",
  }));
}

export function overlayNotice(
  analysis: PatternAnalysis | null, loading: boolean, error: string | null, symbol: string,
): string {
  if (loading) return `Analyzing completed ${symbol} bars…`;
  if (error) return `Candlestick analysis unavailable: ${error}`;
  if (!analysis) return "Candlestick analysis has not run.";
  if (analysis.patterns.length === 0) return `No recognized formation in the loaded completed ${symbol} bars.`;
  return `${analysis.patterns.length} formations on exact completed bars. Geometric recognition is not a return forecast.`;
}

/** Research-ready JSON retains the complete version/settings/source envelope. */
export function patternExportJson(analysis: PatternAnalysis): string {
  return `${JSON.stringify(analysis, null, 2)}\n`;
}

function csv(value: unknown): string {
  const valueText = value === null || value === undefined ? "" : String(value);
  return `"${valueText.replaceAll('"', '""')}"`;
}

/** One row per exact occurrence; provenance is repeated so rows remain portable. */
export function patternExportCsv(analysis: PatternAnalysis): string {
  const header = [
    "venue", "market_type", "symbol", "timeframe", "open_time", "confirmed_at",
    "pattern_id", "pattern_name", "direction", "bars", "strength_geometric_fit",
    "confirmation", "detector_id", "detector_version", "settings_hash", "settings_json",
    "ohlc_provenance", "predictive_claim",
  ];
  const rows = analysis.patterns.map((p) => [
    analysis.source.venue, analysis.source.market_type, analysis.source.symbol,
    analysis.source.timeframe, p.open_time, p.confirmed_at, p.id, p.name, p.direction,
    p.bars, p.strength, p.confirmation, p.detector_id, p.detector_version, p.settings_hash,
    JSON.stringify(analysis.settings), analysis.source.ohlc, false,
  ]);
  return [header, ...rows].map((row) => row.map(csv).join(",")).join("\n") + "\n";
}
