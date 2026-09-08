/** View models and exact time/price geometry for the canonical P3 detector. */
import type { ChartMarker } from "@/components/CandleChart";
import type { ChartOverlay } from "@/lib/chartSeries";
import type { Candle } from "@/lib/types";

export type ClassicalDirection = "bull" | "bear" | "both";
export type ClassicalState = "developing" | "completed";
export type ClassicalStatus = "developing" | "awaiting" | "reached" | "failed";

export interface ClassicalCatalogItem {
  id: string;
  name: string;
  family: string;
  direction: ClassicalDirection;
  confirmation: "close";
  pivot_basis: "confirmed_5_5";
  target_basis: "measured_move";
  predictive_claim: false;
}

export interface ClassicalAnchor {
  index: number;
  open_time: number;
  price: number;
  kind: "high" | "low";
  confirmed_at_index: number;
  confirmed_at: number;
}

export interface BoundaryPoint { index: number; open_time: number; price: number }
export interface ClassicalBoundary { start: BoundaryPoint; end: BoundaryPoint }
export interface ClassicalEvent {
  index: number; open_time: number; confirmed_at: number; price?: number;
}

export interface ClassicalOccurrence extends ClassicalCatalogItem {
  occurrence_id: string;
  anchors: ClassicalAnchor[];
  start_index: number;
  end_index: number;
  detected_at_index: number;
  detected_open_time: number;
  detected_at: number;
  state: ClassicalState;
  status: ClassicalStatus;
  breakout: (ClassicalEvent & { direction: "bull" | "bear"; price: number }) | null;
  invalidation: { price: number; basis: string; triggered: ClassicalEvent | null };
  target: ({ price: number; direction: "bull" | "bear"; basis: string; reached: ClassicalEvent | null }) | null;
  boundaries: { upper: ClassicalBoundary | null; lower: ClassicalBoundary | null };
  quality: Record<string, number> & { score: number };
  detector_id: string;
  detector_version: string;
  settings_hash: string;
}

export interface ClassicalCatalog {
  detector_id: string;
  detector_version: string;
  catalog_observed_at: string;
  search_horizon_bars: number;
  confirmation: "close";
  pivot_confirmation: { left_bars: number; right_bars: number };
  causal: true;
  predictive_claim: false;
  settings: Record<string, unknown>;
  settings_hash: string;
  patterns: ClassicalCatalogItem[];
}

export interface ClassicalAnalysis extends Omit<ClassicalCatalog, "patterns"> {
  catalog_size: number;
  input_end_open_time: number | null;
  patterns: ClassicalOccurrence[];
  source: {
    venue: "BINANCE"; market_type: "spot"; symbol: string; timeframe: string;
    ohlc: string; as_of: number; closed_bars_analyzed: number; forming_bars_excluded: number;
  };
}

const STATUS_COLOR: Record<ClassicalStatus, string> = {
  developing: "#9aa4b6", awaiting: "#4f8cff", reached: "#2ebd85", failed: "#f6465d",
};

function exactTimes(candles: readonly Candle[]): Set<number> {
  return new Set(candles.map((bar) => bar.openTime));
}

function lineData(boundary: ClassicalBoundary, known: ReadonlySet<number>) {
  const points = [boundary.start, boundary.end]
    .filter((point) => known.has(point.open_time))
    .map((point) => ({ time: Math.floor(point.open_time / 1000), value: point.price }));
  return points.length === 2 && points[0]!.time < points[1]!.time ? points : [];
}

/** Draw only server-returned points that exactly belong to this source window. */
export function classicalOverlays(
  analysis: ClassicalAnalysis | null,
  candles: readonly Candle[],
  selected: ReadonlySet<string> | null,
  showTargets: boolean,
): ChartOverlay[] {
  if (!analysis || candles.length === 0) return [];
  const known = exactTimes(candles);
  const last = candles[candles.length - 1]!.openTime;
  const overlays: ChartOverlay[] = [];
  for (const pattern of analysis.patterns) {
    if (selected && !selected.has(pattern.id)) continue;
    const color = STATUS_COLOR[pattern.status];
    const anchors = pattern.anchors
      .filter((anchor) => known.has(anchor.open_time))
      .map((anchor) => ({ time: Math.floor(anchor.open_time / 1000), value: anchor.price }));
    if (anchors.length >= 2) overlays.push({
      id: `classical:${pattern.occurrence_id}:price`,
      title: `${pattern.name} · ${pattern.status}`,
      color, width: 2, paneId: "price", data: anchors,
    });
    for (const [side, boundary] of Object.entries(pattern.boundaries)) {
      if (!boundary) continue;
      const data = lineData(boundary, known);
      if (data.length === 2) overlays.push({
        id: `classical:${pattern.occurrence_id}:${side}`,
        title: `${pattern.name} ${side}`,
        color, width: 1, lineStyle: pattern.state === "developing" ? "dotted" : "solid",
        paneId: "price", data,
      });
    }
    if (showTargets && pattern.target && pattern.breakout
      && known.has(pattern.breakout.open_time) && pattern.breakout.open_time < last) {
      overlays.push({
        id: `classical:${pattern.occurrence_id}:target`,
        title: `${pattern.name} target · ${pattern.status}`,
        color, width: 1, lineStyle: "dashed", paneId: "price",
        data: [
          { time: Math.floor(pattern.breakout.open_time / 1000), value: pattern.target.price },
          { time: Math.floor(last / 1000), value: pattern.target.price },
        ],
      });
    }
  }
  return overlays;
}

export function classicalMarkers(
  analysis: ClassicalAnalysis | null, selected: ReadonlySet<string> | null,
): ChartMarker[] {
  if (!analysis) return [];
  return analysis.patterns.flatMap((pattern) => {
    if (selected && !selected.has(pattern.id)) return [];
    const event = pattern.breakout ?? { open_time: pattern.detected_open_time };
    return [{
      id: `classical:${pattern.occurrence_id}`,
      time: Math.floor(event.open_time / 1000),
      position: pattern.direction === "bear" ? "aboveBar" as const : "belowBar" as const,
      color: STATUS_COLOR[pattern.status],
      text: `${pattern.name} · ${pattern.status} · ${(pattern.quality.score * 100).toFixed(0)}% geometry`,
      shape: pattern.breakout
        ? (pattern.breakout.direction === "bull" ? "arrowUp" as const : "arrowDown" as const)
        : "circle" as const,
    }];
  });
}

export function classicalNotice(
  analysis: ClassicalAnalysis | null, loading: boolean, error: string | null, symbol: string,
): string {
  if (loading) return `Scanning the last 600 completed ${symbol} bars for classical patterns…`;
  if (error) return `Classical pattern analysis unavailable: ${error}`;
  if (!analysis) return "Classical pattern analysis has not run.";
  if (!analysis.patterns.length) return `No qualifying classical pattern in the loaded completed ${symbol} bars.`;
  const developing = analysis.patterns.filter((item) => item.state === "developing").length;
  return `${analysis.patterns.length} classical patterns; ${developing} developing. Targets are measured geometry, not forecasts.`;
}

export const classicalExportJson = (analysis: ClassicalAnalysis): string =>
  `${JSON.stringify(analysis, null, 2)}\n`;

function csv(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

/** Portable one-row-per-occurrence Research export with causal timestamps. */
export function classicalExportCsv(analysis: ClassicalAnalysis): string {
  const header = [
    "venue", "market_type", "symbol", "timeframe", "occurrence_id", "pattern_id",
    "pattern_name", "family", "direction", "state", "status", "detected_at",
    "breakout_open_time", "breakout_direction", "target_price", "target_reached_at",
    "invalidation_price", "invalidated_at", "quality_score", "quality_json", "anchors_json",
    "detector_id", "detector_version", "settings_hash", "settings_json", "ohlc_provenance",
    "predictive_claim",
  ];
  const rows = analysis.patterns.map((pattern) => [
    analysis.source.venue, analysis.source.market_type, analysis.source.symbol,
    analysis.source.timeframe, pattern.occurrence_id, pattern.id, pattern.name, pattern.family,
    pattern.direction, pattern.state, pattern.status, pattern.detected_at,
    pattern.breakout?.open_time, pattern.breakout?.direction, pattern.target?.price,
    pattern.target?.reached?.open_time, pattern.invalidation.price,
    pattern.invalidation.triggered?.open_time, pattern.quality.score,
    JSON.stringify(pattern.quality), JSON.stringify(pattern.anchors), pattern.detector_id,
    pattern.detector_version, pattern.settings_hash, JSON.stringify(analysis.settings),
    analysis.source.ohlc, false,
  ]);
  return [header, ...rows].map((row) => row.map(csv).join(",")).join("\n") + "\n";
}
