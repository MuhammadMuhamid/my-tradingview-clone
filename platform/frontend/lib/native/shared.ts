"use client";
/**
 * The plumbing every built-in study definition needs.
 *
 * Extracted from `tier1.ts` when the catalog grew past one file. Nothing here
 * is maths — that is `lib/ta/core` — and nothing here is policy. These are the
 * small, repeated pieces of a `NativeStudyDef`: reading a parameter that might
 * be missing or the wrong type, turning candles into the arrays the core takes,
 * the source input every study offers, and the palette.
 *
 * They live in one module so that "what colour is an overlay's second band"
 * and "what does a study do with a corrupt `length`" have one answer across
 * sixty definitions rather than sixty.
 */
import { hl2, hlc3, ohlc4 } from "@/lib/ta/core";
import type { NativeParams, PriceSource } from "@/lib/native/registry";
import type { Candle } from "@/lib/types";

// ── the palette ─────────────────────────────────────────────────────────────
//
// Six colours, because a chart with a study on it is already busy and a
// per-study hue would make the pane a rainbow. Direction is UP/DOWN; a single
// line is ACCENT; a second and third line are AMBER and VIOLET; MUTED is for
// a band edge, a fill or a zero line — something present but not the subject.

export const UP = "#2ebd85";
export const DOWN = "#f6465d";
export const ACCENT = "#4f8cff";
export const AMBER = "#f0b90b";
export const VIOLET = "#9b7cf5";
export const MUTED = "#8b93a7";

// ── reading parameters ──────────────────────────────────────────────────────
//
// Total by construction. `normalizeParams` has already coerced anything a
// dialog or a stored layout supplied, but a definition must still be safe when
// called directly — a study that threw on a missing key would take the chart
// down rather than draw nothing.

export const num = (params: NativeParams, key: string, fallback: number): number => {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};
export const str = (params: NativeParams, key: string, fallback: string): string => {
  const v = params[key];
  return typeof v === "string" ? v : fallback;
};
export const bool = (params: NativeParams, key: string, fallback: boolean): boolean => {
  const v = params[key];
  return typeof v === "boolean" ? v : fallback;
};

// ── candles into arrays ─────────────────────────────────────────────────────

/** Resolve a named price source against the bars. One place, every study. */
export function resolveSource(candles: readonly Candle[], source: string): number[] {
  const open = candles.map((c) => c.open);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  switch (source as PriceSource) {
    case "open": return open;
    case "high": return high;
    case "low": return low;
    case "hl2": return hl2(high, low);
    case "hlc3": return hlc3(high, low, close);
    case "ohlc4": return ohlc4(open, high, low, close);
    default: return close;
  }
}

export const ohlcv = (candles: readonly Candle[]) => ({
  open: candles.map((c) => c.open),
  high: candles.map((c) => c.high),
  low: candles.map((c) => c.low),
  close: candles.map((c) => c.close),
  volume: candles.map((c) => c.volume),
});

// ── inputs a study reuses ───────────────────────────────────────────────────

export const sourceInput = {
  kind: "source", key: "source", title: "Source", defval: "close",
} as const;

export const lengthInput = (defval: number, title = "Length") =>
  ({ kind: "number", key: "length", title, defval, min: 1, max: 5000, integer: true } as const);

/**
 * The zero line, for the many oscillators that have one.
 *
 * A shared constant rather than a repeated literal because it is a statement
 * about what the pane MEANS — above zero and below zero are the two states an
 * oscillator like this reports — and because a study that drew its zero in a
 * different grey from the one beside it would read as two different things.
 */
export const zeroLevel = {
  id: "zero", title: "0", value: 0, color: MUTED, dashed: true,
} as const;

export const MA_TYPE_OPTIONS = [
  { value: "SMA", label: "SMA" },
  { value: "EMA", label: "EMA" },
  { value: "RMA", label: "RMA (Wilder)" },
  { value: "WMA", label: "WMA" },
  { value: "HMA", label: "HMA" },
  { value: "VWMA", label: "VWMA" },
  { value: "DEMA", label: "DEMA" },
  { value: "TEMA", label: "TEMA" },
] as const;
