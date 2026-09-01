import type { IndicatorKey, ScreenerRow } from "./types";

export type CellKind =
  | "number" | "signed" | "int" | "category" | "bool" | "text" | "price" | "adaptive";

/** Which strategy slot a column reads from. `null` = not timeframe-scoped. */
export type Slot = "1h" | "15m" | "5m" | null;

export interface ColumnSpec {
  id: string;
  group: string;
  /** Slot this column's value came from — drives the staleness and hover stamp. */
  slot: Slot;
  /** Only for columns still reading the single-timeframe `indicators` block. */
  indicator: IndicatorKey | null;
  header: string;
  title?: string;
  kind: CellKind;
  digits?: number;
  /** |value| at which the diverging colour saturates. Ignored when colorMode is "sign". */
  saturateAt?: number;
  /** "magnitude" scales colour by size; "sign" colours by side of zero only. */
  colorMode?: "magnitude" | "sign";
  hiddenByDefault?: boolean;
  accessor: (row: ScreenerRow) => unknown;
}

/** Read `row.mtf[slot][indicator][field]`. */
const m = (slot: Exclude<Slot, null>, indicator: string, field: string) =>
  (row: ScreenerRow): unknown => {
    const block = row.mtf?.[slot]?.[indicator];
    if (!block || typeof block !== "object") return null;
    return (block as Record<string, unknown>)[field] ?? null;
  };

const ind = (row: ScreenerRow, key: IndicatorKey, field: string): unknown =>
  row.indicators[key]?.[field] ?? null;

export const GROUPS = [
  "Symbol", "Strategy", "EMA", "RSI", "MACD", "VFI", "ADX", "VWAP",
  "Candles", "Supertrend", "S&R", "Pivots",
] as const;
export type GroupName = (typeof GROUPS)[number];

/**
 * Groups whose timeframe is fixed by the strategy config rather than chosen per
 * group. The old per-group selector cannot express "1h and 15m and 5m at once",
 * which is the whole point of the new layout, so those groups no longer carry
 * one — the three slots are set once, in the toolbar.
 */
export const GROUP_INDICATOR: Partial<Record<GroupName, IndicatorKey>> = {
  Candles: "candles",
};

const SLOTS = ["1h", "15m", "5m"] as const;

export const COLUMNS: ColumnSpec[] = [
  // --- Symbol (sticky) ---------------------------------------------
  { id: "symbol", group: "Symbol", slot: null, indicator: null, header: "Symbol",
    kind: "text", accessor: (r) => r.symbol },
  { id: "price", group: "Symbol", slot: null, indicator: null, header: "Price",
    kind: "price", accessor: (r) => r.price },
  { id: "change_24h", group: "Symbol", slot: null, indicator: null, header: "24h %",
    title: "Change over the last 24 hours of closed bars",
    kind: "signed", digits: 2, saturateAt: 8, accessor: (r) => r.change_24h_pct },

  // --- Strategy ------------------------------------------------------
  { id: "mtf_bias", group: "Strategy", slot: null, indicator: null, header: "Bias",
    title: "Which side more of the checklist currently favours. Not a signal on its own.",
    kind: "category", accessor: (r) => r.strategy?.bias ?? null },
  { id: "mtf_setup", group: "Strategy", slot: null, indicator: null, header: "Setup",
    title: "Every required rule on all three timeframes passes. Blank means it does not.",
    kind: "category", accessor: (r) => r.strategy?.setup ?? null },
  { id: "mtf_bull_pct", group: "Strategy", slot: null, indicator: null, header: "Bull %",
    title: "Share of the 20 required conditions passing for a long, right now. "
         + "A count of current conditions — not a probability and not a forecast.",
    kind: "number", digits: 1, accessor: (r) => r.strategy?.bullish_pct ?? null },
  { id: "mtf_bear_pct", group: "Strategy", slot: null, indicator: null, header: "Bear %",
    title: "Share of the 20 required conditions passing for a short, right now. "
         + "A count of current conditions — not a probability and not a forecast.",
    kind: "number", digits: 1, accessor: (r) => r.strategy?.bearish_pct ?? null },
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `mtf_${slot}`, group: "Strategy", slot, indicator: null, header: slot,
    title: `Required rules passing on ${slot}, for the side shown in Bias.`,
    kind: "number", digits: 0,
    accessor: (r) => {
      const st = r.strategy;
      if (!st) return null;
      const side = st.bias === "bear" ? st.bear : st.bull;
      return side.timeframes[slot]?.passed ?? null;
    },
  })),

  // --- EMA: 1h full ladder, 15m and 5m the 200 only ------------------
  ...[21, 50, 100, 200].map<ColumnSpec>((n) => ({
    id: `ema_1h_${n}`, group: "EMA", slot: "1h", indicator: null,
    header: `1h ${n}%`,
    title: `Signed distance from the 1h ${n} EMA, in percent. Negative = price below.`,
    kind: "signed", digits: 2, saturateAt: 6,
    accessor: m("1h", "ema", `dist_pct_${n}`),
  })),
  { id: "ema_1h_stack", group: "EMA", slot: "1h", indicator: null, header: "1h Stack",
    title: "bull = 21>50>100>200, bear = the reverse, mixed = neither",
    kind: "category", accessor: m("1h", "ema", "stack") },
  { id: "ema_15m_200", group: "EMA", slot: "15m", indicator: null, header: "15m 200%",
    title: "Signed distance from the 15m 200 EMA, in percent.",
    kind: "signed", digits: 2, saturateAt: 4, accessor: m("15m", "ema", "dist_pct_200") },
  { id: "ema_15m_stack", group: "EMA", slot: "15m", indicator: null, header: "15m Stack",
    kind: "category", accessor: m("15m", "ema", "stack") },
  { id: "ema_5m_200", group: "EMA", slot: "5m", indicator: null, header: "5m 200%",
    title: "Signed distance from the 5m 200 EMA, in percent.",
    kind: "signed", digits: 2, saturateAt: 3, accessor: m("5m", "ema", "dist_pct_200") },

  // --- RSI(50) with state, per timeframe -----------------------------
  ...SLOTS.flatMap<ColumnSpec>((slot) => [
    { id: `rsi_${slot}`, group: "RSI", slot, indicator: null, header: `${slot} RSI`,
      title: `RSI(50) on ${slot}. Length 50, matching the strategy — not the 14 used elsewhere.`,
      kind: "number", digits: 1, accessor: m(slot, "rsi", "rsi") },
    { id: `rsi_state_${slot}`, group: "RSI", slot, indicator: null, header: `${slot} St`,
      title: "oversold <30, neutral, overbought >70",
      kind: "category", accessor: m(slot, "rsi", "state") },
  ]),

  // --- MACD line, per timeframe --------------------------------------
  // Shown as a percent of price. The raw line is a difference of two EMAs and so
  // carries the price's units — about 366 on BTC and 0.00064 on a sub-cent coin.
  // No decimal setting renders both readably, and comparing them is meaningless
  // anyway. Dividing by price keeps the sign and the shape and makes every coin
  // land in the same legible range. The raw value stays a click away under
  // "More columns", and is on the cell's hover text.
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `macd_${slot}`, group: "MACD", slot, indicator: null, header: `${slot} MACD%`,
    title: `MACD line on ${slot}, as a percent of price. Positive means the line `
         + `is above zero. Normalised so the column is readable and comparable `
         + `across coins — the raw line is in price units.`,
    kind: "signed", digits: 3, colorMode: "sign",
    accessor: m(slot, "macd", "macd_pct"),
  })),
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `macd_raw_${slot}`, group: "MACD", slot, indicator: null,
    header: `${slot} raw`,
    title: `Raw MACD line on ${slot}, in price units.`,
    kind: "adaptive", colorMode: "sign", hiddenByDefault: true,
    accessor: m(slot, "macd", "macd"),
  })),

  // --- VFI, 5m only --------------------------------------------------
  { id: "vfi_5m", group: "VFI", slot: "5m", indicator: null, header: "5m VFI",
    title: "VFI line on 5m. Colour shows which side of zero it is on.",
    kind: "adaptive", colorMode: "sign", accessor: m("5m", "vfi", "vfi") },
  { id: "vfi_5m_signal", group: "VFI", slot: "5m", indicator: null, header: "5m Sig",
    title: "VFI signal line on 5m", kind: "adaptive", hiddenByDefault: true,
    accessor: m("5m", "vfi", "vfima") },

  // --- ADX, 5m only --------------------------------------------------
  { id: "adx_5m", group: "ADX", slot: "5m", indicator: null, header: "5m ADX",
    kind: "number", digits: 1, accessor: m("5m", "adx", "adx") },
  { id: "adx_5m_plus", group: "ADX", slot: "5m", indicator: null, header: "5m +DI",
    kind: "number", digits: 1, accessor: m("5m", "adx", "plus_di") },
  { id: "adx_5m_minus", group: "ADX", slot: "5m", indicator: null, header: "5m −DI",
    kind: "number", digits: 1, accessor: m("5m", "adx", "minus_di") },
  { id: "adx_5m_regime", group: "ADX", slot: "5m", indicator: null, header: "Regime",
    title: "ranging <20, transitional 20–25, trending >25",
    kind: "category", hiddenByDefault: true, accessor: m("5m", "adx", "regime") },

  // --- VWAP, 5m ------------------------------------------------------
  { id: "vwap_5m_bias", group: "VWAP", slot: "5m", indicator: null, header: "5m Bias",
    title: "Close above the 5m session VWAP reads bullish, below reads bearish.",
    kind: "category", accessor: m("5m", "vwap", "bias") },
  { id: "vwap_5m_pct", group: "VWAP", slot: "5m", indicator: null, header: "5m %",
    title: "Signed distance from the 5m session VWAP, in percent.",
    kind: "signed", digits: 2, saturateAt: 1.5, accessor: m("5m", "vwap", "dist_pct") },

  // --- Candles (unchanged; reads its own configured timeframe) -------
  { id: "candles_top", group: "Candles", slot: null, indicator: "candles", header: "Pattern",
    title: "Most recent pattern within the lookback. Expand the row for the full list.",
    kind: "text", accessor: (r) => ind(r, "candles", "top_pattern") },
  { id: "candles_bias", group: "Candles", slot: null, indicator: "candles", header: "Bias",
    title: "Conflicting patterns on the same bar cancel to none — never a majority vote.",
    kind: "category", accessor: (r) => ind(r, "candles", "net_bias") },

  // --- Supertrend, per timeframe -------------------------------------
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `st_${slot}`, group: "Supertrend", slot, indicator: null, header: slot,
    title: `Supertrend direction on ${slot}.`,
    kind: "category",
    accessor: (r) => {
      const dir = m(slot, "supertrend", "direction")(r);
      return typeof dir === "number" ? (dir === 1 ? "bull" : "bear") : null;
    },
  })),
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `st_bars_${slot}`, group: "Supertrend", slot, indicator: null,
    header: `${slot} bars`, title: `Bars since the ${slot} Supertrend last flipped.`,
    kind: "int", hiddenByDefault: true,
    accessor: m(slot, "supertrend", "bars_since_flip"),
  })),

  // --- S&R: distance to the support zone, per timeframe --------------
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `sr_sup_${slot}`, group: "S&R", slot, indicator: null, header: `${slot} Sup%`,
    title: `How far price sits above the nearest ${slot} support zone, in percent. `
         + `Smaller is closer. Blank when no surviving support sits below price.`,
    kind: "number", digits: 2,
    accessor: m(slot, "sr", "dist_to_support_pct"),
  })),
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `sr_res_${slot}`, group: "S&R", slot, indicator: null, header: `${slot} Res%`,
    title: `Distance to the nearest ${slot} resistance zone, in percent.`,
    kind: "number", digits: 2, hiddenByDefault: true,
    accessor: m(slot, "sr", "dist_to_resistance_pct"),
  })),

  // --- Pivot Points Standard (Fibonacci), per timeframe --------------
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `pivot_${slot}`, group: "Pivots", slot, indicator: null, header: `${slot} %`,
    title: `Signed distance to the nearest Fibonacci pivot level on ${slot}. `
         + `Negative means price is below it. 5m and 15m anchor to the previous day, `
         + `1h to the previous week, following the built-in's Auto rule.`,
    kind: "signed", digits: 2, saturateAt: 2,
    accessor: m(slot, "pivots", "nearest_dist_pct"),
  })),
  ...SLOTS.map<ColumnSpec>((slot) => ({
    id: `pivot_name_${slot}`, group: "Pivots", slot, indicator: null, header: `${slot} Lvl`,
    title: `Which Fibonacci pivot level is nearest on ${slot} (P, R1–R3, S1–S3).`,
    kind: "text",
    accessor: m(slot, "pivots", "nearest"),
  })),
];

export const CATEGORY_OPTIONS: Record<string, string[]> = {
  mtf_bias: ["bull", "bear", "none"],
  mtf_setup: ["bull", "bear"],
  ema_1h_stack: ["bull", "bear", "mixed"],
  ema_15m_stack: ["bull", "bear", "mixed"],
  rsi_state_1h: ["oversold", "neutral", "overbought"],
  rsi_state_15m: ["oversold", "neutral", "overbought"],
  rsi_state_5m: ["oversold", "neutral", "overbought"],
  adx_5m_regime: ["ranging", "transitional", "trending"],
  vwap_5m_bias: ["bull", "bear"],
  candles_bias: ["bull", "bear", "none"],
  st_1h: ["bull", "bear"],
  st_15m: ["bull", "bear"],
  st_5m: ["bull", "bear"],
};

