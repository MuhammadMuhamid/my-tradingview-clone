"use client";
/**
 * Two published TradingView scripts as built-in studies, drawn as the scripts
 * draw them and computed by the SAME functions the alert runner fires on
 * (`marketStructure` and `liquiditySwings` in `lib/ta/core`):
 *
 *   Market Structure Break & Order Block (EmreKb, "MSB-OB")
 *   Liquidity Swings [LuxAlgo]
 *
 * Defaults are the owner's TradingView settings, not the scripts' published
 * ones, where they differ: MSB-OB keeps old/broken boxes; Liquidity Swings
 * uses a 20-bar lookback and the full-range area.
 */
import type { PineDrawings } from "@/lib/api";
import type { NativeStudyDef } from "@/lib/native/registry";
import { bool, num, str } from "@/lib/native/shared";
import { liquiditySwings, marketStructure, type MsbZoneKind } from "@/lib/ta/core";
import type { Candle } from "@/lib/types";
import { resolutionMs, type Resolution } from "@/lib/resolution";

/** Bar index → chart time in seconds, extrapolated past the last bar. */
function timeOf(candles: readonly Candle[], interval: Resolution) {
  const step = resolutionMs(interval);
  const last = candles.length - 1;
  return (i: number): number => {
    const k = Math.round(i);
    if (k >= 0 && k <= last) return Math.floor(candles[k]!.openTime / 1000);
    if (k < 0) return Math.floor((candles[0]!.openTime + k * step) / 1000);
    return Math.floor((candles[last]!.openTime + (k - last) * step) / 1000);
  };
}

const ohlc = (candles: readonly Candle[]) => ({
  open: candles.map((c) => c.open), high: candles.map((c) => c.high),
  low: candles.map((c) => c.low), close: candles.map((c) => c.close),
  volume: candles.map((c) => c.volume),
});

const keepLast = <T>(items: T[], max: number): T[] => (items.length > max ? items.slice(-max) : items);

// ── MSB-OB ──────────────────────────────────────────────────────────────────

const G_SETTINGS = "Settings";
const G_MSB = "MSB Lines";
const G_BU_OB = "Bu-OB Display Settings";
const G_BE_OB = "Be-OB Display Settings";
const G_BU_BB = "Bu-BB & Bu-MB Display Settings";
const G_BE_BB = "Be-BB & Be-MB Display Settings";

const TEXT_SIZES = [
  { value: "tiny", label: "tiny" }, { value: "small", label: "small" },
  { value: "normal", label: "normal" }, { value: "large", label: "large" }, { value: "huge", label: "huge" },
];

// Pine's color.green / color.red, and `color.new(_, 70)` as an alpha.
const GREEN = "#4caf50";
const RED = "#f23645";
const GREEN_70 = "#4caf504d";
const RED_70 = "#f236454d";

const zoneInputs = (prefix: string, group: string, fill: string, line: string) => [
  { kind: "color" as const, key: `${prefix}Color`, title: "Color", defval: fill, group },
  { kind: "color" as const, key: `${prefix}Border`, title: "Border Color", defval: line, group },
  { kind: "color" as const, key: `${prefix}Text`, title: "Text Color", defval: line, group },
];

const ZONE_PREFIX: Record<MsbZoneKind, string> = { bu_ob: "buOb", be_ob: "beOb", bu_bb: "buBb", be_bb: "beBb" };

export const msbObStudy: NativeStudyDef = {
  id: "msb_ob",
  name: "Market Structure Break & Order Block",
  aliases: ["msb", "msb-ob", "order block", "market structure", "emrekb", "breaker block"],
  category: "levels",
  overlay: true,
  description: "Zig-zag market structure breaks, with the order block and breaker block each break leaves.",
  inputs: [
    { kind: "number", key: "zigzagLength", title: "ZigZag Length", defval: 9, min: 1, max: 500, integer: true, group: G_SETTINGS },
    { kind: "boolean", key: "showZigzag", title: "Show Zigzag", defval: true, group: G_SETTINGS },
    { kind: "number", key: "fibFactor", title: "Fib Factor for breakout confirmation", defval: 0.33, min: 0, max: 1, step: 0.01, integer: false, group: G_SETTINGS },
    { kind: "select", key: "textSize", title: "Text Size", defval: "tiny", options: TEXT_SIZES, group: G_SETTINGS },
    { kind: "boolean", key: "deleteBoxes", title: "Delete Old/Broken Boxes", defval: false, group: G_SETTINGS },
    { kind: "color", key: "zigzagColor", title: "Zigzag Color", defval: "#2962ff", group: G_MSB },
    { kind: "color", key: "msbBullColor", title: "Bullish MSB Color", defval: GREEN, group: G_MSB },
    { kind: "color", key: "msbBearColor", title: "Bearish MSB Color", defval: RED, group: G_MSB },
    { kind: "number", key: "msbWidth", title: "MSB Line Width", defval: 2, min: 1, max: 4, integer: true, group: G_MSB },
    ...zoneInputs("buOb", G_BU_OB, GREEN_70, GREEN),
    ...zoneInputs("beOb", G_BE_OB, RED_70, RED),
    ...zoneInputs("buBb", G_BU_BB, GREEN_70, GREEN),
    ...zoneInputs("beBb", G_BE_BB, RED_70, RED),
  ],
  plots: [],
  precision: null,
  warmup: () => 0,
  unbounded: true,
  compute: ({ candles, params, interval }) => ({
    plots: {},
    drawings: drawMsbOb(candles, interval, params),
  }),
};

export function drawMsbOb(
  candles: readonly Candle[], interval: Resolution, params: Parameters<typeof num>[0],
): PineDrawings {
  const out: PineDrawings = { lines: [], boxes: [], labels: [], tables: [] };
  if (candles.length === 0) return out;
  const { open, high, low, close } = ohlc(candles);
  const ms = marketStructure(open, high, low, close,
    Math.round(num(params, "zigzagLength", 9)), num(params, "fibFactor", 0.33));
  const t = timeOf(candles, interval);
  const textSize = str(params, "textSize", "tiny");
  const width = Math.round(num(params, "msbWidth", 2));

  if (bool(params, "showZigzag", true)) {
    const color = str(params, "zigzagColor", "#2962ff");
    for (const z of ms.zigzag) {
      out.lines.push({ x1: t(z.x1), y1: z.y1, x2: t(z.x2), y2: z.y2, color, width: 1, style: "solid", extend: "none" });
    }
  }
  for (const b of ms.breaks) {
    if (![b.x1, b.x2, b.price].every(Number.isFinite)) continue;
    const color = b.direction === 1 ? str(params, "msbBullColor", GREEN) : str(params, "msbBearColor", RED);
    out.lines.push({ x1: t(b.x1), y1: b.price, x2: t(b.x2), y2: b.price, color, width, style: "solid", extend: "none" });
    out.labels.push({
      x: t(b.labelX), y: b.price, text: "MSB", color: "", textColor: color,
      style: b.direction === 1 ? "style_label_down" : "style_label_up", size: "small",
    });
  }
  // max_lines_count = 500: the oldest go first.
  out.lines = keepLast(out.lines, 500);

  const deleteBroken = bool(params, "deleteBoxes", false);
  for (const z of ms.zones) {
    if (deleteBroken && z.removed !== null) continue;
    if (![z.top, z.bottom].every(Number.isFinite)) continue;
    const p = ZONE_PREFIX[z.kind];
    const line = str(params, `${p}Border`, z.kind.startsWith("bu") ? GREEN : RED);
    out.boxes.push({
      left: t(z.left), top: z.top, right: t(z.right), bottom: z.bottom,
      borderColor: line, borderWidth: 1, borderStyle: "solid",
      bgColor: str(params, `${p}Color`, z.kind.startsWith("bu") ? GREEN_70 : RED_70),
      text: z.text, textColor: str(params, `${p}Text`, line),
      textHalign: "align_right", textValign: "center", textSize, extend: "none",
    });
  }
  out.boxes = keepLast(out.boxes, 500);
  return out;
}

// ── Liquidity Swings [LuxAlgo] ─────────────────────────────────────────────

const G_STYLE = "Style";

/** Pine's `format.volume`: 3695981 → "3.696M". */
export function formatVolume(v: number): string {
  const a = Math.abs(v);
  const [div, suffix] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  return `${Number((v / div).toFixed(3))}${suffix}`;
}

export const liquiditySwingsStudy: NativeStudyDef = {
  id: "liquidity_swings",
  name: "Liquidity Swings [LuxAlgo]",
  aliases: ["liquidity", "liquidity swings", "luxalgo", "swing high", "swing low"],
  category: "levels",
  overlay: true,
  description: "Swing highs and lows as liquidity levels, with the area each swing left and the volume traded through it.",
  inputs: [
    { kind: "number", key: "length", title: "Pivot Lookback", defval: 20, min: 1, max: 500, integer: true },
    {
      kind: "select", key: "area", title: "Swing Area", defval: "full",
      options: [{ value: "wick", label: "Wick Extremity" }, { value: "full", label: "Full Range" }],
    },
    {
      kind: "select", key: "filterBy", title: "Filter Areas By", defval: "count",
      options: [{ value: "count", label: "Count" }, { value: "volume", label: "Volume" }],
    },
    { kind: "number", key: "filterValue", title: "Filter Value", defval: 0, min: 0, max: 1e15, integer: false },
    { kind: "boolean", key: "showTop", title: "Swing High", defval: true, group: G_STYLE },
    { kind: "color", key: "topColor", title: "Swing High Color", defval: RED, group: G_STYLE },
    { kind: "color", key: "topArea", title: "Swing High Area", defval: "#f2364580", group: G_STYLE },
    { kind: "boolean", key: "showBtm", title: "Swing Low", defval: true, group: G_STYLE },
    { kind: "color", key: "btmColor", title: "Swing Low Color", defval: "#089981", group: G_STYLE },
    { kind: "color", key: "btmArea", title: "Swing Low Area", defval: "#08998180", group: G_STYLE },
    {
      kind: "select", key: "labelSize", title: "Labels Size", defval: "tiny", group: G_STYLE,
      options: [{ value: "tiny", label: "Tiny" }, { value: "small", label: "Small" }, { value: "normal", label: "Normal" }],
    },
  ],
  plots: [],
  precision: null,
  warmup: () => 0,
  unbounded: true,
  compute: ({ candles, params, interval }) => ({
    plots: {},
    drawings: drawLiquiditySwings(candles, interval, params),
  }),
};

/** `color.new(c, 80)`: the same colour at 20% opacity. */
const at80 = (c: string): string => `${c.slice(0, 7)}33`;

export function drawLiquiditySwings(
  candles: readonly Candle[], interval: Resolution, params: Parameters<typeof num>[0],
): PineDrawings {
  const out: PineDrawings = { lines: [], boxes: [], labels: [], tables: [] };
  const n = candles.length;
  if (n === 0) return out;
  const { open, high, low, close, volume } = ohlc(candles);
  const L = Math.round(num(params, "length", 20));
  const res = liquiditySwings(open, high, low, close, volume, L, str(params, "area", "full") === "wick" ? "wick" : "full");
  const t = timeOf(candles, interval);
  const byVolume = str(params, "filterBy", "count") === "volume";
  const fv = num(params, "filterValue", 0);
  const size = str(params, "labelSize", "tiny");
  const last = n - 1;

  for (const side of ["high", "low"] as const) {
    const shown = bool(params, side === "high" ? "showTop" : "showBtm", true);
    if (!shown) continue;
    const css = str(params, side === "high" ? "topColor" : "btmColor", side === "high" ? RED : "#089981");
    const areaCss = str(params, side === "high" ? "topArea" : "btmArea", side === "high" ? "#f2364580" : "#08998180");
    const swings = res.swings.filter((s) => s.side === side);
    swings.forEach((s, k) => {
      const next = swings[k + 1];
      const target = (bar: number) => (byVolume ? s.volumeAt.get(bar) : s.countAt.get(bar)) ?? 0;
      const bars = [...s.countAt.keys()];
      const qualified = bars.some((b) => target(b) > fv);
      const top = side === "high" ? s.level : s.edge;
      const bottom = side === "high" ? s.edge : s.level;

      // The level: live to the right until a close beyond it, then dashed and
      // stopped at the crossing bar; superseded uncrossed levels stop at the
      // next swing's pivot. Coloured only once the filter has been passed.
      if (qualified) {
        const x2 = s.crossed !== null ? s.crossed : next ? next.x : last + 3;
        out.lines.push({
          x1: t(s.x), y1: s.level, x2: t(x2), y2: s.level, color: css, width: 1,
          style: s.crossed !== null ? "dashed" : "solid", extend: "none",
        });
        const lastQualified = Math.max(...bars.filter((b) => target(b) > fv));
        const count = s.countAt.get(lastQualified) ?? s.count;
        out.boxes.push({
          left: t(s.x), top, right: t(s.x + count), bottom,
          borderColor: "", borderWidth: 0, borderStyle: "solid", bgColor: areaCss,
          text: "", textColor: css, textHalign: "center", textValign: "center", textSize: "auto", extend: "none",
        });
        out.labels.push({
          x: t(s.x), y: s.level, text: formatVolume(s.volumeAt.get(lastQualified) ?? s.volume),
          color: "", textColor: css, style: side === "high" ? "style_label_down" : "style_label_up", size,
        });
      }
      // The one translucent area box the script keeps, for the latest swing.
      if (!next) {
        out.boxes.push({
          left: t(s.x), top, right: t(s.crossed !== null ? s.x : last + 3), bottom,
          borderColor: "", borderWidth: 0, borderStyle: "solid", bgColor: at80(areaCss),
          text: "", textColor: css, textHalign: "center", textValign: "center", textSize: "auto", extend: "none",
        });
      }
    });
  }
  out.lines = keepLast(out.lines, 500);
  out.boxes = keepLast(out.boxes, 500);
  out.labels = keepLast(out.labels, 500);
  return out;
}
