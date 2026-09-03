/**
 * Chart workspace geometry.
 *
 * ── Why this is data and not components ────────────────────────────────────
 *
 * The workspace used to be a boolean: one chart, or one chart with a second
 * one bolted to its right. Growing that to sixteen by writing sixteen React
 * layouts would multiply every future chart change by the number of shapes it
 * can be arranged in. So a preset is a *description* of a CSS grid — how many
 * columns and rows, and which cell each pane occupies — and exactly one layout
 * component renders all of them.
 *
 * Two constructors cover everything the product needs:
 *
 *   `packed`  — rows of equal panes ([4,4,4,4] is a 4×4). The column count is
 *               the least common multiple of the row widths, so rows with
 *               different pane counts still line up on one grid.
 *   `explicit`— hand-placed cells, for the asymmetric "one big, several small"
 *               shapes that a row description cannot express.
 *
 * Adding a shape is adding a line to `LAYOUT_PRESETS`.
 */

/** The architectural ceiling. Sixteen 280×160 panes still fit a laptop screen. */
export const MAX_PANES = 16;

/** One pane's position on the preset's grid. 1-based, like CSS grid lines. */
export interface PaneCell {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface LayoutPreset {
  /** Stable persisted identifier. Never reuse one for a different geometry. */
  id: string;
  /** What the layout selector shows. */
  label: string;
  /** How many panes this preset holds. Always `cells.length`. */
  panes: number;
  cols: number;
  rows: number;
  cells: readonly PaneCell[];
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}

/**
 * A preset built from row widths: `[2, 3]` is two panes above three.
 *
 * Every pane in a row is the same width, and the grid is wide enough for all
 * rows at once, which is what keeps a 2-over-3 layout from needing fractional
 * columns.
 */
function packed(id: string, label: string, rowCounts: number[]): LayoutPreset {
  const cols = rowCounts.reduce(lcm, 1);
  const cells: PaneCell[] = [];
  rowCounts.forEach((count, rowIndex) => {
    const span = cols / count;
    for (let i = 0; i < count; i++) {
      cells.push({ col: i * span + 1, row: rowIndex + 1, colSpan: span, rowSpan: 1 });
    }
  });
  return { id, label, panes: cells.length, cols, rows: rowCounts.length, cells };
}

function explicit(
  id: string, label: string, cols: number, rows: number, cells: PaneCell[]
): LayoutPreset {
  return { id, label, panes: cells.length, cols, rows, cells };
}

const cell = (col: number, row: number, colSpan = 1, rowSpan = 1): PaneCell =>
  ({ col, row, colSpan, rowSpan });

/**
 * Every shape the workspace offers, ordered by pane count.
 *
 * The first preset for a given count is that count's default — what clicking
 * "4" in the selector gives you before choosing a variant.
 */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  packed("1", "Single", [1]),

  packed("2-cols", "Two columns", [2]),
  packed("2-rows", "Two rows", [1, 1]),

  packed("3-cols", "Three columns", [3]),
  packed("3-rows", "Three rows", [1, 1, 1]),
  explicit("3-left", "One left, two right", 2, 2,
    [cell(1, 1, 1, 2), cell(2, 1), cell(2, 2)]),
  explicit("3-top", "One top, two below", 2, 2,
    [cell(1, 1, 2, 1), cell(1, 2), cell(2, 2)]),

  packed("4-grid", "Grid 2 × 2", [2, 2]),
  packed("4-cols", "Four columns", [4]),
  packed("4-rows", "Four rows", [1, 1, 1, 1]),
  explicit("4-left", "One left, three right", 2, 3,
    [cell(1, 1, 1, 3), cell(2, 1), cell(2, 2), cell(2, 3)]),
  explicit("4-top", "One top, three below", 3, 2,
    [cell(1, 1, 3, 1), cell(1, 2), cell(2, 2), cell(3, 2)]),

  packed("5-grid", "Five — two over three", [2, 3]),
  explicit("5-left", "One left, four right", 2, 4,
    [cell(1, 1, 1, 4), cell(2, 1), cell(2, 2), cell(2, 3), cell(2, 4)]),

  packed("6-grid", "Grid 3 × 2", [3, 3]),
  packed("6-tall", "Grid 2 × 3", [2, 2, 2]),

  packed("7-grid", "Seven — four over three", [4, 3]),

  packed("8-grid", "Grid 4 × 2", [4, 4]),
  packed("8-tall", "Grid 2 × 4", [2, 2, 2, 2]),

  packed("9-grid", "Grid 3 × 3", [3, 3, 3]),

  packed("10-grid", "Grid 5 × 2", [5, 5]),

  packed("11-grid", "Eleven — four, four, three", [4, 4, 3]),

  packed("12-grid", "Grid 4 × 3", [4, 4, 4]),

  packed("13-grid", "Thirteen — five, four, four", [5, 4, 4]),

  packed("14-grid", "Fourteen — five, five, four", [5, 5, 4]),

  packed("15-grid", "Grid 5 × 3", [5, 5, 5]),

  packed("16-grid", "Grid 4 × 4", [4, 4, 4, 4]),
] as const;

const BY_ID = new Map(LAYOUT_PRESETS.map((p) => [p.id, p]));

/** The single-pane preset — the safe fallback for anything unrecognised. */
export const DEFAULT_PRESET_ID = "1";

export function isLayoutPresetId(value: unknown): value is string {
  return typeof value === "string" && BY_ID.has(value);
}

/** The preset, or `null` when the id is unknown. Callers decide the fallback. */
export function findPreset(id: string): LayoutPreset | null {
  return BY_ID.get(id) ?? null;
}

/** The preset, falling back to the single pane rather than throwing. */
export function presetOrDefault(id: string): LayoutPreset {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_PRESET_ID)!;
}

/** Every preset with exactly this many panes, in declaration order. */
export function presetsForCount(count: number): LayoutPreset[] {
  return LAYOUT_PRESETS.filter((p) => p.panes === count);
}

/** Pane counts the selector can offer, ascending. */
export function availablePaneCounts(): number[] {
  return [...new Set(LAYOUT_PRESETS.map((p) => p.panes))].sort((a, b) => a - b);
}

/**
 * The preset to use for a pane count — the first declared for it.
 *
 * Every count from one to sixteen has an exact preset, which is what lets
 * closing a pane pick a shape for what is left without the caller checking.
 * The fallback below is for an out-of-range count only.
 */
export function defaultPresetFor(count: number): LayoutPreset {
  const exact = presetsForCount(count)[0];
  if (exact) return exact;
  const fitting = LAYOUT_PRESETS.filter((p) => p.panes <= count);
  return fitting[fitting.length - 1] ?? presetOrDefault(DEFAULT_PRESET_ID);
}

/** Inline style for the grid container. */
export function presetGridStyle(preset: LayoutPreset): {
  gridTemplateColumns: string;
  gridTemplateRows: string;
} {
  return {
    gridTemplateColumns: `repeat(${preset.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${preset.rows}, minmax(0, 1fr))`,
  };
}

/** Inline style placing one pane in its cell. */
export function cellGridStyle(cellAt: PaneCell): {
  gridColumn: string;
  gridRow: string;
} {
  return {
    gridColumn: `${cellAt.col} / span ${cellAt.colSpan}`,
    gridRow: `${cellAt.row} / span ${cellAt.rowSpan}`,
  };
}

/**
 * How much chrome a pane at this size can afford.
 *
 * Measured from the smallest usable chart in the audit — roughly 280×160 — and
 * stepped from there. The identity of the instrument is never dropped: a pane
 * you might be about to trade from has to say what it is at every size.
 */
export type PaneDensity = "large" | "medium" | "small" | "tiny";

export function paneDensity(width: number, height: number): PaneDensity {
  if (width >= 640 && height >= 380) return "large";
  if (width >= 420 && height >= 260) return "medium";
  if (width >= 280 && height >= 160) return "small";
  return "tiny";
}

/**
 * An estimate of one pane's size, for choosing density before a pane has been
 * measured. Spans are honoured so a dominant pane is not treated as a small one.
 */
export function estimatePaneSize(
  preset: LayoutPreset, cellAt: PaneCell, workspace: { width: number; height: number }
): { width: number; height: number } {
  return {
    width: (workspace.width / preset.cols) * cellAt.colSpan,
    height: (workspace.height / preset.rows) * cellAt.rowSpan,
  };
}
