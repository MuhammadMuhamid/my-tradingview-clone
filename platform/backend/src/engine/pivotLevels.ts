/**
 * Pivot point levels from a completed period's high, low, close and open.
 *
 * Shared by the built-in "Pivot Points Standard" indicator and by pivot alerts,
 * so a level an alert fires on is by construction the level the chart drew —
 * two implementations of the same arithmetic would eventually disagree, and the
 * user would be told price reached a line that is not where they can see it.
 *
 * Fibonacci is the type the user works from. It defines P and three levels
 * either side; S4/S5 and R4/R5 do not exist for it, which is why the level list
 * is per-type rather than a fixed eleven.
 *
 * ── Why this file is now a re-export ───────────────────────────────────────
 *
 * "By construction" used to mean "the browser has no pivot code at all", which
 * held only while the chart drew no pivots. Wave C draws them, so the
 * arithmetic moved verbatim into `src/ta/core.ts` — the canonical layer
 * mirrored byte for byte into the browser — and this module re-exports it.
 * Every existing importer is untouched, and `tests/taParity.test.ts` asserts
 * the two names are the same function object rather than two that agree today.
 */
export {
  PIVOT_TYPES, isPivotType, pivotLevels, nearestLevel, levelByName,
  type PivotType, type Period, type PivotLevel,
} from "../ta/core";
