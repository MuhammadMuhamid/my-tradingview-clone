"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts";
import type { Candle, Interval } from "@/lib/types";
import { fmtPrice } from "@/lib/format";
import { isTypingTarget } from "@/lib/shortcuts";
import {
  DEFAULT_STYLE, EPHEMERAL_TOOLS, FIB_EXT_LEVELS, FIB_LEVELS, PALETTE, TEXT_TOOLS, TOOL_POINTS,
  distToEllipse, distToLine, distToRay, distToRect, distToSegment, newId,
  type Anchor, type Drawing, type DrawingTool, type Pt,
} from "@/lib/drawings";

const HIT_PX = 7;
const HANDLE_PX = 4.5;

const INTERVAL_SEC: Record<Interval, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200, "1d": 86400,
};

interface Drag {
  /** null = moving the whole drawing; otherwise the anchor index being moved */
  handle: number | null;
  startPointer: Anchor;
  startPoints: Anchor[];
  moved: boolean;
  /**
   * Identifies this drag to the undo history, so every pointer sample it emits
   * collapses into one step. Unique per drag rather than per drawing: moving a
   * trendline, letting go, and moving it again is two undos.
   */
  gesture: string;
}

/**
 * Canvas overlay that renders and edits chart drawings on top of
 * lightweight-charts. Anchors live in {time, price}; every frame they are
 * mapped through the chart's own scales, so drawings track pan, zoom and
 * price-scale drags exactly.
 *
 * Pointer handling runs in the capture phase on the chart container: events
 * the drawing layer consumes are stopped before lightweight-charts sees them
 * (so dragging a trend line never pans the chart), and everything else falls
 * through untouched.
 */
/**
 * A number that changes when any anchor moves.
 *
 * This is sampled every animation frame, so it must not allocate. It replaced
 * `JSON.stringify(drawings.map((d) => d.points))`, which built an array and a
 * string of every anchor on the chart sixty times a second whether or not
 * anything had moved — while a drag was in progress, on top of the drag's own
 * work. A drawing's own points array is replaced on edit, so identity would
 * usually be enough; the digest also catches an in-place edit, which is what
 * the stringify was really guarding against.
 */
function geometryDigest(drawings: Drawing[]): number {
  let digest = drawings.length;
  for (const drawing of drawings) {
    for (const point of drawing.points) {
      // Mixed with a prime and wrapped to 32 bits so distinct geometries do
      // not collapse onto one another through plain addition.
      digest = (Math.imul(digest, 31) + (point.time | 0)) | 0;
      digest = (Math.imul(digest, 31) + Math.round(point.price * 1e6)) | 0;
    }
  }
  return digest;
}

export function DrawingCanvas({
  container, chart, series, candles, interval,
  tool, onToolDone, drawings, onChange, magnet, locked, hidden,
  onSelectionChange, onContextMenu, styleFocusSignal, active = true,
}: {
  container: HTMLDivElement | null;
  chart: IChartApi | null;
  /** Any main-series presentation: only price/coordinate conversion is used. */
  /**
   * Any main-series presentation: only price/coordinate conversion is used.
   *
   * `Baseline` joined the union when the baseline chart type arrived. Nothing
   * here reads a series OPTION — only `priceToCoordinate` and its inverse,
   * which every series kind has — so widening it costs nothing.
   */
  series: ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line">
    | ISeriesApi<"Area"> | ISeriesApi<"Baseline"> | null;
  candles: Candle[];
  interval: Interval;
  tool: DrawingTool;
  /** creation finished — the caller reverts the rail to the cursor */
  onToolDone: () => void;
  drawings: Drawing[];
  /**
   * `gesture` groups consecutive changes into one undo step.
   *
   * A drag emits a change per pointer sample; recording each would make one
   * drag consume the whole undo depth, so Cmd+Z would rewind a few pixels
   * rather than the drag. The store collapses runs that share a gesture id —
   * see `lib/drawingHistory`.
   */
  onChange: (next: Drawing[], gesture?: string | null) => void;
  magnet: boolean;
  locked: boolean;
  hidden: boolean;
  /**
   * Which drawing is selected, so the workspace's keyboard and context menu
   * can act on it. The canvas remains the owner of the selection — this only
   * reports it.
   */
  onSelectionChange?: (id: string | null) => void;
  /** A right-click landed on a drawing (or on empty chart, with a null id). */
  onContextMenu?: (event: {
    x: number; y: number; drawingId: string | null; price: number | null;
    /** Which strip was clicked, so the workspace knows which menu to build. */
    region: "plot" | "axis";
  }) => void;
  /**
   * Bumped to move focus into the selected drawing's style bar.
   *
   * The bar IS this product's per-drawing settings — colour, width, dash,
   * fill, lock, delete — and it appears beside whatever is selected. What it
   * lacked was a way in from the keyboard, and a menu item that named it. The
   * context menu's "Style…" bumps this; a signal rather than a boolean because
   * focusing is an event, not a state the workspace can hold.
   */
  styleFocusSignal?: number;
  /**
   * Whether this pane has the workspace's focus.
   *
   * `DrawingCanvas` mounts once per pane and this effect listens on `window`,
   * so a four-pane layout had four listeners, each with its own selection: one
   * Delete removed a drawing in every pane that had one selected. The
   * workspace's own keyboard layer deliberately delegates Delete here, so the
   * fix is for the inactive panes to decline it.
   */
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => { onSelectionChangeRef.current?.(selected); }, [selected]);
  const [style, setStyle] = useState(DEFAULT_STYLE);

  // Refs mirror state for use inside the imperative pointer/raf handlers.
  const draftRef = useRef<{ tool: DrawingTool; points: Anchor[] } | null>(null);
  const previewRef = useRef<Anchor | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const hoverRef = useRef<string | null>(null);
  const drawingsRef = useRef(drawings);
  const selectedRef = useRef(selected);
  const toolRef = useRef(tool);
  const styleRef = useRef(style);
  const lockedRef = useRef(locked);
  const hiddenRef = useRef(hidden);
  const magnetRef = useRef(magnet);
  drawingsRef.current = drawings;
  selectedRef.current = selected;
  toolRef.current = tool;
  styleRef.current = style;
  lockedRef.current = locked;
  hiddenRef.current = hidden;
  magnetRef.current = magnet;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const onToolDoneRef = useRef(onToolDone);
  onToolDoneRef.current = onToolDone;

  // ── time ↔ logical-index mapping ──────────────────────────────────────────
  // Stored anchors use bar time; the chart positions by logical index. Bars may
  // have gaps, so interpolate inside the data and extrapolate past its edges
  // (drawings are allowed to extend into the future).
  const times = useMemo(() => candles.map((c) => c.openTime / 1000), [candles]);
  const stepSec = INTERVAL_SEC[interval];

  const timeToLogical = useCallback((t: number): number => {
    const n = times.length;
    if (n === 0) return 0;
    if (t <= times[0]!) return (t - times[0]!) / stepSec;
    if (t >= times[n - 1]!) return n - 1 + (t - times[n - 1]!) / stepSec;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid; else hi = mid;
    }
    const span = times[hi]! - times[lo]!;
    return span > 0 ? lo + (t - times[lo]!) / span : lo;
  }, [times, stepSec]);

  const logicalToTime = useCallback((l: number): number => {
    const n = times.length;
    if (n === 0) return 0;
    if (l <= 0) return times[0]! + l * stepSec;
    if (l >= n - 1) return times[n - 1]! + (l - (n - 1)) * stepSec;
    const lo = Math.floor(l);
    const frac = l - lo;
    return times[lo]! + (times[lo + 1]! - times[lo]!) * frac;
  }, [times, stepSec]);

  const toPx = useCallback((a: Anchor): Pt => {
    const x = chart?.timeScale().logicalToCoordinate(timeToLogical(a.time) as Logical);
    const y = series?.priceToCoordinate(a.price);
    return { x: x ?? -1e5, y: y ?? -1e5 };
  }, [chart, series, timeToLogical]);

  /** Pixel → anchor, with bar snapping and optional OHLC magnet. */
  const toAnchor = useCallback((x: number, y: number): Anchor => {
    const logical = chart?.timeScale().coordinateToLogical(x) ?? 0;
    const price = series?.coordinateToPrice(y) ?? 0;
    const snappedLogical = Math.round(logical as number);
    const time = logicalToTime(snappedLogical);
    if (!magnetRef.current) return { time, price: Number(price) };
    const bar = candles[snappedLogical];
    if (!bar) return { time, price: Number(price) };
    // Magnet: jump to whichever of O/H/L/C is nearest in pixels.
    let best = Number(price);
    let bestPx = Infinity;
    for (const p of [bar.open, bar.high, bar.low, bar.close]) {
      const py = series?.priceToCoordinate(p);
      if (py == null) continue;
      const d = Math.abs(py - y);
      if (d < bestPx) { bestPx = d; best = p; }
    }
    return { time, price: bestPx <= 24 ? best : Number(price) };
  }, [chart, series, candles, logicalToTime]);

  // ── hit testing ───────────────────────────────────────────────────────────
  const hitTest = useCallback((p: Pt): { id: string; handle: number | null } | null => {
    const list = drawingsRef.current;
    // Topmost first, and handles of the selected drawing win over any body.
    const ordered = [...list].reverse();
    const sel = list.find((d) => d.id === selectedRef.current);
    if (sel && !sel.locked && !sel.hidden) {
      for (let i = 0; i < sel.points.length; i++) {
        const h = toPx(sel.points[i]!);
        if (Math.hypot(p.x - h.x, p.y - h.y) <= HIT_PX + 2) return { id: sel.id, handle: i };
      }
    }
    for (const d of ordered) {
      if (d.hidden) continue;
      if (distToDrawing(p, d, toPx) <= HIT_PX) return { id: d.id, handle: null };
    }
    return null;
  }, [toPx]);

  // ── committing drawings ───────────────────────────────────────────────────
  const commit = useCallback((tl: DrawingTool, points: Anchor[]) => {
    let pts = points;
    // Long/short carry a third, draggable stop anchor derived at 2:1 R:R.
    if (tl === "long" || tl === "short") {
      const risk = (points[1]!.price - points[0]!.price) / 2;
      pts = [...points, { time: points[1]!.time, price: points[0]!.price - risk }];
    }
    let text: string | undefined;
    if (TEXT_TOOLS.has(tl)) {
      const input = window.prompt(tl === "callout" ? "Callout text:" : "Text:", "");
      if (input === null) { draftRef.current = null; onToolDoneRef.current(); return; }
      text = input;
    }
    const d: Drawing = {
      id: newId(),
      tool: tl,
      points: pts,
      style: { ...styleRef.current, ...(text !== undefined ? { text } : {}) },
    };
    // Measurement tools are one-at-a-time, like TV's measure.
    const kept = EPHEMERAL_TOOLS.has(tl)
      ? drawingsRef.current.filter((x) => x.tool !== tl)
      : drawingsRef.current;
    onChangeRef.current([...kept, d]);
    draftRef.current = null;
    previewRef.current = null;
    setSelected(d.id);
    onToolDoneRef.current();
  }, []);

  // Switching tools clears an unfinished draft and any ephemeral measurement.
  useEffect(() => {
    draftRef.current = null;
    previewRef.current = null;
    if (tool !== "ruler") {
      const cleaned = drawingsRef.current.filter((d) => !EPHEMERAL_TOOLS.has(d.tool));
      if (cleaned.length !== drawingsRef.current.length) onChangeRef.current(cleaned);
    }
    if (tool !== "cursor") setSelected(null);
  }, [tool]);

  // ── pointer handling (capture phase on the chart container) ───────────────
  useEffect(() => {
    if (!container || !chart || !series) return;
    const rectOf = (e: MouseEvent): Pt => {
      const r = container.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inPlot = (p: Pt): boolean => {
      const w = container.clientWidth - (chart.priceScale("right").width() ?? 0);
      const h = container.clientHeight - (chart.timeScale().height() ?? 0);
      return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
    };

    /** Which strip of the chart a point is in: the plot, the price axis, or the time axis. */
    const regionOf = (p: Pt): "plot" | "axis" | "time" => {
      const w = container.clientWidth - (chart.priceScale("right").width() ?? 0);
      const h = container.clientHeight - (chart.timeScale().height() ?? 0);
      if (p.y > h) return "time";
      return p.x > w ? "axis" : "plot";
    };

    /*
     * Right-click reports upward rather than opening a menu here.
     *
     * The canvas knows what was hit and what price the pointer is over; it
     * does not know whether Replay is running, whether manual trading is
     * enabled, or what a menu should offer. Those are workspace facts, so the
     * workspace builds the payload — see `lib/menuPayloads`.
     */
    const onContext = (e: MouseEvent): void => {
      const handler = onContextMenuRef.current;
      if (!handler) return;
      const p = rectOf(e);
      const region = regionOf(p);
      // The time scale is the one strip with nothing to offer, so it keeps the
      // browser's own menu rather than being given an empty product one.
      if (region === "time") return;
      e.preventDefault();
      if (region === "axis") {
        // The price axis has its own short menu — scale mode and reset — and
        // no drawing under it. It used to return BEFORE `preventDefault`, so
        // right-clicking the axis opened Chrome's menu over the chart.
        handler({ x: e.clientX, y: e.clientY, drawingId: null, price: null, region: "axis" });
        return;
      }
      const hit = hiddenRef.current ? null : hitTest(p);
      // Including the miss: right-clicking empty chart used to leave the
      // previous drawing selected, so the chart menu opened over a drawing
      // still wearing its handles and its style bar.
      setSelected(hit?.id ?? null);
      handler({
        x: e.clientX, y: e.clientY,
        drawingId: hit?.id ?? null,
        price: toAnchor(p.x, p.y).price,
        region: "plot",
      });
    };

    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0 || hiddenRef.current) return;
      const p = rectOf(e);
      if (!inPlot(p)) return;
      const t = toolRef.current;

      if (t === "eraser") {
        const hit = hitTest(p);
        if (hit) {
          onChangeRef.current(drawingsRef.current.filter((d) => d.id !== hit.id));
          setSelected(null);
        }
        e.stopPropagation(); e.preventDefault();
        return;
      }

      if (t === "cursor") {
        const hit = hitTest(p);
        if (hit) {
          const d = drawingsRef.current.find((x) => x.id === hit.id)!;
          setSelected(hit.id);
          if (!lockedRef.current && !d.locked) {
            dragRef.current = {
              handle: hit.handle,
              startPointer: toAnchor(p.x, p.y),
              startPoints: d.points.map((a) => ({ ...a })),
              moved: false,
              gesture: `drag:${hit.id}:${Date.now()}`,
            };
          }
          e.stopPropagation(); e.preventDefault();
        } else {
          setSelected(null); // empty space: let the chart pan
        }
        return;
      }

      // ── creating ──
      e.stopPropagation(); e.preventDefault();
      const anchor = toAnchor(p.x, p.y);
      const need = TOOL_POINTS[t];
      const draft = draftRef.current;

      if (t === "brush") {
        draftRef.current = { tool: t, points: [anchor] };
        return;
      }
      if (need === 0) { // path: click to add, double-click to finish
        draftRef.current = draft && draft.tool === t
          ? { tool: t, points: [...draft.points, anchor] }
          : { tool: t, points: [anchor] };
        return;
      }
      if (need === 1) { commit(t, [anchor]); return; }

      const points = draft && draft.tool === t ? [...draft.points, anchor] : [anchor];
      if (points.length >= need) commit(t, points.slice(0, need));
      else draftRef.current = { tool: t, points };
    };

    const onMove = (e: MouseEvent): void => {
      const p = rectOf(e);
      previewRef.current = toAnchor(p.x, p.y);

      const drag = dragRef.current;
      if (drag) {
        drag.moved = true;
        const cur = toAnchor(p.x, p.y);
        const list = drawingsRef.current.map((d) => {
          if (d.id !== selectedRef.current) return d;
          if (drag.handle !== null) {
            const pts = d.points.map((a, i) => (i === drag.handle ? cur : a));
            return { ...d, points: pts };
          }
          const dt = cur.time - drag.startPointer.time;
          const dp = cur.price - drag.startPointer.price;
          return {
            ...d,
            points: drag.startPoints.map((a) => ({ time: a.time + dt, price: a.price + dp })),
          };
        });
        // One gesture id for the whole drag, so the sixty changes a drag emits
        // collapse into the single undo step the user means by "undo that".
        onChangeRef.current(list, drag.gesture);
        e.stopPropagation(); e.preventDefault();
        return;
      }

      // Freehand brush records while the button is held.
      const draft = draftRef.current;
      if (draft?.tool === "brush" && e.buttons === 1) {
        draft.points.push(previewRef.current);
        e.stopPropagation();
        return;
      }
      if (toolRef.current === "cursor" && !hiddenRef.current) {
        const hit = hitTest(p);
        hoverRef.current = hit?.id ?? null;
        container.style.cursor = hit ? "pointer" : "";
      } else {
        container.style.cursor = toolRef.current === "cursor" ? "" : "crosshair";
      }
    };

    const onUp = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (drag) {
        dragRef.current = null;
        e.stopPropagation();
        return;
      }
      const draft = draftRef.current;
      if (!draft) return;
      const p = rectOf(e);
      if (draft.tool === "brush") {
        if (draft.points.length > 1) commit("brush", draft.points);
        else draftRef.current = null;
        e.stopPropagation();
        return;
      }
      // Drag-to-create: press, drag, release completes a two-point tool.
      const need = TOOL_POINTS[draft.tool];
      if (need === 2 && draft.points.length === 1) {
        const start = toPx(draft.points[0]!);
        if (Math.hypot(p.x - start.x, p.y - start.y) > 6) {
          commit(draft.tool, [draft.points[0]!, toAnchor(p.x, p.y)]);
          e.stopPropagation();
        }
      }
    };

    const onDouble = (e: MouseEvent): void => {
      const draft = draftRef.current;
      if (draft && TOOL_POINTS[draft.tool] === 0 && draft.points.length >= 2) {
        commit(draft.tool, draft.points);
        e.stopPropagation(); e.preventDefault();
      }
    };

    const onLeave = (): void => { previewRef.current = null; };

    container.addEventListener("mousedown", onDown, true);
    container.addEventListener("contextmenu", onContext, true);
    container.addEventListener("mousemove", onMove, true);
    container.addEventListener("mouseup", onUp, true);
    container.addEventListener("dblclick", onDouble, true);
    container.addEventListener("mouseleave", onLeave);
    // A drag that ends outside the chart must still finish cleanly.
    window.addEventListener("mouseup", onUp, true);
    return () => {
      container.removeEventListener("mousedown", onDown, true);
      container.removeEventListener("contextmenu", onContext, true);
      container.removeEventListener("mousemove", onMove, true);
      container.removeEventListener("mouseup", onUp, true);
      container.removeEventListener("dblclick", onDouble, true);
      container.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("mouseup", onUp, true);
      container.style.cursor = "";
    };
  }, [container, chart, series, hitTest, toAnchor, toPx, commit]);

  // Escape cancels, Delete removes the selection — in the FOCUSED pane only.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!activeRef.current) return;
      const el = e.target as HTMLElement | null;
      // The same guard the shared keyboard layer applies, rather than a
      // narrower copy of it: a `<select>` and a marked editor surface own
      // their keys here for exactly the reasons they own them there.
      if (isTypingTarget(el ? {
        tagName: el.tagName,
        isContentEditable: el.isContentEditable,
        role: el.getAttribute?.("role") ?? null,
        closestEditor: el.closest?.("[data-owns-keys]") != null,
      } : null)) return;
      // A dialog is modal to this listener too.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (e.key === "Escape") {
        if (draftRef.current) { draftRef.current = null; onToolDoneRef.current(); }
        else setSelected(null);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current && !lockedRef.current) {
        e.preventDefault();
        onChangeRef.current(drawingsRef.current.filter((d) => d.id !== selectedRef.current));
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── render loop ───────────────────────────────────────────────────────────
  // The chart exposes no "scales changed" event covering price-scale drags, so
  // sample a cheap fingerprint each frame and repaint only when it moves.
  useEffect(() => {
    if (!chart || !series || !container) return;
    let raf = 0;
    let last = "";
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const x0 = chart.timeScale().logicalToCoordinate(0 as Logical);
      const y0 = series.priceToCoordinate(candles[candles.length - 1]?.close ?? 1);
      const x1 = chart.timeScale().logicalToCoordinate(100 as Logical);
      const fp = `${w}|${h}|${x0}|${x1}|${y0}|${drawings.length}|${selected}|${hidden}` +
        `|${draftRef.current?.points.length ?? -1}|${previewRef.current?.time ?? 0}` +
        `|${previewRef.current?.price ?? 0}|${hoverRef.current}|${geometryDigest(drawings)}`;
      if (fp === last) return;
      last = fp;
      paint(canvas, w, h);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, container, drawings, selected, hidden, candles]);

  const paint = useCallback((canvas: HTMLCanvasElement, w: number, h: number): void => {
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (hidden) return;

    // Keep marks out of the price/time axes.
    const plotW = w - (chart?.priceScale("right").width() ?? 0);
    const plotH = h - (chart?.timeScale().height() ?? 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();

    for (const d of drawings) {
      // A drawing hidden on its own is not drawn. It is still in the list, so
      // it can be un-hidden from the drawings panel; it is simply not on the
      // chart, and `hitTest` agrees so it cannot be grabbed by an empty click.
      if (d.hidden) continue;
      drawOne(ctx, d, toPx, plotW, plotH, d.id === selected, d.id === hoverRef.current);
    }
    // In-progress geometry follows the pointer.
    const draft = draftRef.current;
    if (draft && previewRef.current) {
      const pts = draft.tool === "brush" || TOOL_POINTS[draft.tool] === 0
        ? draft.points
        : [...draft.points, previewRef.current];
      if (pts.length >= 1) {
        drawOne(
          ctx,
          { id: "draft", tool: draft.tool, points: pts, style: { ...style, dashed: true } },
          toPx, plotW, plotH, false, false
        );
      }
    }
    ctx.restore();
  }, [drawings, selected, hidden, style, toPx, chart]);

  // Style edits apply to the selected drawing, else become the new default.
  const applyStyle = (patch: Partial<typeof style>): void => {
    setStyle((s) => ({ ...s, ...patch }));
    if (!selected) return;
    onChange(drawings.map((d) => (d.id === selected ? { ...d, style: { ...d.style, ...patch } } : d)));
  };

  const sel = drawings.find((d) => d.id === selected) ?? null;
  const selPx = sel ? toPx(sel.points[0]!) : null;

  const styleBarRef = useRef<HTMLDivElement>(null);
  const styleFocusRef = useRef(styleFocusSignal);
  useEffect(() => {
    if (styleFocusSignal === styleFocusRef.current) return;
    styleFocusRef.current = styleFocusSignal;
    styleBarRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [styleFocusSignal, sel]);

  return (
    <>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10" />
      {sel && selPx && !hidden && !sel.hidden && (
        <div
          ref={styleBarRef}
          role="toolbar"
          aria-label="Drawing style"
          className="absolute z-20 flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-1 shadow-xl"
          style={{
            left: Math.max(4, Math.min(selPx.x, (container?.clientWidth ?? 400) - 300)),
            top: Math.max(4, selPx.y - 44),
          }}
        >
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => applyStyle({ color: c })}
              className={`h-4 w-4 rounded-full border ${sel.style.color === c ? "border-ink" : "border-transparent"}`}
              style={{ background: c }}
              title={c}
            />
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          {[1, 2, 3].map((wd) => (
            <button
              key={wd}
              onClick={() => applyStyle({ width: wd })}
              className={`px-1 text-[11px] ${sel.style.width === wd ? "text-accent" : "text-ink-muted hover:text-ink"}`}
              title={`${wd}px`}
            >
              {wd}
            </button>
          ))}
          {/*
            Anchored VWAP's standard-deviation bands, on the tool that has
            them. A control here rather than in a dialog for the same reason
            the colour swatches are here: the bar IS this product's per-drawing
            settings, and it appears beside whatever is selected.
          */}
          {sel.tool === "avwap" && (
            <>
              <span className="mx-0.5 h-4 w-px bg-border" />
              {([0, 1, 2] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => applyStyle({ bands: n })}
                  className={`px-1 text-[11px] ${
                    (sel.style.bands ?? 0) === n ? "text-accent" : "text-ink-muted hover:text-ink"
                  }`}
                  aria-pressed={(sel.style.bands ?? 0) === n}
                  aria-label={n === 0 ? "No deviation bands" : `${n} standard-deviation band${n === 1 ? "" : "s"}`}
                  title={n === 0 ? "No bands" : `±${n}σ`}
                >
                  {n === 0 ? "0σ" : `${n}σ`}
                </button>
              ))}
            </>
          )}
          <button
            onClick={() => applyStyle({ dashed: !sel.style.dashed })}
            className={`px-1 text-[11px] ${sel.style.dashed ? "text-accent" : "text-ink-muted hover:text-ink"}`}
            title="Dashed"
          >
            ┄
          </button>
          <button
            onClick={() => applyStyle({ filled: !sel.style.filled })}
            className={`flex h-5 w-5 items-center justify-center rounded ${sel.style.filled ? "text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"}`}
            title="Fill"
            aria-label={sel.style.filled ? "Remove the fill" : "Fill the shape"}
            aria-pressed={Boolean(sel.style.filled)}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="1.5" y="1.5" width="9" height="9" rx="1"
                fill={sel.style.filled ? "currentColor" : "none"}
                stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <button
            onClick={() => onChange(drawings.map((d) => (d.id === selected ? { ...d, locked: !d.locked } : d)))}
            className={`flex h-5 w-5 items-center justify-center rounded ${sel.locked ? "text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"}`}
            title={sel.locked ? "Unlock" : "Lock"}
            aria-label={sel.locked ? "Unlock this drawing" : "Lock this drawing"}
            aria-pressed={Boolean(sel.locked)}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor"
              strokeWidth="1.2" aria-hidden="true">
              <rect x="2" y="5.4" width="8" height="5.1" rx="1" />
              {/* An open shackle leans clear of the body, so locked and unlocked
                  differ in SHAPE and not only in tint. */}
              <path d={sel.locked ? "M4 5.4V3.9a2 2 0 0 1 4 0v1.5" : "M4 5.4V3.9a2 2 0 0 1 3.9-.5"} />
            </svg>
          </button>
          <button
            onClick={() => { onChange(drawings.filter((d) => d.id !== selected)); setSelected(null); }}
            className="flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-down/15 hover:text-down"
            title="Delete (Del)"
            aria-label="Delete this drawing"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

// ── per-tool geometry ───────────────────────────────────────────────────────

type ToPx = (a: Anchor) => Pt;

/** Extend a→b far past b (used for rays and infinite lines). */
function far(a: Pt, b: Pt, span: number): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: b.x + (dx / len) * span, y: b.y + (dy / len) * span };
}

function distToDrawing(p: Pt, d: Drawing, toPx: ToPx): number {
  const q = d.points.map(toPx);
  const a = q[0]!;
  const b = q[1] ?? a;
  const span = 6000;
  switch (d.tool) {
    case "trend": case "arrow": case "pricerange": case "daterange": case "ruler":
      return distToSegment(p, a, b);
    case "ray": return distToRay(p, a, b);
    case "extended": return distToLine(p, a, b);
    case "hline": return Math.abs(p.y - a.y);
    case "hray": return p.x >= a.x - HIT_PX ? Math.abs(p.y - a.y) : Math.hypot(p.x - a.x, p.y - a.y);
    case "vline": return Math.abs(p.x - a.x);
    // The anchor is the grabbable part; the computed line is an overlay and is
    // not on this canvas to be hit at all.
    case "avwap": return Math.hypot(p.x - a.x, p.y - a.y);
    case "rect": case "long": case "short":
      return distToRect(p, a, b, !!d.style.filled || d.tool !== "rect");
    case "ellipse": return distToEllipse(p, a, b, !!d.style.filled);
    case "triangle": {
      const c = q[2] ?? b;
      return Math.min(distToSegment(p, a, b), distToSegment(p, b, c), distToSegment(p, c, a));
    }
    case "parallel": {
      const c = q[2] ?? b;
      const off = c.y - (a.y + b.y) / 2;
      return Math.min(
        distToSegment(p, a, b),
        distToSegment(p, { x: a.x, y: a.y + off }, { x: b.x, y: b.y + off })
      );
    }
    case "pitchfork": {
      const c = q[2] ?? b;
      const mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      return Math.min(
        distToRay(p, a, mid),
        distToRay(p, b, far(a, mid, span)),
        distToSegment(p, b, c)
      );
    }
    case "fib": case "fibext": {
      const anchorPts = d.tool === "fib" ? [a, b] : [a, b, q[2] ?? b];
      const base = anchorPts[anchorPts.length - 2]!;
      const tip = anchorPts[anchorPts.length - 1]!;
      const levels = d.tool === "fib" ? FIB_LEVELS : FIB_EXT_LEVELS;
      const x1 = Math.min(a.x, tip.x), x2 = Math.max(a.x, tip.x);
      if (p.x < x1 - HIT_PX || p.x > x2 + span) return Infinity;
      const from = d.tool === "fib" ? a.y : tip.y;
      const range = d.tool === "fib" ? b.y - a.y : -(base.y - a.y);
      return Math.min(...levels.map((l) => Math.abs(p.y - (from + range * l))));
    }
    case "path": case "brush": {
      let best = Infinity;
      for (let i = 1; i < q.length; i++) best = Math.min(best, distToSegment(p, q[i - 1]!, q[i]!));
      return best;
    }
    case "text": case "callout": case "pricelabel":
      return Math.hypot(p.x - a.x, p.y - a.y) <= 40 ? 0 : Infinity;
    default:
      return Infinity;
  }
}

function drawOne(
  ctx: CanvasRenderingContext2D, d: Drawing, toPx: ToPx,
  w: number, h: number, selected: boolean, hovered: boolean
): void {
  const q = d.points.map(toPx);
  if (q.length === 0) return;
  const a = q[0]!;
  const b = q[1] ?? a;
  const color = d.style.color;
  const span = 6000;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = d.style.width + (hovered && !selected ? 0.8 : 0);
  ctx.setLineDash(d.style.dashed ? [6, 4] : []);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.font = "11px ui-monospace, monospace";

  const line = (p1: Pt, p2: Pt): void => {
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  };
  const label = (text: string, x: number, y: number, bg = color): void => {
    const pad = 3;
    const tw = ctx.measureText(text).width;
    ctx.setLineDash([]);
    ctx.fillStyle = bg;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(x, y - 11, tw + pad * 2, 15);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0b0e14";
    ctx.fillText(text, x + pad, y);
    ctx.fillStyle = color;
  };
  const fillAlpha = (fn: () => void, alpha: number): void => {
    ctx.save(); ctx.globalAlpha = alpha; fn(); ctx.restore();
  };

  switch (d.tool) {
    case "trend": line(a, b); break;
    case "ray": line(a, far(a, b, span)); break;
    case "extended": line(far(b, a, span), far(a, b, span)); break;
    case "arrow": {
      line(a, b);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = 11;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "hline":
      line({ x: 0, y: a.y }, { x: w, y: a.y });
      label(fmtPrice(d.points[0]!.price), w - 62, a.y - 3);
      break;
    case "hray":
      line(a, { x: w, y: a.y });
      label(fmtPrice(d.points[0]!.price), w - 62, a.y - 3);
      break;
    case "vline": line({ x: a.x, y: 0 }, { x: a.x, y: h }); break;
    /*
     * Anchored VWAP: the canvas draws only the ANCHOR.
     *
     * The line itself is a chart overlay (`lib/anchoredVwap`), so it sits on
     * the price scale, joins the legend at the right precision, and is drawn
     * by the same renderer as every other series. What the canvas owns is what
     * makes it a drawing: a grabbable point at the bar it starts from, and a
     * short marker so the anchor is visible even where the line is far away.
     */
    case "avwap": {
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      line({ x: a.x, y: a.y - 8 }, { x: a.x, y: a.y + 8 });
      break;
    }
    case "rect": {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
      if (d.style.filled) fillAlpha(() => ctx.fillRect(x, y, rw, rh), 0.15);
      ctx.strokeRect(x, y, rw, rh);
      break;
    }
    case "ellipse": {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      if (d.style.filled) fillAlpha(() => ctx.fill(), 0.15);
      ctx.stroke();
      break;
    }
    case "triangle": {
      const c = q[2] ?? b;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
      if (d.style.filled) fillAlpha(() => ctx.fill(), 0.15);
      ctx.stroke();
      break;
    }
    case "path": case "brush": {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (let i = 1; i < q.length; i++) ctx.lineTo(q[i]!.x, q[i]!.y);
      ctx.stroke();
      break;
    }
    case "parallel": {
      const c = q[2] ?? b;
      const off = c.y - (a.y + b.y) / 2;
      const a2 = { x: a.x, y: a.y + off }, b2 = { x: b.x, y: b.y + off };
      fillAlpha(() => {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b2.x, b2.y); ctx.lineTo(a2.x, a2.y);
        ctx.closePath(); ctx.fill();
      }, 0.12);
      line(a, b); line(a2, b2);
      break;
    }
    case "pitchfork": {
      const c = q[2] ?? b;
      const mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      line(b, c);
      line(a, far(a, mid, span));
      const dx = mid.x - a.x, dy = mid.y - a.y;
      line(b, { x: b.x + dx * 40, y: b.y + dy * 40 });
      line(c, { x: c.x + dx * 40, y: c.y + dy * 40 });
      break;
    }
    case "fib": {
      const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
      const p0 = d.points[0]!.price, p1 = d.points[1]!.price;
      for (let i = 0; i < FIB_LEVELS.length; i++) {
        const l = FIB_LEVELS[i]!;
        const y = a.y + (b.y - a.y) * l;
        const price = p0 + (p1 - p0) * l;
        if (i > 0) {
          const yPrev = a.y + (b.y - a.y) * FIB_LEVELS[i - 1]!;
          fillAlpha(() => ctx.fillRect(x1, Math.min(y, yPrev), x2 - x1, Math.abs(y - yPrev)),
            i % 2 ? 0.07 : 0.03);
        }
        line({ x: x1, y }, { x: x2, y });
        ctx.fillStyle = color;
        ctx.fillText(`${(l * 100).toFixed(1)}%  ${fmtPrice(price)}`, x2 + 5, y - 2);
      }
      break;
    }
    case "fibext": {
      const c = q[2] ?? b;
      const p0 = d.points[0]!.price, p1 = d.points[1]!.price;
      const p2 = d.points[2]?.price ?? p1;
      const range = p1 - p0;
      const yRange = b.y - a.y;
      const x1 = Math.min(a.x, c.x), x2 = Math.max(a.x, c.x);
      line(a, b); line(b, c);
      for (const l of FIB_EXT_LEVELS) {
        const y = c.y + yRange * l;
        line({ x: x1, y }, { x: Math.max(x2, x1 + 40), y });
        ctx.fillStyle = color;
        ctx.fillText(`${(l * 100).toFixed(1)}%  ${fmtPrice(p2 + range * l)}`, Math.max(x2, x1 + 40) + 5, y - 2);
      }
      break;
    }
    case "pricerange": case "daterange": case "ruler": {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
      const dp = d.points[1]!.price - d.points[0]!.price;
      const pct = d.points[0]!.price !== 0 ? (dp / d.points[0]!.price) * 100 : 0;
      const bars = Math.round((d.points[1]!.time - d.points[0]!.time) /
        Math.max(1, Math.abs(d.points[1]!.time - d.points[0]!.time) || 1));
      const up = dp >= 0;
      const tone = up ? "#2ebd85" : "#f6465d";
      ctx.strokeStyle = tone; ctx.fillStyle = tone;
      fillAlpha(() => ctx.fillRect(x, y, rw, rh), 0.14);
      ctx.strokeRect(x, y, rw, rh);
      if (d.tool !== "daterange") line({ x: a.x, y: a.y }, { x: a.x, y: b.y });
      const secs = Math.abs(d.points[1]!.time - d.points[0]!.time);
      const text = d.tool === "daterange"
        ? `${fmtDuration(secs)}`
        : d.tool === "pricerange"
          ? `${up ? "+" : ""}${fmtPrice(dp)} (${pct.toFixed(2)}%)`
          : `${up ? "+" : ""}${fmtPrice(dp)} (${pct.toFixed(2)}%) · ${fmtDuration(secs)}`;
      ctx.fillStyle = tone;
      label(text, x + rw / 2 - 60, y + rh / 2, tone);
      void bars;
      break;
    }
    case "long": case "short": {
      const entry = d.points[0]!;
      const target = d.points[1]!;
      const stop = d.points[2] ?? { time: target.time, price: entry.price };
      const pe = toPx(entry), pt = toPx(target), ps = toPx(stop);
      const x1 = Math.min(pe.x, pt.x), x2 = Math.max(pe.x, pt.x);
      const rw = Math.max(6, x2 - x1);
      ctx.setLineDash([]);
      // profit zone (entry → target), risk zone (entry → stop)
      fillAlpha(() => { ctx.fillStyle = "#2ebd85"; ctx.fillRect(x1, Math.min(pe.y, pt.y), rw, Math.abs(pt.y - pe.y)); }, 0.18);
      fillAlpha(() => { ctx.fillStyle = "#f6465d"; ctx.fillRect(x1, Math.min(pe.y, ps.y), rw, Math.abs(ps.y - pe.y)); }, 0.18);
      ctx.strokeStyle = "#9aa4b6";
      line({ x: x1, y: pe.y }, { x: x1 + rw, y: pe.y });
      const risk = Math.abs(entry.price - stop.price);
      const reward = Math.abs(target.price - entry.price);
      const rr = risk > 0 ? reward / risk : 0;
      ctx.fillStyle = "#e6e9ef";
      label(`${d.tool === "long" ? "LONG" : "SHORT"}  R:R ${rr.toFixed(2)}`, x1 + 4, Math.min(pe.y, pt.y) - 6, "#9aa4b6");
      ctx.fillStyle = "#2ebd85";
      ctx.fillText(`TP ${fmtPrice(target.price)}`, x1 + 4, pt.y + (pt.y < pe.y ? 12 : -4));
      ctx.fillStyle = "#f6465d";
      ctx.fillText(`SL ${fmtPrice(stop.price)}`, x1 + 4, ps.y + (ps.y > pe.y ? -4 : 12));
      break;
    }
    case "text": {
      ctx.fillStyle = color;
      ctx.font = "13px ui-monospace, monospace";
      ctx.fillText(d.style.text ?? "", a.x + 4, a.y);
      break;
    }
    case "callout": {
      const text = d.style.text ?? "";
      ctx.font = "12px ui-monospace, monospace";
      const tw = ctx.measureText(text).width + 14;
      const bx = a.x + 26, by = a.y - 44;
      line(a, { x: bx, y: by + 22 });
      fillAlpha(() => { ctx.fillStyle = color; ctx.fillRect(bx, by, tw, 24); }, 0.18);
      ctx.strokeRect(bx, by, tw, 24);
      ctx.fillStyle = color;
      ctx.fillText(text, bx + 7, by + 16);
      break;
    }
    case "pricelabel": {
      const text = fmtPrice(d.points[0]!.price);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
      ctx.fill();
      label(text, a.x + 8, a.y + 4);
      break;
    }
    default: break;
  }

  // Anchor handles for the selected drawing.
  if (selected) {
    ctx.setLineDash([]);
    for (const p of q) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_PX, 0, Math.PI * 2);
      ctx.fillStyle = "#121722";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function fmtDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const d = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${m}m`;
  return `${m}m`;
}
