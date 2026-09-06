/**
 * Chart drawing model — the data + geometry behind the TradingView-style
 * drawing toolbar. Rendering lives in components/tv/DrawingCanvas.tsx.
 *
 * Anchors are stored as {time, price} in chart units, never pixels, so a
 * drawing survives pan/zoom, timeframe reloads and history-depth changes.
 * Times may fall past the last bar (drawings extended into the future); the
 * canvas extrapolates coordinates for those using the interval length.
 */

import { tryStoredSymbol } from "./instrument";

export type DrawingTool =
  // cursors / modes
  | "cursor" | "eraser"
  // lines
  | "trend" | "ray" | "extended" | "arrow" | "hline" | "hray" | "vline"
  | "parallel" | "pitchfork"
  // fib
  | "fib" | "fibext"
  // shapes
  | "rect" | "ellipse" | "triangle" | "path" | "brush"
  // annotations
  | "text" | "callout" | "pricelabel"
  // measurement
  | "ruler" | "pricerange" | "daterange" | "long" | "short"
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
  | "vprange";

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
}

/** How many anchors each tool takes. `0` = freeform (finish explicitly). */
export const TOOL_POINTS: Record<DrawingTool, number> = {
  cursor: 0, eraser: 0,
  trend: 2, ray: 2, extended: 2, arrow: 2,
  hline: 1, hray: 1, vline: 1,
  parallel: 3, pitchfork: 3,
  fib: 2, fibext: 3,
  rect: 2, ellipse: 2, triangle: 3, path: 0, brush: 0,
  text: 1, callout: 1, pricelabel: 1,
  ruler: 2, pricerange: 2, daterange: 2, long: 2, short: 2,
  // One anchor: the bar the accumulation starts from.
  avwap: 1,
  // Two: the range's edges. Only their TIMES are read — a volume profile
  // covers every price its bars traded at, so dragging one higher or lower
  // would suggest a vertical bound it does not have.
  vprange: 2,
};

/** Tools whose creation asks the user for a caption. */
export const TEXT_TOOLS: ReadonlySet<DrawingTool> = new Set<DrawingTool>(["text", "callout"]);

/** Tools that are transient measurements — cleared when the tool is switched. */
export const EPHEMERAL_TOOLS: ReadonlySet<DrawingTool> = new Set<DrawingTool>(["ruler"]);

export const DEFAULT_STYLE: DrawingStyle = { color: "#4f8cff", width: 2 };

export const PALETTE = [
  "#4f8cff", "#2ebd85", "#f6465d", "#f0b90b", "#a855f7",
  "#e6e9ef", "#9aa4b6", "#22d3ee", "#fb923c",
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

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
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
    Number.isFinite(x.style.width)
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
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch { /* quota — drawings stay in memory for this session */ }
}
