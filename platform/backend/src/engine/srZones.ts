/**
 * Pivot-based support and resistance zones.
 *
 * The shape follows the Flux Charts "Support & Resistance (MTF)" indicator the
 * user works from: a swing high becomes a resistance, a swing low becomes a
 * support, a level dies when price closes through it, and levels that sit on
 * top of each other are merged rather than stacked.
 *
 * ── Confirmation, and why it matters here ──
 * A pivot at bar `i` is only a pivot once `length` further bars have printed
 * without exceeding it. So at bar `t` the newest usable pivot is at `t -
 * length`, never at `t`. Treating a pivot as known on the bar it forms would
 * make every backtest and every alert read the future — the zone would appear
 * before the market could have shown it. `zonesAsOf` enforces the delay.
 *
 * ── Why this file is now a re-export ───────────────────────────────────────
 *
 * The chart draws these zones in Wave C, and an S/R alert names the zone it
 * fired on. So the implementation moved verbatim into `src/ta/core.ts`, which
 * is mirrored byte for byte into the browser; this module re-exports it and
 * every existing importer is untouched.
 *
 * The one rename: `atr` here is a merge tolerance seeded from the first bar,
 * not the volatility reading `core.ts` already exported under that name, so it
 * is `srMergeAtr` there and is re-exported under its original name for the
 * callers and the tests that know it.
 */
export {
  buildZones, zonesAsOf, nearestZones, isPivotHigh, isPivotLow,
  srMergeAtr as atr, DEFAULT_SR_OPTIONS,
  type Zone, type ZoneKind, type SrOptions, type Bars,
} from "../ta/core";
