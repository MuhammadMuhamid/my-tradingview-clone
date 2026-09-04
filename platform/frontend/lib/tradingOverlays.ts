import type { Candle } from "./types";

export type TradingOverlaySource = "MANUAL" | "AUTOMATED" | "PAPER";
export type TradingOverlayEnvironment = "REAL" | "PAPER" | "TESTNET" | "DRY_RUN" | "UNKNOWN";
export type TradingOverlayKind = "HISTORICAL_ACTIVITY_MARKER" | "REALIZATION_MARKER"
  | "PAPER_FILL_MARKER" | "ACTIVE_ORDER_LINE" | "POSITION_LINE";

export interface TradingOverlayItem {
  id: string; kind: TradingOverlayKind;
  evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT" | "CURRENT_AUTHORITATIVE_STATE";
  evidenceKind: string; source: TradingOverlaySource; environment: TradingOverlayEnvironment;
  symbol: string; side: "BUY" | "SELL" | null; eventTime: string | null;
  observedAt: string | null; price: number; quantity: number | null; state: string | null;
  orderType: string | null; completeness: "COMPLETE" | "INCOMPLETE"; detail: string;
  identifiers: Record<string, string>;
  provenance: {
    deploymentId: string | null;
    strategy: { id: string; key: string | null; name: string | null } | null;
    config: { id: string; name: string | null } | null;
  };
}

export interface TradingOverlayResponse {
  symbol: string;
  range: { from: string; to: string; replayCutoff: string | null };
  items: TradingOverlayItem[]; truncated: boolean; limit: number; limitations: string[];
}

export interface TradingOverlayPreferences {
  activity: boolean; activeOrders: boolean; positions: boolean;
  manual: boolean; automated: boolean; paper: boolean;
}

export const DEFAULT_OVERLAY_PREFERENCES: TradingOverlayPreferences = {
  activity: true, activeOrders: true, positions: true,
  manual: true, automated: true, paper: true,
};
const STORAGE_KEY = "tv.tradingOverlays.v1";

export function loadOverlayPreferences(): TradingOverlayPreferences {
  if (typeof window === "undefined") return DEFAULT_OVERLAY_PREFERENCES;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(DEFAULT_OVERLAY_PREFERENCES).map(([key, fallback]) =>
      [key, typeof value[key] === "boolean" ? value[key] : fallback])) as unknown as TradingOverlayPreferences;
  } catch { return DEFAULT_OVERLAY_PREFERENCES; }
}

export function saveOverlayPreferences(value: TradingOverlayPreferences): void {
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function overlayItemVisible(item: TradingOverlayItem, value: TradingOverlayPreferences): boolean {
  if (item.source === "MANUAL" && !value.manual) return false;
  if (item.source === "AUTOMATED" && !value.automated) return false;
  if (item.source === "PAPER" && !value.paper) return false;
  if (item.kind === "ACTIVE_ORDER_LINE") return value.activeOrders;
  if (item.kind === "POSITION_LINE") return value.positions;
  return value.activity;
}

export function compactOverlaySource(item: TradingOverlayItem): string {
  const source = item.source === "MANUAL" ? "M" : item.source === "AUTOMATED" ? "A" : "P";
  return `${source}·${item.environment}`;
}

export interface AnchoredTradingOverlay extends TradingOverlayItem { anchorTime: number }

/**
 * Attach an event only to the loaded candle whose actual [open, close] interval
 * contains it. A gap or out-of-window event stays absent; it is never shifted.
 */
export function anchorTradingOverlays(
  items: readonly TradingOverlayItem[], candles: readonly Candle[]
): AnchoredTradingOverlay[] {
  if (candles.length === 0) return [];
  const output: AnchoredTradingOverlay[] = [];
  for (const item of items) {
    if (!item.eventTime) continue;
    const eventTime = Date.parse(item.eventTime);
    if (!Number.isFinite(eventTime)) continue;
    let low = 0; let high = candles.length - 1; let found = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candle = candles[mid]!;
      if (eventTime < candle.openTime) high = mid - 1;
      else if (eventTime > candle.closeTime) low = mid + 1;
      else { found = mid; break; }
    }
    if (found < 0) continue;
    output.push({ ...item, anchorTime: candles[found]!.openTime / 1000 });
  }
  return output;
}

export interface OverlayRange { from: number; to: number }
export const MAX_OVERLAY_RANGE_MS = 366 * 86_400_000;

/** Visible range with a ten-bar guard, clipped to actual loaded candle bounds. */
export function requestedOverlayRange(
  candles: readonly Candle[], visible: { from: number; to: number } | null,
  intervalMs: number, replayCutoff: number | null,
): OverlayRange | null {
  if (candles.length === 0) return null;
  const loadedFrom = candles[0]!.openTime;
  const loadedTo = replayCutoff === null ? candles[candles.length - 1]!.closeTime
    : Math.min(candles[candles.length - 1]!.closeTime, replayCutoff);
  const padding = intervalMs * 10;
  let from = visible ? Math.floor(visible.from * 1000) - padding : Math.max(loadedFrom, loadedTo - MAX_OVERLAY_RANGE_MS);
  let to = visible ? Math.ceil(visible.to * 1000) + intervalMs + padding : loadedTo;
  from = Math.max(loadedFrom, from); to = Math.min(loadedTo, to);
  if (to - from > MAX_OVERLAY_RANGE_MS) from = to - MAX_OVERLAY_RANGE_MS;
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
}

export function overlayRequestKey(input: {
  symbol: string; from: number; to: number; replayCutoff: number | null; scope: string;
}): string {
  return `${input.symbol}|${input.from}|${input.to}|${input.replayCutoff ?? "live"}|${input.scope}`;
}

export function overlayChartContextKey(
  symbol: string, interval: string, replayCutoff: number | null
): string {
  return `${symbol}|${interval}|${replayCutoff ?? "live"}`;
}

export class TradingOverlayCache {
  private values = new Map<string, TradingOverlayResponse>();
  constructor(private readonly maxEntries = 24) {}
  get(key: string): TradingOverlayResponse | undefined { return this.values.get(key); }
  set(key: string, value: TradingOverlayResponse): void {
    this.values.delete(key); this.values.set(key, value);
    while (this.values.size > this.maxEntries) this.values.delete(this.values.keys().next().value!);
  }
  get size(): number { return this.values.size; }
}

export function splitOverlayResponse(response: TradingOverlayResponse): {
  historical: TradingOverlayResponse; current: TradingOverlayResponse;
} {
  const currentKinds = new Set<TradingOverlayKind>(["ACTIVE_ORDER_LINE", "POSITION_LINE"]);
  return {
    historical: { ...response, items: response.items.filter((item) => !currentKinds.has(item.kind)) },
    current: { ...response, items: response.items.filter((item) => currentKinds.has(item.kind)) },
  };
}

export function mergeOverlayResponses(
  historical: TradingOverlayResponse | null, current: TradingOverlayResponse | null
): TradingOverlayResponse | null {
  if (!historical && !current) return null;
  const base = historical ?? current!;
  return { ...base, items: [...(historical?.items ?? []), ...(current?.items ?? [])],
    truncated: Boolean(historical?.truncated || current?.truncated),
    limitations: [...new Set([...(historical?.limitations ?? []), ...(current?.limitations ?? [])])] };
}
