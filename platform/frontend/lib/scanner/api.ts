import type { Calibration, Snapshot } from "./types";
import type { PatternAnalysis, PatternCatalog } from "../candleOverlay";
import type { Candle } from "../types";
import type { ClassicalAnalysis, ClassicalCatalog } from "../classicalPatterns";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* retain safe status */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function symbolPath(symbol: string): string {
  return symbol.split("/").map((asset) => encodeURIComponent(asset)).join("/");
}

export const api = {
  screener: () => request<Snapshot>("/api/scanner"),
  health: () => request<Record<string, unknown>>("/api/scanner/health"),
  patternCatalog: () => request<PatternCatalog>("/api/scanner/patterns/catalog"),
  analyzePatterns: (input: {
    symbol: string; timeframe: string; asOf: number; candles: readonly Candle[];
    settings?: Record<string, unknown>;
  }) => request<PatternAnalysis>("/api/scanner/patterns/analyze", {
    method: "POST",
    body: JSON.stringify({
      venue: "BINANCE", market_type: "spot", symbol: input.symbol.replace(/^BINANCE:/, ""),
      timeframe: input.timeframe, as_of: input.asOf,
      candles: input.candles.slice(-2_000).map((bar) => ({
        open_time: bar.openTime, open: bar.open, high: bar.high, low: bar.low,
        close: bar.close, close_time: bar.closeTime,
      })),
      ...(input.settings ? { settings: input.settings } : {}),
    }),
  }),
  classicalCatalog: () => request<ClassicalCatalog>("/api/scanner/classical-patterns/catalog"),
  analyzeClassical: (input: {
    symbol: string; timeframe: string; asOf: number; candles: readonly Candle[];
    settings?: Record<string, unknown>;
  }) => request<ClassicalAnalysis>("/api/scanner/classical-patterns/analyze", {
    method: "POST",
    body: JSON.stringify({
      venue: "BINANCE", market_type: "spot", symbol: input.symbol.replace(/^BINANCE:/, ""),
      timeframe: input.timeframe, as_of: input.asOf,
      candles: input.candles.slice(-600).map((bar) => ({
        open_time: bar.openTime, open: bar.open, high: bar.high, low: bar.low,
        close: bar.close, close_time: bar.closeTime,
      })),
      ...(input.settings ? { settings: input.settings } : {}),
    }),
  }),
  patchConfig: (patch: unknown) => request<{ config: unknown; refresh: unknown }>(
    "/api/scanner/config", { method: "PATCH", body: JSON.stringify(patch) }),
  refresh: (force = false) => request<Record<string, unknown>>(
    `/api/scanner/refresh?force=${force}`, { method: "POST" }),
  addSymbol: (symbol: string) => request<{ symbol: string }>("/api/scanner/symbols", {
    method: "POST", body: JSON.stringify({ symbol }),
  }),
  removeSymbol: (symbol: string) => request<{ symbol: string }>(
    `/api/scanner/symbols/${symbolPath(symbol)}`, { method: "DELETE" }),
  calibrate: (symbol: string) => request<Calibration>(
    `/api/scanner/calibrate/${symbolPath(symbol)}`, { method: "POST" }),
  calibration: (symbol: string) => request<Calibration>(`/api/scanner/calibration/${symbolPath(symbol)}`),
  presets: () => request<{ presets: Record<string, unknown> }>("/api/scanner/presets"),
  savePreset: (name: string) => request<{ name: string }>("/api/scanner/presets", {
    method: "POST", body: JSON.stringify({ name }),
  }),
  loadPreset: (name: string) => request<{ name: string }>(
    `/api/scanner/presets/${encodeURIComponent(name)}/load`, { method: "POST" }),
  deletePreset: (name: string) => request<{ name: string }>(
    `/api/scanner/presets/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
