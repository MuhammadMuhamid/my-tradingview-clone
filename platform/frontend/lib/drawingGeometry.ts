import type { DrawingTool } from "./drawings";

export interface PixelPoint { x: number; y: number }
export interface Segment { a: PixelPoint; b: PixelPoint }
export interface AdvancedGeometry {
  segments: Segment[];
  circles: Array<{ center: PixelPoint; radius: number }>;
  polygons: PixelPoint[][];
  verticals: number[];
  horizontals: number[];
}

/** Position Forecast: first anchor is the origin, second the measured move,
 * third the forecast target. The returned segments are the exact geometry
 * used by both painting and hit testing (risk/reward box plus continuation).
 */
export function positionForecastGeometry(points: PixelPoint[], span = 6000): AdvancedGeometry {
  const [entry, stop, target] = points;
  if (!entry || !stop) return EMPTY;
  const tip = target ?? extend(entry, stop, Math.max(80, span * 0.12));
  const dx = tip.x - entry.x, dy = tip.y - entry.y;
  const continuation = { x: tip.x + dx, y: tip.y + dy };
  const top = Math.min(entry.y, stop.y, tip.y), bottom = Math.max(entry.y, stop.y, tip.y);
  const boxLeft = Math.min(entry.x, tip.x), boxRight = Math.max(entry.x, tip.x);
  return {
    ...EMPTY,
    segments: [
      { a: entry, b: stop }, { a: entry, b: tip }, { a: tip, b: continuation },
      { a: { x: boxLeft, y: top }, b: { x: boxRight, y: top } },
      { a: { x: boxRight, y: top }, b: { x: boxRight, y: bottom } },
      { a: { x: boxRight, y: bottom }, b: { x: boxLeft, y: bottom } },
      { a: { x: boxLeft, y: bottom }, b: { x: boxLeft, y: top } },
    ],
    polygons: [[entry, stop, tip]],
  };
}

/**
 * Bars Pattern geometry. `source` is the historical close path selected by
 * the two anchors; it is translated/scaled into a projected copy beginning at
 * the second anchor. The source and projected paths are both returned so the
 * selection affordance remains visible while the projection is editable.
 */
export function barsPatternGeometry(points: PixelPoint[], source: PixelPoint[], _span = 6000): AdvancedGeometry {
  const [start, end] = points;
  if (!start || !end || source.length < 2) {
    return start && end ? { ...EMPTY, segments: [{ a: start, b: end }] } : EMPTY;
  }
  const src0 = source[0]!, srcN = source[source.length - 1]!;
  const srcWidth = Math.max(1, srcN.x - src0.x);
  const dstWidth = end.x - start.x;
  const sx = (Math.abs(dstWidth) < 1 ? 1 : dstWidth) / srcWidth;
  const sy = 1;
  const projected = source.map((p) => ({
    x: end.x + (p.x - src0.x) * sx,
    y: end.y + (p.y - src0.y) * sy,
  }));
  const segments: Segment[] = [];
  for (let i = 1; i < source.length; i++) segments.push({ a: source[i - 1]!, b: source[i]! });
  for (let i = 1; i < projected.length; i++) segments.push({ a: projected[i - 1]!, b: projected[i]! });
  return { ...EMPTY, segments, polygons: [projected] };
}

const EMPTY: AdvancedGeometry = { segments: [], circles: [], polygons: [], verticals: [], horizontals: [] };

const sub = (a: PixelPoint, b: PixelPoint): PixelPoint => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: PixelPoint, b: PixelPoint): PixelPoint => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: PixelPoint, n: number): PixelPoint => ({ x: a.x * n, y: a.y * n });
const midpoint = (a: PixelPoint, b: PixelPoint): PixelPoint => mul(add(a, b), 0.5);
const len = (p: PixelPoint): number => Math.hypot(p.x, p.y) || 1;
const unit = (p: PixelPoint): PixelPoint => mul(p, 1 / len(p));
const perp = (p: PixelPoint): PixelPoint => ({ x: -p.y, y: p.x });

/** A stable, direction-preserving extension. Unlike a fixed pixel offset this
 * remains correct when a chart is zoomed or a handle is dragged. */
export function extend(a: PixelPoint, b: PixelPoint, distance: number): PixelPoint {
  return add(b, mul(unit(sub(b, a)), distance));
}

/** Standard/Schiff/Modified Schiff/Inside pitchfork construction. */
export function pitchforkGeometry(points: PixelPoint[], variant: "standard" | "schiff" | "modifiedSchiff" | "inside" = "standard", span = 6000): AdvancedGeometry {
  const [p1, p2, p3] = points;
  if (!p1 || !p2 || !p3) return EMPTY;
  const pivot = midpoint(p2, p3);
  let origin = p1;
  if (variant === "schiff") origin = midpoint(p1, p2);
  if (variant === "modifiedSchiff") origin = add(p1, mul(sub(pivot, p1), 0.5));
  if (variant === "inside") origin = midpoint(p1, pivot);
  const medianEnd = extend(origin, pivot, span);
  const leftEnd = extend(p2, add(p2, sub(pivot, origin)), span);
  const rightEnd = extend(p3, add(p3, sub(pivot, origin)), span);
  return { ...EMPTY, segments: [
    { a: p2, b: p3 }, { a: origin, b: medianEnd },
    { a: p2, b: leftEnd }, { a: p3, b: rightEnd },
  ], polygons: [[p2, p3, rightEnd, leftEnd]] };
}

/** Fib channels use a baseline plus a parallel offset; the third point is the
 * offset handle, not a fourth arbitrary vertex. */
export function fibChannelGeometry(points: PixelPoint[], ratios = [0, 0.382, 0.5, 0.618, 1, 1.618], span = 6000): AdvancedGeometry {
  const [a, b, c] = points;
  if (!a || !b) return EMPTY;
  const direction = sub(b, a);
  const normal = unit(perp(direction));
  const offset = c ? (sub(c, a).x * normal.x + sub(c, a).y * normal.y) : 0;
  const segments: Segment[] = [];
  for (const ratio of ratios) {
    const shift = mul(normal, offset * ratio);
    const start = add(a, shift);
    segments.push({ a: start, b: extend(start, add(start, direction), span) });
  }
  return { ...EMPTY, segments };
}

export function fibonacciLevels(start: number, end: number, ratios: readonly number[]): number[] {
  return ratios.map((ratio) => start + (end - start) * ratio);
}

/** Gann squares are square in the chart's pixel coordinate system and have
 * deterministic 1/8 subdivisions, matching the visible grid traders edit. */
export function gannSquareGeometry(a: PixelPoint, b: PixelPoint, fixed = false): AdvancedGeometry {
  const size = fixed ? Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) : Math.max(12, Math.abs(b.x - a.x));
  const x2 = a.x + (b.x >= a.x ? size : -size);
  const y2 = a.y + (b.y >= a.y ? size : -size);
  const segments: Segment[] = [{ a, b: { x: x2, y: a.y } }, { a: { x: x2, y: a.y }, b: { x: x2, y: y2 } }, { a: { x: x2, y: y2 }, b: { x: a.x, y: y2 } }, { a: { x: a.x, y: y2 }, b: a }];
  for (const fraction of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
    segments.push({ a: { x: a.x + (x2 - a.x) * fraction, y: a.y }, b: { x: a.x + (x2 - a.x) * fraction, y: y2 } });
    segments.push({ a: { x: a.x, y: a.y + (y2 - a.y) * fraction }, b: { x: x2, y: a.y + (y2 - a.y) * fraction } });
  }
  return { ...EMPTY, segments };
}

export function regression(points: PixelPoint[], observations: PixelPoint[]): { center: Segment; deviation: number } | null {
  if (observations.length < 2) return points.length >= 2 ? { center: { a: points[0]!, b: points[1]! }, deviation: 18 } : null;
  const meanX = observations.reduce((s, p) => s + p.x, 0) / observations.length;
  const meanY = observations.reduce((s, p) => s + p.y, 0) / observations.length;
  const denom = observations.reduce((s, p) => s + (p.x - meanX) ** 2, 0) || 1;
  const slope = observations.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0) / denom;
  const intercept = meanY - slope * meanX;
  const x1 = Math.min(...observations.map((p) => p.x));
  const x2 = Math.max(...observations.map((p) => p.x));
  const residual = Math.sqrt(observations.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0) / observations.length);
  return { center: { a: { x: x1, y: slope * x1 + intercept }, b: { x: x2, y: slope * x2 + intercept } }, deviation: Math.max(2, residual) };
}

export function patternLabels(tool: DrawingTool): string[] {
  switch (tool) {
    case "xabcd": return ["X", "A", "B", "C", "D"];
    case "cypher": return ["X", "A", "B", "C", "D"];
    case "headAndShoulders": return ["L", "Head", "R", "Neck", "Break"];
    case "abcdPattern": return ["A", "B", "C", "D"];
    case "trianglePattern": return ["A", "B", "C"];
    case "threeDrives": return ["0", "1", "2", "3", "4", "5", "6"];
    case "elliottImpulse": return ["0", "1", "2", "3", "4", "5"];
    case "elliottCorrection": return ["A", "B", "C", "D", "E"];
    case "elliottTriangle": return ["A", "B", "C", "D", "E"];
    case "elliottDoubleCombo": return ["W", "X", "Y", "X", "Z", "①", "②"];
    case "elliottTripleCombo": return ["W", "X", "Y", "X", "Z", "①", "②", "③", "④"];
    default: return [];
  }
}

/** Time tools are projections from an interval, not arbitrary connected
 * polylines. The returned x positions stay stable as the chart is resized. */
export function timeProjection(tool: DrawingTool, points: PixelPoint[], height: number): AdvancedGeometry {
  const [a, b] = points;
  if (!a || !b) return EMPTY;
  const period = Math.max(8, Math.abs(b.x - a.x));
  if (tool === "cyclicLines" || tool === "timeCycles") {
    const verticals: number[] = [];
    for (let x = a.x; x <= a.x + period * 13; x += period) verticals.push(x);
    return { ...EMPTY, verticals };
  }
  const segments: Segment[] = [];
  const amplitude = Math.max(8, Math.abs(b.y - a.y));
  const steps = 96;
  let prev = { x: a.x, y: a.y };
  for (let i = 1; i <= steps; i++) {
    const x = a.x + (period * 4 * i) / steps;
    const y = a.y + Math.sin((i / steps) * Math.PI * 2 * 4) * amplitude;
    segments.push({ a: prev, b: { x, y } }); prev = { x, y };
  }
  return { ...EMPTY, segments, horizontals: [Math.max(0, Math.min(height, a.y))] };
}
