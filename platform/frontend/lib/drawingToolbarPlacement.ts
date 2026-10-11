/**
 * Where the selected drawing's floating toolbar goes (A11).
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The bar was placed 44px above the drawing's FIRST anchor, left-aligned on
 * it. A trend line that rises to the right rises straight into that box: on
 * the measured chart the bar sat at y516–562 over a line at y≈540, so the
 * click or right-click meant for the line landed on a button — right-click
 * gave no Drawing menu, and a click on the line toggled a style instead.
 *
 * The reference never covers the drawing with its toolbar. So the rule here
 * is not "44px above a point" but "a box that touches nothing the drawing
 * draws": above the drawing's extent first, below it second, then beside it,
 * then docked at the top of the pane, each clamped inside the pane, and the
 * first candidate that neither overlaps the anchors' box nor comes within
 * reach of the drawn geometry wins.
 *
 * Plain arithmetic over a distance function, so `tests/drawingToolbar.test.ts`
 * runs in node. The caller passes the same `distToDrawing` its hit-testing
 * uses, so "overlaps the drawing" means what clicking on the drawing means —
 * including the parts an anchor box misses: a ray running off to the right,
 * an extended line, a vertical line the full height of the pane.
 */

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Placement { left: number; top: number }

/** Clearance between the bar and the drawing, and between the bar and the pane edge. */
export const TOOLBAR_GAP = 8;
const EDGE = 4;
/** The drawn handles are ~4.5px; a little more so a handle is never under the bar. */
const HANDLE_MARGIN = 8;
/** How close the bar may come to the drawn geometry: the hit radius, and a pixel. */
const REACH = 8;
/** Sample spacing over the candidate box, in px. */
const STEP = 6;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** A box in pane pixels, edges rather than size — the shape `avoid` takes. */
export interface Box { left: number; top: number; right: number; bottom: number }

export interface PlacementOptions {
  /**
   * W2A-05: where the user DRAGGED the bar, if they have.
   *
   * The reference's bar has a drag handle and stays where it is put. This one
   * is placed so it never covers the drawing (A11), and a dragged position is
   * not allowed to undo that by accident: it is used for any drawing it does
   * not cover, and otherwise the automatic placement runs as before. `force`
   * is the one exception — the drawing the bar was dropped beside, where the
   * user has just seen exactly where it went and chose it.
   */
  preferred?: { at: Placement; force?: boolean };
  /**
   * W2D-03: boxes the bar must not sit on — the pane's legend column.
   *
   * A drawing near the top of the pane sent the bar to the docked-at-the-top
   * candidate, which is exactly where the series and study legends are; their
   * OHLC text ran through its buttons, and a right-click on it reached the
   * study row underneath. A box here is an obstacle like the drawing itself,
   * and its bottom edge is a candidate row, so the bar docks just under the
   * legend rather than over it.
   */
  avoid?: readonly Box[];
}

/**
 * The first box, in pane coordinates, that keeps the bar off the drawing.
 *
 * `anchors` are the drawing's anchor points in pane pixels; `distance`, when
 * given, is the pixel distance from a point to what the drawing actually
 * draws. A pane too small for any clear candidate gets the first one that at
 * least keeps off the `avoid` boxes, and failing that the first one at all —
 * a bar over the drawing is better than no bar.
 */
export function toolbarPlacement(
  anchors: readonly Point[],
  bar: Size,
  pane: Size,
  distance?: (p: Point) => number,
  options: PlacementOptions = {},
): Placement {
  const avoid = options.avoid ?? [];
  const finite = anchors.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const xs = finite.map((p) => p.x);
  const ys = finite.map((p) => p.y);
  const box = finite.length === 0
    ? { left: pane.width / 2, right: pane.width / 2, top: pane.height / 2, bottom: pane.height / 2 }
    : {
        left: Math.min(...xs) - HANDLE_MARGIN, right: Math.max(...xs) + HANDLE_MARGIN,
        top: Math.min(...ys) - HANDLE_MARGIN, bottom: Math.max(...ys) + HANDLE_MARGIN,
      };
  const maxLeft = Math.max(EDGE, pane.width - bar.width - EDGE);
  const maxTop = Math.max(EDGE, pane.height - bar.height - EDGE);

  const tops = [
    box.top - TOOLBAR_GAP - bar.height, // above the drawing
    box.bottom + TOOLBAR_GAP, // below it
    EDGE, // docked at the top of the pane
    ...avoid.map((b) => b.bottom + TOOLBAR_GAP), // or just under the legend
    maxTop, // and the bottom
  ];
  const lefts = [
    box.left, // aligned with the drawing's left edge
    box.right - bar.width, // its right edge
    box.right + TOOLBAR_GAP, // clear of it on the right
    box.left - TOOLBAR_GAP - bar.width, // on the left
    ...avoid.map((b) => b.right + TOOLBAR_GAP), // beside the legend
    EDGE, maxLeft,
  ];

  const offLegend = (left: number, top: number): boolean => avoid.every((b) =>
    !(left + bar.width > b.left && left < b.right && top + bar.height > b.top && top < b.bottom));
  const clear = (left: number, top: number): boolean => {
    const right = left + bar.width;
    const bottom = top + bar.height;
    if (right > box.left && left < box.right && bottom > box.top && top < box.bottom) return false;
    if (!offLegend(left, top)) return false;
    if (!distance) return true;
    for (let y = top; y <= bottom + 0.01; y += Math.min(STEP, bar.height / 2)) {
      for (let x = left; x <= right + 0.01; x += STEP) {
        if (distance({ x, y }) < REACH) return false;
      }
    }
    return true;
  };

  if (options.preferred) {
    const at = clampPlacement(options.preferred.at, bar, pane);
    if (options.preferred.force || clear(at.left, at.top)) return at;
  }

  let first: Placement | null = null;
  let firstOffLegend: Placement | null = null;
  const seen = new Set<string>();
  for (const rawTop of tops) {
    // A candidate the pane cannot hold is not clamped into a different one:
    // "above" that does not fit above is not above, it is somewhere else.
    if (rawTop < EDGE - 0.01 || rawTop > maxTop + 0.01) continue;
    for (const rawLeft of lefts) {
      const left = clamp(rawLeft, EDGE, maxLeft);
      const top = clamp(rawTop, EDGE, maxTop);
      const key = `${Math.round(left)}:${Math.round(top)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      first ??= { left, top };
      if (!firstOffLegend && offLegend(left, top)) firstOffLegend = { left, top };
      if (clear(left, top)) return { left, top };
    }
  }
  return firstOffLegend ?? first
    ?? { left: clamp(box.left, EDGE, maxLeft), top: clamp(box.top - TOOLBAR_GAP - bar.height, EDGE, maxTop) };
}

/** `at`, moved the least distance that keeps the whole bar inside the pane. */
export function clampPlacement(at: Placement, bar: Size, pane: Size): Placement {
  const maxLeft = Math.max(EDGE, pane.width - bar.width - EDGE);
  const maxTop = Math.max(EDGE, pane.height - bar.height - EDGE);
  return { left: clamp(at.left, EDGE, maxLeft), top: clamp(at.top, EDGE, maxTop) };
}

/** Whether two boxes share any area — what the tests and the bar's own check mean by "covers". */
export function overlaps(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; right: number; bottom: number },
): boolean {
  return a.left < b.right && a.left + a.width > b.left && a.top < b.bottom && a.top + a.height > b.top;
}
