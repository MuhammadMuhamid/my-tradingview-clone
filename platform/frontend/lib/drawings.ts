/**
 * Chart drawing model — the data + geometry behind the TradingView-style
 * drawing toolbar. Rendering lives in components/tv/DrawingCanvas.tsx.
 *
 * Anchors are stored as {time, price} in chart units, never pixels, so a
 * drawing survives pan/zoom, timeframe reloads and history-depth changes.
 * Times may fall past the last bar (drawings extended into the future); the
 * canvas extrapolates coordinates for those using the interval length.
 */

import { recallJson, rememberJson } from "./browserStorage";
import { tryStoredSymbol } from "./instrument";
import { isResolution, type Resolution } from "./resolution";

export type DrawingTool =
  // cursors / modes
  //
  // `arrowCursor` is the reference's second cursor: it selects and drags
  // exactly as `cursor` does and differs only in the pointer it paints, which
  // is why it is a MODE here and not a shape — see `isCursorMode`.
  | "cursor" | "dot" | "arrowCursor" | "eraser"
  /*
   * Zoom in — a gesture, not a drawing.
   *
   * It is in this union because the union is the only channel the rail has to
   * the canvas: the rail arms a tool, the canvas reads it. Dragging with it
   * armed selects a span of time and hands it to the chart's own
   * `setVisibleRange`; nothing is committed to the drawing list, which is why
   * `TOOL_POINTS.zoom` is two (a drag) and no renderer branch exists for it.
   */
  | "zoom"
  /*
   * A Unicode emoji placed at one anchor.
   *
   * The glyph itself travels on `style.glyph` rather than in the tool id,
   * because otherwise every emoji in the picker would be its own member of
   * this union and its own key in every record that is exhaustive over it.
   */
  | "icon"
  // lines
  | "trend" | "trendAngle" | "infoline" | "ray" | "extended" | "arrow" | "hline" | "hray" | "vline" | "crossline"
  | "parallel" | "disjointChannel" | "pitchfork"
  | "regression" | "flatTopBottom" | "schiffPitchfork" | "modifiedSchiffPitchfork" | "insidePitchfork"
  // fib
  | "fib" | "fibext" | "fibChannel" | "fibTimeZone" | "trendFibTime" | "fibSpeedResistanceFan" | "fibSpeedResistanceArcs" | "fibCircles" | "fibSpiral" | "fibWedge" | "pitchfan"
  // gann and manual pattern templates
  | "gannBox" | "gannSquareFixed" | "gannSquare" | "gannFan"
  | "xabcd" | "cypher" | "headAndShoulders" | "abcdPattern" | "trianglePattern" | "threeDrives"
  | "elliottImpulse" | "elliottCorrection" | "elliottTriangle" | "elliottDoubleCombo" | "elliottTripleCombo"
  | "cyclicLines" | "timeCycles" | "sineLine" | "positionForecast" | "barsPattern" | "sector" | "rotatedRectangle" | "table"
  // shapes
  | "rect" | "ellipse" | "circle" | "triangle" | "path" | "polyline" | "brush" | "highlighter"
  | "arrowMarker" | "arrowUp" | "arrowDown" | "arc" | "curve" | "doubleCurve"
  // annotations
  | "text" | "note" | "priceNote" | "pin" | "comment" | "callout" | "pricelabel" | "signpost" | "flagMark"
  // measurement
  | "ruler" | "pricerange" | "daterange" | "datePriceRange" | "long" | "short"
  /*
   * A drawing that COMPUTES.
   *
   * Anchored VWAP is here rather than in the study registry because its
   * defining input is a point on the chart: "from here", chosen by clicking a
   * bar and moved by dragging it. A study's inputs are numbers in a dialog.
   * Making it a drawing gives it the anchor, the drag, the selection, the
   * per-instrument scoping and the persistence drawings already have, rather
   * than a parallel mechanism for one indicator.
   */
  | "avwap"
  /*
   * The other drawing that computes.
   *
   * A Fixed Range Volume Profile's defining input is a SPAN of the chart —
   * "profile these bars" — dragged across the plot and moved by its handles.
   * Nothing in a settings dialog can express that, which is the same argument
   * that made Anchored VWAP a drawing. The visible-range profile is a study,
   * because its range is not a decision the user makes.
   */
  | "vprange" | "avprofile";

export interface Anchor {
  /** bar open time in seconds (chart time units) */
  time: number;
  price: number;
}

export interface DrawingStyle {
  color: string;
  width: number;
  dashed?: boolean;
  /** shapes: translucent interior */
  filled?: boolean;
  text?: string;
  /** `icon`: the Unicode emoji this drawing paints at its anchor. */
  glyph?: string;
  /**
   * Anchored VWAP: how many standard-deviation bands to draw either side.
   *
   * Declared here rather than read through a cast, because a property the
   * style type does not admit is a property nothing can WRITE: `applyStyle` is
   * `Partial<DrawingStyle>`, so the control could never have set it and the
   * bands were unreachable for every drawing a user could create.
   */
  bands?: 0 | 1 | 2;
  /**
   * Fixed Range Volume Profile: how the profile is cut and drawn.
   *
   * Nested rather than eight more flat keys, because these belong to exactly
   * one tool and a flat `rowSize` on a trendline's style would be a field
   * nothing reads. Every member is optional and every reader defaults it —
   * `lib/volumeProfile` normalises the lot — so a drawing written by an older
   * build, or by hand, is still a drawable profile.
   */
  profile?: {
    layout?: "rows" | "height";
    rowSize?: number;
    valueAreaPercent?: number;
    allocation?: "range" | "close";
    split?: "total" | "upDown";
    side?: "left" | "right";
    /** Share of the plot's width the widest row may take, in percent. */
    widthPercent?: number;
    showValueArea?: boolean;
    showPoc?: boolean;
  };
}

export interface Drawing {
  id: string;
  tool: DrawingTool;
  points: Anchor[];
  style: DrawingStyle;
  locked?: boolean;
  /**
   * Hidden on its own, independently of the workspace-wide "Hide drawings".
   *
   * A hidden drawing is not drawn and cannot be hit-tested, but it is still
   * stored, still counted, and still in the list — which is what separates
   * hiding from deleting, and why the context menu offers both.
   */
  hidden?: boolean;
  /** Optional timeframe allow-list. Missing/empty means every timeframe. */
  visibleOn?: Resolution[];
}

export function drawingVisibleOnTimeframe(drawing: Drawing, interval: Resolution): boolean {
  const visibleOn = drawing.visibleOn;
  return !visibleOn || visibleOn.length === 0 || visibleOn.includes(interval);
}

/** How many anchors each tool takes. `0` = freeform (finish explicitly). */
/**
 * The tools that have an interior, and therefore a Fill.
 *
 * TVP8: the selected-drawing toolbar offered Fill on every one of the 87 tools
 * and five of them read it. Toggling it on a trend line, a Fibonacci
 * retracement or a piece of text did nothing at all, silently — and a control
 * that does nothing is worse than a missing one, because it costs the user the
 * time to find out. The reference shows a background control only on shapes
 * that have a background.
 *
 * `sector` is here because it drew a fill unconditionally, which was the same
 * bug from the other side: a shape whose fill could not be turned off.
 */
export const FILLABLE_TOOLS: ReadonlySet<DrawingTool> = new Set<DrawingTool>([
  "rect", "rotatedRectangle", "ellipse", "circle", "triangle", "sector",
]);

/**
 * The tools that SELECT rather than draw.
 *
 * TVP8: the canvas asked `tool === "cursor"` in four places to decide whether
 * a press selects a drawing or starts one. A second cursor mode would have
 * been a drawing tool with no anchors — a press that armed a freeform draft
 * nothing could finish — so the question is asked of this set instead, and
 * adding a third cursor is one line here rather than four there.
 */
export const CURSOR_TOOLS: ReadonlySet<DrawingTool> = new Set<DrawingTool>([
  "cursor", "arrowCursor",
]);

export const isCursorMode = (tool: DrawingTool): boolean => CURSOR_TOOLS.has(tool);

/**
 * The glyphs the Icons cell offers.
 *
 * Unicode characters, drawn by the platform's own emoji or text face: no
 * artwork is bundled and none is borrowed, which is also why the canvas can
 * paint one with a single `fillText`. They live here rather than in the rail
 * because they are a drawing's CONTENT — the same kind of value as a
 * trendline's colour — and because a pictograph inside a `.tsx` is a control
 * glyph as far as the product's icon rule is concerned, and it is right about
 * that.
 *
 * ── Why there are categories and two tabs (R2b-07) ─────────────────────────
 *
 * The picker was a flat 56-glyph grid, 292px tall, where the reference has a
 * 679px categorised picker that scrolls inside itself. Fifty-six is not a
 * picker, it is a favourites bar: the whole point of the control is that you
 * come to it looking for a particular mark and find it by category.
 *
 * The reference's bottom tab bar reads `Emojis · Stickers · Icons`. Stickers
 * are that product's own licensed artwork and have no counterpart here, so
 * this picker renders TWO tabs and says so rather than shipping an empty
 * third: `Emojis` (the platform's colour emoji) and `Icons` (a monochrome
 * outline set, also Unicode, so it paints through the same `fillText` path and
 * inherits the drawing's own colour instead of arriving pre-coloured).
 */
export interface GlyphCategory {
  id: string;
  /** The category cell's own glyph, and its accessible name. */
  label: string;
  icon: string;
  glyphs: readonly string[];
}

export const EMOJI_CATEGORIES: readonly GlyphCategory[] = [
  {
    id: "smileys", label: "Smileys", icon: "\u{1F642}",
    glyphs: [
      "\u{1F600}", "\u{1F603}", "\u{1F604}", "\u{1F609}", "\u{1F60A}", "\u{1F60E}", "\u{1F929}", "\u{1F914}",
      "\u{1F610}", "\u{1F611}", "\u{1F636}", "\u{1F62E}", "\u{1F632}", "\u{1F631}", "\u{1F628}", "\u{1F625}",
      "\u{1F622}", "\u{1F62D}", "\u{1F621}", "\u{1F620}", "\u{1F92F}", "\u{1F975}", "\u{1F976}", "\u{1F634}",
      "\u{1F644}", "\u{1F612}", "\u{1F60F}", "\u{1F92B}", "\u{1F910}", "\u{1F971}", "\u{1F92A}", "\u{1F973}",
    ],
  },
  {
    id: "gestures", label: "Gestures", icon: "\u{1F44D}",
    glyphs: [
      "\u{1F44D}", "\u{1F44E}", "\u{1F44C}", "\u{270C}\uFE0F", "\u{1F918}", "\u{1F44F}", "\u{1F64C}", "\u{1F64F}",
      "\u{1F4AA}", "\u{270B}", "\u{1F44A}", "\u{1F91D}", "\u{1F446}", "\u{1F447}", "\u{1F448}", "\u{1F449}",
      "\u{1F440}", "\u{1F441}\uFE0F", "\u{1F9E0}", "\u{1F444}", "\u{1F9BE}", "\u{270D}\uFE0F", "\u{1F590}\uFE0F", "\u{1F595}",
    ],
  },
  {
    id: "marks", label: "Marks", icon: "\u2757",
    glyphs: [
      "\u2757", "\u2753", "\u2705", "\u274C", "\u2B55", "\u26A0\uFE0F", "\u26D4", "\u{1F6D1}",
      "\u{1F534}", "\u{1F7E0}", "\u{1F7E1}", "\u{1F7E2}", "\u{1F535}", "\u{1F7E3}", "\u26AB", "\u26AA",
      "\u{1F53A}", "\u{1F53B}", "\u{1F536}", "\u{1F537}", "\u2B50", "\u2728", "\u{1F4AF}", "\u{1F4A2}",
    ],
  },
  {
    id: "weather", label: "Weather", icon: "\u{1F525}",
    glyphs: [
      "\u{1F525}", "\u{1F4A5}", "\u26A1", "\u2600\uFE0F", "\u{1F319}", "\u2601\uFE0F", "\u{1F30A}", "\u2744\uFE0F",
      "\u{1F32A}\uFE0F", "\u{1F308}", "\u{1F327}\uFE0F", "\u{1F326}\uFE0F", "\u{1F32B}\uFE0F", "\u{1F30D}", "\u{1F311}", "\u{1F31E}",
    ],
  },
  {
    id: "markets", label: "Markets", icon: "\u{1F4C8}",
    glyphs: [
      "\u{1F4C8}", "\u{1F4C9}", "\u{1F4CA}", "\u{1F4B0}", "\u{1F48E}", "\u{1F4B5}", "\u{1F4B3}", "\u{1F3E6}",
      "\u{1F4B9}", "\u{1FA99}", "\u2696\uFE0F", "\u{1F9EE}", "\u{1F4CB}", "\u{1F4C5}", "\u{1F4DD}", "\u{1F4CC}",
    ],
  },
  {
    id: "animals", label: "Animals", icon: "\u{1F42E}",
    glyphs: [
      "\u{1F402}", "\u{1F43B}", "\u{1F988}", "\u{1F40B}", "\u{1F419}", "\u{1F985}", "\u{1F98A}", "\u{1F981}",
      "\u{1F42E}", "\u{1F418}", "\u{1F40E}", "\u{1F422}", "\u{1F40C}", "\u{1F41D}", "\u{1F98B}", "\u{1F41E}",
    ],
  },
  {
    id: "travel", label: "Travel", icon: "\u{1F680}",
    glyphs: [
      "\u{1F680}", "\u{1F3C1}", "\u{1F6A6}", "\u{1F6A7}", "\u26F5", "\u2708\uFE0F", "\u{1F697}", "\u{1F6F0}\uFE0F",
      "\u{1F5FA}\uFE0F", "\u{1F9ED}", "\u23F0", "\u23F3", "\u{1F514}", "\u{1F50D}", "\u{1F9F2}", "\u{1F4A1}",
    ],
  },
  {
    id: "objects", label: "Objects", icon: "\u{1F4CE}",
    glyphs: [
      "\u{1F4CE}", "\u{1F510}", "\u{1F512}", "\u{1F513}", "\u{1F511}", "\u{1F5DD}\uFE0F", "\u{1F528}", "\u{1F527}",
      "\u2699\uFE0F", "\u{1F9F0}", "\u{1F4E6}", "\u{1F4C1}", "\u{1F4C4}", "\u{1F4D0}", "\u{1F4CF}", "\u{1F58D}\uFE0F",
    ],
  },
];

export const OUTLINE_CATEGORIES: readonly GlyphCategory[] = [
  {
    id: "arrows", label: "Arrows", icon: "\u2192",
    glyphs: [
      "\u2190", "\u2191", "\u2192", "\u2193", "\u2194", "\u2195", "\u2196", "\u2197",
      "\u2198", "\u2199", "\u21B0", "\u21B1", "\u21BA", "\u21BB", "\u21C4", "\u21C5",
      "\u21D0", "\u21D1", "\u21D2", "\u21D3", "\u21E6", "\u21E7", "\u21E8", "\u21E9",
      "\u27A4", "\u27F5", "\u27F6", "\u27F7", "\u2937", "\u2936", "\u2934", "\u2935",
    ],
  },
  {
    id: "shapes", label: "Shapes", icon: "\u25C6",
    glyphs: [
      "\u25A0", "\u25A1", "\u25B2", "\u25B3", "\u25BC", "\u25BD", "\u25C6", "\u25C7",
      "\u25CF", "\u25CB", "\u25D0", "\u25D1", "\u25E6", "\u2B1B", "\u2B1C", "\u2B22",
      "\u25B6", "\u25B7", "\u25C0", "\u25C1", "\u25AA", "\u25AB", "\u2B24", "\u2B21",
    ],
  },
  {
    id: "signs", label: "Signs", icon: "\u2713",
    glyphs: [
      "\u2713", "\u2714", "\u2717", "\u2718", "\u2795", "\u2796", "\u00D7", "\u00F7",
      "\u00B1", "\u2260", "\u2248", "\u221E", "\u2211", "\u220F", "\u221A", "\u2206",
      "\u00A7", "\u00B6", "\u2020", "\u2021", "\u2022", "\u203B", "\u203C", "\u2049",
    ],
  },
  {
    id: "stars", label: "Stars", icon: "\u2605",
    glyphs: [
      "\u2605", "\u2606", "\u272A", "\u272B", "\u272C", "\u2739", "\u273F", "\u2740",
      "\u2660", "\u2661", "\u2662", "\u2663", "\u2664", "\u2665", "\u2666", "\u2667",
      "\u266A", "\u266B", "\u2691", "\u2690", "\u2693", "\u2694", "\u2696", "\u2692",
    ],
  },
];

/** Every glyph the picker can arm, in picker order. */
export const ICON_GLYPHS: readonly string[] = [
  ...EMOJI_CATEGORIES.flatMap((c) => c.glyphs),
  ...OUTLINE_CATEGORIES.flatMap((c) => c.glyphs),
];

/**
 * The emoji the next `icon` drawing will carry.
 *
 * The rail arms a tool through one `(tool) => void` callback that the whole
 * page, the command palette and the keyboard layer share; widening it to
 * carry a payload for one tool would touch every caller. This is the payload,
 * written by the icon picker and read once by the canvas at the moment it
 * commits — a default so that arming `icon` from the palette, where no glyph
 * was chosen, still places something.
 */
let pendingIconGlyph = "😀";

export function armIconGlyph(glyph: string): void {
  if (glyph) pendingIconGlyph = glyph;
}

export function currentIconGlyph(): string {
  return pendingIconGlyph;
}

export const TOOL_POINTS: Record<DrawingTool, number> = {
  cursor: 0, arrowCursor: 0, eraser: 0,
  // Two anchors, because the gesture is a drag across a span of time. Nothing
  // is committed: `DrawingCanvas` reads the span and moves the viewport.
  zoom: 2,
  dot: 1, icon: 1,
  trend: 2, trendAngle: 2, infoline: 2, ray: 2, extended: 2, arrow: 2,
  hline: 1, hray: 1, vline: 1, crossline: 1,
  parallel: 3, disjointChannel: 3, pitchfork: 3,
  regression: 2, flatTopBottom: 2, schiffPitchfork: 3, modifiedSchiffPitchfork: 3, insidePitchfork: 3,
  fib: 2, fibext: 3,
  fibChannel: 3, fibTimeZone: 2, trendFibTime: 3, fibSpeedResistanceFan: 2, fibSpeedResistanceArcs: 2,
  fibCircles: 2, fibSpiral: 2, fibWedge: 3, pitchfan: 3,
  gannBox: 2, gannSquareFixed: 2, gannSquare: 2, gannFan: 2,
  xabcd: 5, cypher: 5, headAndShoulders: 5, abcdPattern: 4, trianglePattern: 3, threeDrives: 7,
  elliottImpulse: 6, elliottCorrection: 5, elliottTriangle: 5, elliottDoubleCombo: 7, elliottTripleCombo: 9,
  cyclicLines: 2, timeCycles: 2, sineLine: 2, positionForecast: 3, barsPattern: 2, sector: 3, rotatedRectangle: 3, table: 2,
  rect: 2, ellipse: 2, circle: 2, triangle: 3, path: 0, polyline: 0, brush: 0, highlighter: 0,
  arrowMarker: 1, arrowUp: 1, arrowDown: 1, arc: 3, curve: 3, doubleCurve: 4,
  text: 1, note: 1, priceNote: 1, pin: 1, comment: 1, callout: 1, pricelabel: 1, signpost: 1, flagMark: 1,
  ruler: 2, pricerange: 2, daterange: 2, datePriceRange: 2, long: 2, short: 2,
  // One anchor: the bar the accumulation starts from.
  avwap: 1,
  // Two: the range's edges. Only their TIMES are read — a volume profile
  // covers every price its bars traded at, so dragging one higher or lower
  // would suggest a vertical bound it does not have.
  vprange: 2,
  avprofile: 1,
};

/** Tools whose creation asks the user for a caption. */
export const TEXT_TOOLS: ReadonlySet<DrawingTool> = new Set<DrawingTool>([
  "text", "note", "priceNote", "comment", "callout", "signpost", "flagMark",
]);

/** Tools that are transient measurements — cleared when the tool is switched. */
export const EPHEMERAL_TOOLS: ReadonlySet<DrawingTool> = new Set<DrawingTool>(["ruler"]);

export const DEFAULT_STYLE: DrawingStyle = { color: "#4f8cff", width: 2 };

export const PALETTE = [
  "#4f8cff", "#2ebd85", "#f6465d", "#f0b90b", "#a855f7",
  "#dbdbdb", "#a8a8a8", "#22d3ee", "#fb923c",
];

/** Standard TradingView retracement levels. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
/** Trend-based extension levels. */
export const FIB_EXT_LEVELS = [0, 0.618, 1, 1.618, 2.618, 4.236];

export const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `d-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ── geometry helpers (pixel space) ──────────────────────────────────────────

export interface Pt { x: number; y: number }

/** Shortest distance from p to the segment ab. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance to an infinite line through a and b (for extended lines). */
export function distToLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
}

/** Distance to a ray starting at a, through b, extending forward only. */
export function distToRay(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance to a rectangle's outline (0 when inside a filled one). */
export function distToRect(p: Pt, a: Pt, b: Pt, filled: boolean): number {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  const inside = p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
  if (inside && filled) return 0;
  const corners: [Pt, Pt][] = [
    [{ x: x1, y: y1 }, { x: x2, y: y1 }],
    [{ x: x2, y: y1 }, { x: x2, y: y2 }],
    [{ x: x2, y: y2 }, { x: x1, y: y2 }],
    [{ x: x1, y: y2 }, { x: x1, y: y1 }],
  ];
  return Math.min(...corners.map(([s, e]) => distToSegment(p, s, e)));
}

/** Distance to an ellipse inscribed in the a–b bounding box. */
export function distToEllipse(p: Pt, a: Pt, b: Pt, filled: boolean): number {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  if (rx < 1 || ry < 1) return Math.hypot(p.x - cx, p.y - cy);
  const norm = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
  if (filled && norm <= 1) return 0;
  // Approximate: radial distance scaled back to pixels.
  return Math.abs(norm - 1) * Math.min(rx, ry);
}

// ── persistence (per symbol, like TradingView's per-instrument drawings) ────

const KEY = "srtrend.drawings.v2";

interface Store { [symbol: string]: Drawing[] }

/**
 * The whole store, or an empty one.
 *
 * ── Why the shape is checked and the CONTENTS are not ──────────────────────
 *
 * This was `JSON.parse(...) as Store` — an unchecked cast on a value that
 * comes from the user's own disk. `saveDrawings` then reads the result,
 * assigns one symbol's list into it and writes the whole thing back, so
 * anything that is not a plain object destroys every OTHER symbol's drawings:
 * a stored `null` throws on `delete store[key]`, and a stored `5` swallows the
 * assignment silently and writes `5` back over the lot. Neither needs a
 * malicious actor — a truncated write during a crash produces the first.
 *
 * What is deliberately NOT done here is filtering the drawings themselves.
 * `isValidDrawing` rejects any tool this build does not know, so filtering on
 * the way THROUGH `saveDrawings` would mean an older build permanently deletes
 * a drawing made by a newer one, simply by the user saving something else on
 * another symbol. Validation belongs where the drawings are RENDERED —
 * `loadDrawings` — where rejecting one costs a frame, not the drawing.
 */
function readStore(): Store {
  const raw = recallJson<unknown>(KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const store: Store = {};
  for (const [symbol, list] of Object.entries(raw as Record<string, unknown>)) {
    // A symbol whose value is not a list is dropped rather than carried
    // forward: nothing can read it, and keeping it would write it back.
    if (Array.isArray(list)) store[symbol] = list as Drawing[];
  }
  return store;
}

/**
 * Stored drawings are validated on the way in: a truncated or hand-edited
 * localStorage entry would otherwise reach the canvas renderer and throw on
 * every frame, taking the whole chart page down with it.
 */
function isValidDrawing(d: unknown): d is Drawing {
  if (!d || typeof d !== "object") return false;
  const x = d as Partial<Drawing>;
  return (
    typeof x.id === "string" &&
    typeof x.tool === "string" &&
    x.tool in TOOL_POINTS &&
    Array.isArray(x.points) &&
    x.points.length > 0 &&
    x.points.every((p) => p && Number.isFinite(p.time) && Number.isFinite(p.price)) &&
    !!x.style &&
    typeof x.style.color === "string" &&
    Number.isFinite(x.style.width) &&
    (x.visibleOn === undefined || (
      Array.isArray(x.visibleOn) && x.visibleOn.every((resolution) => isResolution(resolution))
    ))
  );
}

/**
 * The key one instrument's drawings are stored under.
 *
 * Canonical, because the SERVER is: it keys the same list by `(venue,
 * ticker)`, so `BTCUSDT`, `btcusdt` and `BINANCE:BTCUSDT` are one row there.
 * Keyed by the raw string here, they would be three localStorage entries and
 * three undo stacks feeding that one row, with the losing spelling silently
 * overwritten on the next adopt.
 *
 * Every caller today passes a bare upper-case ticker, so this changes nothing
 * now. It is here so that the day one does not, the two sides still agree.
 */
function drawingKey(symbol: string): string {
  return tryStoredSymbol(symbol) ?? symbol.trim().toUpperCase();
}

export function loadDrawings(symbol: string): Drawing[] {
  const all = readStore()[drawingKey(symbol)];
  return Array.isArray(all) ? all.filter(isValidDrawing) : [];
}

export function saveDrawings(symbol: string, drawings: Drawing[]): void {
  if (typeof window === "undefined") return;
  const store = readStore();
  const key = drawingKey(symbol);
  if (drawings.length === 0) delete store[key];
  else store[key] = drawings;
  // Quota, or a browser that refuses to store: the drawings stay in memory for
  // this session rather than taking the page down. See `lib/browserStorage`.
  rememberJson(KEY, store);
}
