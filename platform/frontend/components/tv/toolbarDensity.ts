/*
 * Split out of `ChartToolbar.tsx` so it can be imported by a test.
 *
 * It has to live under `components/` — tailwind.config.ts scans only
 * `./app` and `./components`, so a breakpoint literal written anywhere else
 * emits no CSS — but it does not have to live inside a client component
 * that pulls in React and thirty other modules. `lib/toolbarLayout` holds
 * the same rule as arithmetic (`TOOLBAR_OVERFLOW_FROM`);
 * `tests/chartToolbar.test.ts` pins every literal below against it.
 */
import type { OverflowControlId } from "@/lib/toolbarLayout";

/** Where one control is drawn: on the row from its width up, in the ⋯ menu below it. */
export interface ToolbarTier {
  /** The class on the control's row copy. */
  row: string;
  /** The class on its copy inside the ⋯ menu — always the exact mirror of `row`. */
  menu: string;
}

/**
 * The progressive-overflow tiers, as class names.
 *
 * TVP8 had ONE collapse decision: below `xl` the whole right-hand cluster —
 * layout, saved layout, quick search, settings, fullscreen, snapshot, Trade —
 * left the row at once and reappeared in a second 38px row under ⋯. So at 1200
 * the bar lost its seven most-used workspace controls to make room it did not
 * need, while at 768 the LEFT side still did not fit and Undo, Redo and ⋯
 * itself ran off the edge with no way to reach them.
 *
 * Each control now leaves the row on its own, lowest priority first, at the
 * width below which it no longer fits beside everything ranked above it, and
 * from then on is a row of the ⋯ menu. The numbers and the reasoning are
 * `TOOLBAR_OVERFLOW_FROM` in `lib/toolbarLayout`; these are the same numbers
 * as Tailwind literals (a class built from a template would emit no CSS).
 */
export const TOOLBAR_TIERS: Readonly<Record<OverflowControlId, ToolbarTier>> = {
  compare: { row: "hidden sm:flex", menu: "flex sm:hidden" },
  indicators: { row: "hidden min-[680px]:flex", menu: "flex min-[680px]:hidden" },
  trade: { row: "hidden min-[760px]:flex", menu: "flex min-[760px]:hidden" },
  chartSettings: { row: "hidden min-[800px]:flex", menu: "flex min-[800px]:hidden" },
  snapshot: { row: "hidden min-[840px]:flex", menu: "flex min-[840px]:hidden" },
  layout: { row: "hidden min-[880px]:flex", menu: "flex min-[880px]:hidden" },
  savedLayouts: { row: "hidden min-[1000px]:flex", menu: "flex min-[1000px]:hidden" },
  sync: { row: "hidden min-[1000px]:flex", menu: "flex min-[1000px]:hidden" },
  alert: { row: "hidden min-[1060px]:flex", menu: "flex min-[1060px]:hidden" },
  replay: { row: "hidden min-[1060px]:flex", menu: "flex min-[1060px]:hidden" },
  templates: { row: "hidden min-[1120px]:flex", menu: "flex min-[1120px]:hidden" },
  undo: { row: "hidden min-[1200px]:flex", menu: "flex min-[1200px]:hidden" },
  redo: { row: "hidden min-[1200px]:flex", menu: "flex min-[1200px]:hidden" },
  fullscreen: { row: "hidden min-[1240px]:flex", menu: "flex min-[1240px]:hidden" },
  commandPalette: { row: "hidden min-[1280px]:flex", menu: "flex min-[1280px]:hidden" },
};

/**
 * The row's separators, each shown exactly while BOTH of its neighbours are.
 *
 * A separator whose neighbour has gone to the menu is a hairline beside
 * nothing, so each one carries the tier of the later of the two to appear.
 */
export const TOOLBAR_SEPARATOR_TIERS = {
  /** compare │ interval │ style │ indicators — all on the row from `sm`. */
  context: "hidden sm:inline-block",
  /** indicators │ alert · replay. */
  beforeAlert: "hidden min-[1060px]:inline-block",
  /** … replay │ undo · redo. */
  beforeUndo: "hidden min-[1200px]:inline-block",
  /** layout · saved layout · sync │ quick search · settings · fullscreen · snapshot. */
  beforeUtilities: "hidden min-[880px]:inline-block",
} as const;
