"use client";
import type React from "react";
import type { MagnetMode } from "@/components/tv/DrawingToolbar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts";
import type { Candle } from "@/lib/types";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import { fmtPrice } from "@/lib/format";
import { isTypingTarget } from "@/lib/shortcuts";
import {
  DEFAULT_STYLE, EPHEMERAL_TOOLS, FIB_EXT_LEVELS, FIB_LEVELS, FILLABLE_TOOLS, NEW_TEXT_SIZE, TEXT_SIZES,
  TEXT_TOOLS, TOOL_POINTS,
  applyDrawingTemplate, currentIconGlyph, defaultDrawingTemplate, distToEllipse, distToLine, distToRay,
  distToRect, drawingVisibleOnTimeframe, distToSegment, isCursorMode, loadDrawingTemplates, newId,
  type Anchor, type Drawing, type DrawingExtend, type DrawingStyle, type DrawingTool, type Pt,
} from "@/lib/drawings";
import { DEFAULT_VP_RANGE_STYLE } from "@/lib/volumeProfileDrawing";
import {
  CHART_FONT, chartInkMuted, chartNegative, chartPositive, chartSurface, readableOn,
} from "@/lib/chartTheme";
import { useAsk } from "@/components/AskDialog";
import { ColourPalette, DashPicker, FontSizePicker, PopoverButton, WidthPicker } from "@/components/ui";
import {
  deleteDrawingTemplateAsk, DrawingTemplateMenuPanel, saveDrawingTemplateAs,
} from "@/components/tv/DrawingTemplateMenu";
import { clampPlacement, toolbarPlacement, type Box } from "@/lib/drawingToolbarPlacement";
import { recallJson, rememberJson } from "@/lib/browserStorage";
import { opaque, withAlpha } from "@/lib/colorAlpha";
import { DrawingAxisLabelsPrimitive, drawingAxisTags } from "@/lib/drawingAxisLabels";
import { coordinateAtLogical, timeMap } from "@/lib/drawingTimeMap";

/*
 * A12: the floating toolbar's two control shapes, one height.
 *
 * The reference's bar is 38px of 38×38 controls. This one mixed 34px outlined
 * buttons with 28px icon buttons, so its row of controls had two baselines.
 * Both are `.tvc-control` — transparent, with the inset chip on hover — as
 * every other toolbar button in the workstation is.
 *
 * W2A-05: and in the reference's INK, not muted. Measured on Premium, every
 * widget's glyph is rgb(219) at rest — the bar is a set of tools in hand, not
 * secondary chrome — and each glyph sits in a 28px box. This bar's were
 * 16px in the muted grey, so it read as disabled next to the reference's.
 */
const BAR_ICON_BUTTON =
  "tvc-control flex h-[38px] w-[38px] items-center justify-center rounded-md text-ink";
const BAR_TEXT_BUTTON =
  "tvc-control flex h-[38px] min-w-[38px] items-center justify-center gap-2 rounded-md px-2 text-[13px] text-ink";

/**
 * A bar glyph: a 28px box drawing a 24-unit icon at one pixel per unit, so
 * the art is the reference's ~18px with a 1.25px line rather than 16px at
 * two-thirds scale.
 */
function BarGlyph({ children, fill = "none" }: { children: React.ReactNode; fill?: string }) {
  return (
    <svg width="28" height="28" viewBox="-2 -2 28 28" fill={fill} stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/**
 * A colour widget's glyph: the tool's mark over a bar OF the colour, as the
 * reference draws its pencil and its `T`. The bar is the colour at its own
 * opacity, so a translucent line reads as translucent on the toolbar too.
 */
function ColourGlyph({ colour, children }: { colour: string; children: React.ReactNode }) {
  return (
    <svg width="28" height="28" viewBox="-2 -2 28 28" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
      <rect x="4" y="20.5" width="16" height="3" rx="1" fill={colour} stroke="none" />
    </svg>
  );
}

/**
 * The floating toolbar's `Template` menu (W2A-03): the reference's 239px menu
 * of `Save Drawing Template As…`, `Apply Default Drawing Template` and this
 * tool's saved templates. Read from storage when it opens, so a template saved
 * from the settings dialog or the context menu is already here.
 */
function ToolbarTemplateMenu({ drawing, readOnly, close, onRestyle, ask }: {
  drawing: Drawing;
  readOnly: boolean;
  close: () => void;
  onRestyle: (look: DrawingStyle) => void;
  ask: ReturnType<typeof useAsk>;
}) {
  const [templates] = useState(() => loadDrawingTemplates());
  return (
    <DrawingTemplateMenuPanel
      className="w-[239px] py-1.5"
      long
      tool={drawing.tool}
      templates={templates}
      disabled={readOnly}
      onSaveAs={() => { close(); void saveDrawingTemplateAs(ask, drawing); }}
      onApplyDefault={() => { close(); onRestyle(defaultDrawingTemplate()); }}
      onApply={(template) => { close(); onRestyle(template.style); }}
      onDelete={(template) => { close(); void deleteDrawingTemplateAsk(ask, template); }}
    />
  );
}

/** Where a dragged toolbar is remembered: this tab, until it closes (W2A-05). */
const BAR_POSITION_KEY = "tv.drawingToolbarPosition.v1";

function recallBarPosition(): { left: number; top: number } | null {
  const raw = recallJson<unknown>(BAR_POSITION_KEY, null, "session");
  if (!raw || typeof raw !== "object") return null;
  const { left, top } = raw as { left?: unknown; top?: unknown };
  return typeof left === "number" && Number.isFinite(left) && typeof top === "number" && Number.isFinite(top)
    ? { left, top } : null;
}

/**
 * W2D-03: the pane's legend column(s), in the same pane pixels the bar uses.
 *
 * Found by what is IN them — the series legend (`data-pane-legend`) and the
 * study rows' action clusters — walked up to the child of the pane host that
 * holds them, because that column is what is positioned and what the legend
 * text paints across. `offset*` rather than a client rect: the column and the
 * bar share the host as their offset parent, and a rect would be in viewport
 * pixels.
 */
function legendBoxes(host: HTMLElement | null): Box[] {
  if (!host) return [];
  const columns = new Set<HTMLElement>();
  for (const mark of host.querySelectorAll<HTMLElement>(
    "[data-pane-legend], [data-study-actions], [data-series-actions]",
  )) {
    let node: HTMLElement | null = mark;
    while (node && node.parentElement !== host) node = node.parentElement;
    if (node) columns.add(node);
  }
  return [...columns]
    .filter((column) => column.offsetWidth > 0 && column.offsetHeight > 0)
    .map((column) => ({
      left: column.offsetLeft, top: column.offsetTop,
      right: column.offsetLeft + column.offsetWidth, bottom: column.offsetTop + column.offsetHeight,
    }));
}

/** The dash pattern a drawing draws with, from the key that has it or the boolean before it. */
function lineStyleOf(style: DrawingStyle): "solid" | "dotted" | "dashed" {
  return style.lineStyle ?? (style.dashed ? "dashed" : "solid");
}

/**
 * M1 / F-01: a text drawing being typed into, in place.
 *
 * `fresh` is a drawing the click has just placed: Escape takes it away again.
 * `gesture` is the undo-history gesture the edit records under — for a fresh
 * drawing, the SAME one its placement was recorded under, so placing a text
 * and typing it is one undo step, and placing one and pressing Escape is none.
 */
interface TextEdit {
  id: string;
  fresh: boolean;
  original: string;
  gesture: string;
}

/** The size a text drawing paints at when it never set one (see `textFont`). */
function textSizeOf(style: DrawingStyle, tool: DrawingTool): number {
  return style.fontSize ?? (tool === "callout" ? 12 : 13);
}

/** One line of a text drawing's caption, top to top, in pixels. */
function textLineHeight(size: number): number {
  return Math.round(size * 1.25);
}

let measureContext: CanvasRenderingContext2D | null | undefined;
/** A caption line's width in `font`, or an estimate where nothing can measure. */
function measureCaption(text: string, font: string, size: number): number {
  if (measureContext === undefined) {
    try { measureContext = document.createElement("canvas").getContext("2d"); }
    catch { measureContext = null; }
  }
  if (measureContext) {
    measureContext.font = font;
    const width = measureContext.measureText(text).width;
    if (Number.isFinite(width) && width > 0) return width;
  }
  return text.length * size * 0.6;
}

/**
 * Where the inline editor sits for a text drawing, in pane pixels: over the
 * caption the canvas would paint, so typing happens where the text will be.
 * Mirrors the per-tool geometry in `drawOne`.
 */
function textEditorBox(d: Drawing, a: Pt, text: string): {
  left: number; top: number; translate: string; align: "left" | "center" | "right";
  boxed: boolean; padX: number; padY: number; minHeight: number; size: number; lineHeight: number;
} {
  const size = textSizeOf(d.style, d.tool);
  const lineHeight = textLineHeight(size);
  const rows = Math.max(1, text.split("\n").length);
  const boxed = { translate: "", align: "left" as const, boxed: true, size, lineHeight };
  switch (d.tool) {
    case "note": case "comment":
      return { ...boxed, left: a.x + 10, top: a.y - 30, padX: 6, padY: 2, minHeight: 20 };
    case "priceNote":
      return { ...boxed, left: a.x + 18, top: a.y - 30, padX: 5, padY: 2, minHeight: 20 };
    case "callout":
      return { ...boxed, left: a.x + 26, top: a.y - 44, padX: 7, padY: 3, minHeight: 24 };
    case "signpost":
      return { ...boxed, translate: "translateX(-50%)", left: a.x, top: a.y - 45, padX: 6, padY: 1, minHeight: 18 };
    default: {
      const hAlign = d.style.textHAlign ?? "left";
      const vAlign = d.style.textVAlign ?? "bottom";
      const firstBaseline = a.y - (vAlign === "bottom" ? (rows - 1) * lineHeight
        : vAlign === "middle" ? ((rows - 1) * lineHeight) / 2 : 0);
      const top = vAlign === "top" ? firstBaseline - (lineHeight - size) / 2
        : vAlign === "middle" ? firstBaseline - lineHeight / 2
          : firstBaseline - Math.round(size * 0.97);
      return {
        left: hAlign === "left" ? a.x + 4 : a.x,
        top,
        translate: hAlign === "center" ? "translateX(-50%)" : hAlign === "right" ? "translateX(-100%)" : "",
        align: hAlign,
        boxed: false, padX: 0, padY: 0, minHeight: lineHeight, size, lineHeight,
      };
    }
  }
}
import {
  barsPatternGeometry, fibChannelGeometry, gannSquareGeometry, patternLabels, positionForecastGeometry,
  pitchforkGeometry, regression as regressionGeometry, timeProjection,
} from "@/lib/drawingGeometry";

const HIT_PX = 7;

/** The faces that actually hold colour emoji, per platform. */
const EMOJI_FONT =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const HANDLE_PX = 4.5;

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
  onSelectionChange, onContextMenu, onOpenSettings, styleFocusSignal, active = true,
  picking = false,
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
    | ISeriesApi<"Area"> | ISeriesApi<"Baseline"> | ISeriesApi<"Histogram"> | null;
  candles: Candle[];
  interval: Resolution;
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
  /** Off, or snap to O/H/L/C only near one ("weak"), or always to the nearest ("strong"). */
  magnet: MagnetMode;
  locked: boolean;
  hidden: boolean;
  /**
   * Which drawing is selected, so the workspace's keyboard and context menu
   * can act on it. The canvas remains the owner of the selection — this only
   * reports it.
   */
  onSelectionChange?: (id: string | null) => void;
  onOpenSettings?: (id: string) => void;
  /** A right-click landed on a drawing (or on empty chart, with a null id). */
  onContextMenu?: (event: {
    x: number; y: number; drawingId: string | null; price: number | null;
    /** Which strip was clicked, so the workspace knows which menu to build. */
    region: "plot" | "axis" | "time";
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
  /**
   * B-03: the chart is asking "which bar?" (Bar replay's Select bar).
   *
   * Every left-click then answers that question, wherever it lands. A press on
   * a drawing used to select it — and stop the event in the capture phase —
   * so the chart's click never reached the picker, the floating style bar
   * appeared, and Start replayed from the picker's default bar instead of the
   * one clicked. The reference makes drawings unselectable in that mode, and
   * so does this: while picking the layer neither hit-tests, hovers, selects,
   * drags, creates nor opens settings. Drawings are still DRAWN.
   */
  picking?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => { onSelectionChangeRef.current?.(selected); }, [selected]);
  // B-03: arming the bar picker drops a selection, so no style bar sits over
  // the bars being picked from.
  useEffect(() => { if (picking) setSelected(null); }, [picking]);
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
  const pickingRef = useRef(picking);
  const magnetRef = useRef(magnet);
  drawingsRef.current = drawings;
  selectedRef.current = selected;
  toolRef.current = tool;
  styleRef.current = style;
  lockedRef.current = locked;
  hiddenRef.current = hidden;
  pickingRef.current = picking;
  magnetRef.current = magnet;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const ask = useAsk();
  const onToolDoneRef = useRef(onToolDone);
  onToolDoneRef.current = onToolDone;
  /*
   * The chart itself, for the one gesture that moves the VIEWPORT rather than
   * drawing on it. `commit` is memoised with no dependencies on purpose — it
   * is called from pointer handlers that must not be rebuilt per render — so
   * it reaches the chart the same way it reaches everything else.
   */
  const chartRef = useRef(chart);
  chartRef.current = chart;

  // ── the inline text editor (M1 / F-01) ───────────────────────────────────
  /*
   * State for the render, refs for the imperative handlers — and the refs are
   * written WITH the state rather than from it on render, because a commit
   * from one event and a re-open from the next can both land before React
   * renders in between.
   */
  const [textEdit, setTextEditState] = useState<TextEdit | null>(null);
  const [editText, setEditTextState] = useState("");
  const textEditRef = useRef<TextEdit | null>(null);
  const editTextRef = useRef("");
  /** Whether the edited drawing has reached `drawings` yet — see the effect below. */
  const editSeenRef = useRef(false);
  const setTextEdit = useCallback((next: TextEdit | null): void => {
    textEditRef.current = next;
    setTextEditState(next);
  }, []);
  const setEditText = useCallback((next: string): void => {
    editTextRef.current = next;
    setEditTextState(next);
  }, []);

  /**
   * Close the editor. `commit` writes what was typed; `cancel` puts back what
   * was there, which for a drawing the click has just placed is nothing.
   *
   * An empty `Text` is removed either way: it is a drawing with nothing to
   * draw, which nobody could see to select or delete. The other text tools
   * keep their shape — a note, a flag, a signpost — with no caption.
   */
  const finishTextEdit = useCallback((mode: "commit" | "cancel"): void => {
    const edit = textEditRef.current;
    if (!edit) return;
    setTextEdit(null);
    const list = drawingsRef.current;
    const target = list.find((d) => d.id === edit.id);
    if (!target) return;
    const text = mode === "cancel" ? edit.original : editTextRef.current;
    const discard = (mode === "cancel" && edit.fresh) || (target.tool === "text" && text.trim() === "");
    /*
     * The list is written back to `drawingsRef` at once, not on the next
     * render: a click elsewhere commits here and then, in the SAME event, may
     * place the next drawing from `drawingsRef` — which would otherwise still
     * be the list from before this commit, and would write the text away.
     */
    const write = (next: Drawing[]): void => {
      drawingsRef.current = next;
      onChangeRef.current(next, edit.gesture);
    };
    if (discard) {
      write(list.filter((d) => d.id !== edit.id));
      setSelected((current) => (current === edit.id ? null : current));
      return;
    }
    if ((target.style.text ?? "") === text) return;
    write(list.map((d) => (d.id === edit.id ? { ...d, style: { ...d.style, text } } : d)));
  }, [setTextEdit]);

  /**
   * Open the editor on `d`. A fresh drawing passes the gesture its placement
   * was recorded under; an existing one gets a gesture of its own, so editing
   * it is one undo step whatever is typed.
   */
  const beginTextEdit = useCallback((d: Drawing, fresh: boolean, gesture?: string): void => {
    if (textEditRef.current?.id === d.id) return;
    if (textEditRef.current) finishTextEdit("commit");
    const original = d.style.text ?? "";
    editSeenRef.current = !fresh;
    setEditText(original);
    setTextEdit({ id: d.id, fresh, original, gesture: gesture ?? `text-edit:${d.id}:${Date.now()}` });
    setSelected(d.id);
  }, [finishTextEdit, setEditText, setTextEdit]);
  const beginTextEditRef = useRef(beginTextEdit);
  beginTextEditRef.current = beginTextEdit;

  // ── time ↔ logical-index mapping ──────────────────────────────────────────
  // Stored anchors use bar time; the chart positions by logical index. Bars may
  // have gaps, so interpolate inside the data and extrapolate past its edges
  // (drawings are allowed to extend into the future).
  const times = useMemo(() => candles.map((c) => c.openTime / 1000), [candles]);
  // Chart times are seconds; a resolution's own step is in milliseconds.
  const stepSec = resolutionMs(interval) / 1000;

  /*
   * B-21: a candle's logical position is the CHART's answer, not its index in
   * `candles` — the time scale also holds every other series' times, and an
   * overlay off the candles' grid shifted every drawing. See
   * `lib/drawingTimeMap`. Read at call time, so a time scale that changes
   * under the layer (an overlay's data arriving) moves nothing stale.
   */
  const mapping = useMemo(() => timeMap(times, stepSec, (barTime) => {
    try {
      const scale = chart?.timeScale();
      const x = scale?.timeToCoordinate(barTime as never);
      if (x === null || x === undefined) return null;
      const logical = scale?.coordinateToLogical(x);
      return logical === null || logical === undefined ? null : Math.round(logical);
    } catch { return null; }
  }), [times, stepSec, chart]);
  const timeToLogical = useCallback((t: number): number => mapping.timeToLogical(t), [mapping]);
  const logicalToTime = useCallback((l: number): number => mapping.logicalToTime(l), [mapping]);

  const toPx = useCallback((a: Anchor): Pt => {
    // Off the grid an anchor sits BETWEEN two bars; see `coordinateAtLogical`.
    const scale = chart?.timeScale();
    const x = scale ? coordinateAtLogical((l) => scale.logicalToCoordinate(l as Logical), timeToLogical(a.time)) : null;
    const y = series?.priceToCoordinate(a.price);
    return { x: x ?? -1e5, y: y ?? -1e5 };
  }, [chart, series, timeToLogical]);

  /** Pixel → anchor, with bar snapping and optional OHLC magnet. */
  const toAnchor = useCallback((x: number, y: number): Anchor => {
    const logical = chart?.timeScale().coordinateToLogical(x) ?? 0;
    const price = series?.coordinateToPrice(y) ?? 0;
    const snappedLogical = Math.round(logical as number);
    const time = logicalToTime(snappedLogical);
    if (magnetRef.current === "off") return { time, price: Number(price) };
    // The bar AT that time, not `candles[logical]`: see `lib/drawingTimeMap`.
    const index = mapping.barIndexAt(time);
    const bar = index >= 0 && times[index] === time ? candles[index] : undefined;
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
    // Weak: only when the pointer is already near a level. Strong: always.
    return { time, price: magnetRef.current === "strong" || bestPx <= 24 ? best : Number(price) };
  }, [chart, series, candles, logicalToTime, mapping, times]);

  // ── hit testing ───────────────────────────────────────────────────────────
  const hitTest = useCallback((p: Pt): { id: string; handle: number | null } | null => {
    const list = drawingsRef.current;
    // Topmost first, and handles of the selected drawing win over any body.
    const ordered = [...list].reverse();
    const sel = list.find((d) => d.id === selectedRef.current);
    if (sel && !sel.locked && !sel.hidden && drawingVisibleOnTimeframe(sel, interval)) {
      for (let i = 0; i < sel.points.length; i++) {
        const h = toPx(sel.points[i]!);
        if (Math.hypot(p.x - h.x, p.y - h.y) <= HIT_PX + 2) return { id: sel.id, handle: i };
      }
    }
    for (const d of ordered) {
      if (d.hidden || !drawingVisibleOnTimeframe(d, interval)) continue;
      if (distToDrawing(p, d, toPx, candles) <= HIT_PX) return { id: d.id, handle: null };
    }
    return null;
  }, [toPx, interval, candles]);

  // ── committing drawings ───────────────────────────────────────────────────
  const commit = useCallback((tl: DrawingTool, points: Anchor[]) => {
    /*
     * Zoom in: the drag chose a span of time, not a shape.
     *
     * It goes through the chart's own `setVisibleRange` — the primitive the
     * range shortcuts under the chart already use — so the result is a normal
     * viewport change that pans, zooms and syncs like any other, and nothing
     * is added to the drawing list.
     */
    if (tl === "zoom") {
      const from = Math.min(points[0]!.time, points[1]!.time);
      const to = Math.max(points[0]!.time, points[1]!.time);
      draftRef.current = null;
      previewRef.current = null;
      // A tap rather than a drag selects no span at all; zooming to it would
      // leave the user on an empty chart with no way back but Reset.
      if (to > from) {
        chartRef.current?.timeScale().setVisibleRange(
          { from: from as never, to: to as never });
      }
      onToolDoneRef.current();
      return;
    }
    let pts = points;
    // Long/short carry a third, draggable stop anchor derived at 2:1 R:R.
    if (tl === "long" || tl === "short") {
      const risk = (points[1]!.price - points[0]!.price) / 2;
      pts = [...points, { time: points[1]!.time, price: points[0]!.price - risk }];
    }
    /*
     * M1 / F-01: a text tool places its drawing AT THE CLICK and opens the
     * inline editor there, as the reference does.
     *
     * It used to open a modal `Text` dialog (one field, Cancel / Place) and
     * draw nothing until Place — before that, `window.prompt`. Either way the
     * user typed somewhere other than where the text was going. Now the
     * drawing exists the moment the click lands, carrying the reference's
     * `14` unless a size is already armed, and is typed into in place; the
     * settings dialog is still one click away on the toolbar's gear.
     */
    const carriesText = TEXT_TOOLS.has(tl);
    const d: Drawing = {
      id: newId(),
      tool: tl,
      points: pts,
      style: {
        ...styleRef.current,
        ...(carriesText ? { text: "", fontSize: styleRef.current.fontSize ?? NEW_TEXT_SIZE } : {}),
        // The emoji the rail's picker last armed. See `armIconGlyph`.
        ...(tl === "icon" ? { glyph: currentIconGlyph() } : {}),
      },
    };
    // Measurement tools are one-at-a-time, like TV's measure.
    const kept = EPHEMERAL_TOOLS.has(tl)
      ? drawingsRef.current.filter((x) => x.tool !== tl)
      : drawingsRef.current;
    // The placement and the typing that follows are one undo step: see `TextEdit`.
    const gesture = carriesText ? `text:${d.id}` : null;
    const next = [...kept, d];
    if (carriesText) drawingsRef.current = next; // the editor reads it before the next render
    onChangeRef.current(next, gesture);
    draftRef.current = null;
    previewRef.current = null;
    setSelected(d.id);
    onToolDoneRef.current();
    if (carriesText) beginTextEditRef.current(d, true, gesture ?? undefined);
  }, []);

  // Switching tools clears an unfinished draft and any ephemeral measurement.
  useEffect(() => {
    draftRef.current = null;
    previewRef.current = null;
    if (tool !== "ruler") {
      const cleaned = drawingsRef.current.filter((d) => !EPHEMERAL_TOOLS.has(d.tool));
      if (cleaned.length !== drawingsRef.current.length) onChangeRef.current(cleaned);
    }
    if (!isCursorMode(tool)) setSelected(null);
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

    /**
     * Which strip of the chart the POINTER landed on: plot, price axis, time
     * axis.
     *
     * ── Why this asks the DOM rather than the scales ─────────────────────────
     *
     * It used to be arithmetic over this pane's own scale geometry —
     * `clientWidth − priceScale("right").width()` and
     * `clientHeight − timeScale().height()` — and that is a model of the chart
     * rather than the chart. Two things went wrong with it, and both are the
     * same mistake:
     *
     *   The time axis is drawn ONCE, under the lowest pane on screen. As soon
     *   as a study pane is mounted this chart's own time scale is hidden, so
     *   `timeScale().height()` is 0, `h` is the full height, and no point in
     *   this pane can ever be classified "time" — the `Time scale` menu became
     *   unreachable for anyone with an RSI open. (The visible axis then belongs
     *   to an `IndicatorPane`, which reports its own right-click.)
     *
     *   And a price-axis click was classified by a WIDTH the library reports
     *   for the scale object, not by the cell the axis is actually painted in;
     *   where the two disagreed the axis silently returned the plot's menu.
     *
     * The library renders its panes as a table: a row per pane — `[left axis]
     * [pane][right axis]` — and a final row for the time axis. So the honest
     * question is which `<td>` the event landed in, and the geometry below is
     * only the fallback for an event synthesised without a real target.
     */
    const regionOf = (e: MouseEvent, p: Pt): "plot" | "axis" | "time" => {
      const table = container.querySelector("table");
      const target = e.target as Element | null;
      const cell = target && typeof target.closest === "function"
        ? target.closest("td") : null;
      if (table && cell && table.contains(cell)) {
        const row = cell.parentElement as HTMLTableRowElement | null;
        if (row) {
          // The last row is the time axis, whatever its cells contain.
          if (table.rows.length > 1 && row.rowIndex === table.rows.length - 1) return "time";
          // A price axis is the first or last cell of a pane's row; the pane
          // itself is between them. The hidden left axis is a 0-width cell and
          // cannot be hit, so "first or last" needs no special case for it.
          return cell.cellIndex === 0 || cell.cellIndex === row.cells.length - 1
            ? "axis" : "plot";
        }
      }
      const axisWidth = chart.priceScale("right").width() ?? 0;
      const timeHeight = chart.timeScale().height() ?? 0;
      const w = container.clientWidth - axisWidth;
      const h = container.clientHeight - timeHeight;
      if (timeHeight > 0 && p.y > h) return "time";
      return axisWidth > 0 && p.x > w ? "axis" : "plot";
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
      const region = regionOf(e, p);
      e.preventDefault();
      /*
       * TVP8: and claim the event.
       *
       * `CandleChart` now has its own `onContextMenu` on the same element, so
       * that the four transform chart types — which do not mount this layer at
       * all — still get a product menu instead of Chrome's. This listener is
       * in the CAPTURE phase, so without stopping propagation the React
       * handler below still ran and replaced the drawing menu with the chart
       * menu: right-clicking a trend line opened "SOLUSDT chart".
       */
      e.stopPropagation();
      if (region === "time") {
        /*
         * TVP8: this used to `return` before `preventDefault`, on the grounds
         * that the time scale is "the one strip with nothing to offer". That
         * had stopped being true — resetting the view, going to a date and the
         * settings dialog are all things the reference puts on exactly this
         * menu and all three exist here — so one of the chart's three strips
         * fell out of the product and into Chrome's Inspect/Save-as/Translate.
         */
        handler({ x: e.clientX, y: e.clientY, drawingId: null, price: null, region: "time" });
        return;
      }
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
      if (e.button !== 0 || hiddenRef.current || pickingRef.current) return;
      const p = rectOf(e);
      if (!inPlot(p)) return;
      const t = toolRef.current;

      if (t === "eraser") {
        const hit = hitTest(p);
        if (hit) {
          /*
           * TVP8: the eraser was the one way past a lock.
           *
           * Dragging checks `lockedRef` and the drawing's own `locked`, and so
           * does Delete — but the eraser deleted anything it touched, so "Lock
           * all drawings" protected a drawing from being nudged and not from
           * being destroyed. That is the wrong way round.
           */
          const target = drawingsRef.current.find((d) => d.id === hit.id);
          if (!lockedRef.current && target && !target.locked) {
            onChangeRef.current(drawingsRef.current.filter((d) => d.id !== hit.id));
            setSelected(null);
          } else {
            setSelected(hit.id);
          }
        }
        e.stopPropagation(); e.preventDefault();
        return;
      }

      if (isCursorMode(t)) {
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

      if (t === "brush" || t === "highlighter") {
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
      if ((draft?.tool === "brush" || draft?.tool === "highlighter") && e.buttons === 1) {
        draft.points.push(previewRef.current);
        e.stopPropagation();
        return;
      }
      if (pickingRef.current) {
        hoverRef.current = null;
      } else if (isCursorMode(toolRef.current) && !hiddenRef.current) {
        const hit = hitTest(p);
        hoverRef.current = hit?.id ?? null;
        container.style.cursor = hit ? "pointer" : "";
      } else {
        container.style.cursor = isCursorMode(toolRef.current) ? "" : "crosshair";
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
      if (draft.tool === "brush" || draft.tool === "highlighter") {
        if (draft.points.length > 1) commit(draft.tool, draft.points);
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

    /*
     * ── TVP8 F-06: opening a drawing's settings by double-click ──────────────
     *
     * The native `dblclick` below is the primary path and works: a real
     * two-click at a point on the stroke hit-tests to the drawing and opens the
     * same dialog the floating toolbar's gear does.
     *
     * What it does NOT cover is the two cases where the browser never sends a
     * `dblclick` at all. A touch screen has no such event — and this file
     * grew a whole touch path precisely so a phone can draw, so a phone could
     * draw a drawing it could never open. And a second press that moves a few
     * pixels, or that lands on a selected drawing's handle and starts a drag,
     * suppresses it too. So the same intent is also recognised from the
     * PRESSES: two within 400ms and 4px of each other, which is the tolerance
     * the queue names.
     */
    const DOUBLE_MS = 400;
    const DOUBLE_PX = 4;
    let lastPress: { x: number; y: number; at: number } | null = null;

    /**
     * Open `id`'s settings by the same route the floating toolbar's gear takes
     * — or, for a drawing that carries text, its inline editor (M1 / F-01):
     * the reference edits a text in place on a double-click, and keeps the
     * dialog behind the gear. A locked text is not edited, so it gets the
     * dialog, as every other drawing does.
     */
    const openSettingsFor = (id: string, e: MouseEvent): void => {
      const target = drawingsRef.current.find((d) => d.id === id);
      if (target && TEXT_TOOLS.has(target.tool) && !lockedRef.current && !target.locked) {
        beginTextEditRef.current(target, false);
      } else {
        setSelected(id);
        onOpenSettings?.(id);
      }
      // And claim the event, so the chart's own double-click (autoscale reset)
      // does not also fire underneath the dialog that just opened.
      e.stopPropagation();
      e.preventDefault();
    };

    const onDouble = (e: MouseEvent): void => {
      if (pickingRef.current) return;
      const draft = draftRef.current;
      if (draft && TOOL_POINTS[draft.tool] === 0 && draft.points.length >= 2) {
        commit(draft.tool, draft.points);
        e.stopPropagation(); e.preventDefault();
        return;
      }
      lastPress = null;
      const hit = hitTest(rectOf(e));
      if (hit?.id) openSettingsFor(hit.id, e);
    };

    /**
     * The fallback, run on every press BEFORE `onDown` acts on it.
     *
     * Returns true when this press completed a double, in which case the press
     * is the dialog's and not a drag's.
     */
    const doublePress = (e: MouseEvent): boolean => {
      if (e.button !== 0 || hiddenRef.current || pickingRef.current) return false;
      // A tool in hand is drawing, not editing: two clicks are two points.
      if (!isCursorMode(toolRef.current)) { lastPress = null; return false; }
      const p = rectOf(e);
      const now = Date.now();
      const previous = lastPress;
      lastPress = { x: p.x, y: p.y, at: now };
      if (previous === null
        || now - previous.at > DOUBLE_MS
        || Math.hypot(p.x - previous.x, p.y - previous.y) > DOUBLE_PX) return false;
      lastPress = null;
      const hit = hitTest(p);
      if (!hit?.id) return false;
      openSettingsFor(hit.id, e);
      return true;
    };

    const onLeave = (): void => { previewRef.current = null; };

    /*
     * ── TVP8: touch ────────────────────────────────────────────────────────
     *
     * Every listener below was a `mouse*` one, and there was not a single
     * `touch*` or `pointer*` handler in this file. The phone build ships the
     * drawing rail in a drawer (`DrawingToolbar`'s phone path), so a tablet or
     * phone user could pick a tool, watch it arm, and then find that no amount
     * of dragging on the chart drew anything: a rail that cannot draw.
     *
     * The handlers only ever read `clientX`, `clientY` and `button`, so a
     * touch is adapted into that shape and sent through exactly the same code
     * — placement, magnet, drag, commit and undo stay in one implementation
     * rather than growing a second one that drifts.
     *
     * What is deliberately NOT forwarded: a two-finger gesture, and a
     * single-finger touch while the cursor tool is active with nothing under
     * it. Both belong to the chart, which is how a phone user still pans and
     * pinch-zooms; `onDown` already leaves that case alone for the mouse.
     */
    const asMouse = (e: TouchEvent, touch: Touch): MouseEvent => ({
      button: 0, clientX: touch.clientX, clientY: touch.clientY,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      stopPropagation: () => e.stopPropagation(),
      preventDefault: () => { if (e.cancelable) e.preventDefault(); },
    } as unknown as MouseEvent);

    /** True while this gesture is ours, so move and end know not to hand back. */
    let touchDrawing = false;

    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1) { touchDrawing = false; return; }
      const touch = e.touches[0]!;
      // A finger is blunter than a pointer: without this, the only tool a
      // phone could use reliably was one that needs no accuracy at all.
      const before = draftRef.current;
      const press = asMouse(e, touch);
      if (doublePress(press)) { touchDrawing = false; return; }
      onDown(press);
      touchDrawing = draftRef.current !== before
        || dragRef.current !== null
        || (!isCursorMode(toolRef.current) && toolRef.current !== "eraser");
    };
    const onTouchMove = (e: TouchEvent): void => {
      if (!touchDrawing || e.touches.length !== 1) return;
      onMove(asMouse(e, e.touches[0]!));
      // Stop the page from scrolling out from under a drawing in progress.
      if (e.cancelable) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent): void => {
      if (!touchDrawing) return;
      const touch = e.changedTouches[0];
      if (touch) onUp(asMouse(e, touch));
      touchDrawing = false;
    };

    container.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
    container.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    container.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    container.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });
    const onPress = (e: MouseEvent): void => { if (!doublePress(e)) onDown(e); };
    container.addEventListener("mousedown", onPress, true);
    container.addEventListener("contextmenu", onContext, true);
    container.addEventListener("mousemove", onMove, true);
    container.addEventListener("mouseup", onUp, true);
    container.addEventListener("dblclick", onDouble, true);
    container.addEventListener("mouseleave", onLeave);
    // A drag that ends outside the chart must still finish cleanly.
    window.addEventListener("mouseup", onUp, true);
    return () => {
      container.removeEventListener("touchstart", onTouchStart, true);
      container.removeEventListener("touchmove", onTouchMove, true);
      container.removeEventListener("touchend", onTouchEnd, true);
      container.removeEventListener("touchcancel", onTouchEnd, true);
      container.removeEventListener("mousedown", onPress, true);
      container.removeEventListener("contextmenu", onContext, true);
      container.removeEventListener("mousemove", onMove, true);
      container.removeEventListener("mouseup", onUp, true);
      container.removeEventListener("dblclick", onDouble, true);
      container.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("mouseup", onUp, true);
      container.style.cursor = "";
    };
  }, [container, chart, series, hitTest, toAnchor, toPx, commit, onOpenSettings]);

  // Escape cancels, Delete removes the selection — in the FOCUSED pane only.
  /*
   * B-21: the drawings' price tags, on the axis. One primitive per series this
   * layer draws against; the tag list is restated whenever what is drawn
   * changes, and the primitive asks for a repaint only when it differs.
   */
  const axisTagsRef = useRef<DrawingAxisLabelsPrimitive | null>(null);
  useEffect(() => {
    if (!series) return;
    const primitive = new DrawingAxisLabelsPrimitive();
    try { series.attachPrimitive(primitive); } catch { return; }
    axisTagsRef.current = primitive;
    return () => {
      axisTagsRef.current = null;
      try { series.detachPrimitive(primitive); }
      catch { /* the series went away first; the primitive went with it */ }
    };
  }, [series]);
  useEffect(() => {
    axisTagsRef.current?.update(drawingAxisTags(drawings, interval, hidden));
  }, [drawings, interval, hidden, series]);

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
        /*
         * TVP8 round two: the drawing's OWN lock, not only the workspace's.
         *
         * `lockedRef` is "Lock all drawings". A drawing locked individually —
         * through its context menu or the padlock on its own toolbar — could
         * still be deleted with one keystroke, which is the one thing locking
         * it was for.
         */
        const target = drawingsRef.current.find((d) => d.id === selectedRef.current);
        if (target?.locked) return;
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
        `|${interval}` +
        `|${draftRef.current?.points.length ?? -1}|${previewRef.current?.time ?? 0}` +
        `|${previewRef.current?.price ?? 0}|${hoverRef.current}|${geometryDigest(drawings)}` +
        `|${textEditRef.current?.id ?? ""}`;
      if (fp === last) return;
      last = fp;
      paint(canvas, w, h);
      placeEditorRef.current();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, container, drawings, selected, hidden, candles, interval]);

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
      if (d.hidden || !drawingVisibleOnTimeframe(d, interval)) continue;
      // The caption of a text being typed is the editor's to show, not the canvas's.
      drawOne(ctx, d, toPx, plotW, plotH, d.id === selected, d.id === hoverRef.current, candles,
        d.id === textEditRef.current?.id);
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
          toPx, plotW, plotH, false, false, candles
        );
      }
    }
    ctx.restore();
  }, [drawings, selected, hidden, style, toPx, chart, interval, candles]);

  // Style edits apply to the selected drawing, else become the new default.
  const applyStyle = (patch: Partial<typeof style>): void => {
    // The armed tool's default always follows the control, locked or not — the
    // next drawing is not locked.
    setStyle((s) => ({ ...s, ...patch }));
    if (!selected) return;
    /*
     * TVP8 round two: a LOCKED drawing is not restyled.
     *
     * Locking honoured dragging, the eraser and the context menu, and the
     * quick toolbar restyled straight through it — so a locked drawing could
     * be recoloured, dashed, filled and widened in one click each. The lock
     * either means "do not change this" or it means nothing.
     */
    const target = drawings.find((d) => d.id === selected);
    if (locked || target?.locked) return;
    onChange(drawings.map((d) => (d.id === selected ? { ...d, style: { ...d.style, ...patch } } : d)));
  };

  const sel = drawings.find((d) => d.id === selected) ?? null;
  /*
   * Profile settings merge rather than replace.
   *
   * `applyStyle` spreads a patch over the style, which for a NESTED object
   * means the patch's object wins whole — so setting the row count would have
   * silently reset the split, the side and the value-area percentage to their
   * defaults. Merging here keeps the eight settings independent.
   */
  const applyProfile = (patch: NonNullable<DrawingStyle["profile"]>): void => {
    applyStyle({ profile: { ...DEFAULT_VP_RANGE_STYLE, ...sel?.style.profile, ...patch } });
  };
  const profileStyle = { ...DEFAULT_VP_RANGE_STYLE, ...(sel?.style.profile ?? {}) };
  const selPx = sel ? toPx(sel.points[0]!) : null;

  const styleBarRef = useRef<HTMLDivElement>(null);
  /*
   * The bar's real width, measured AFTER it has been laid out.
   *
   * Reading `styleBarRef.current?.offsetWidth` inline during render returns
   * `null` on the render where the bar first mounts — which is the only render
   * that matters, because that is when a freshly selected drawing decides
   * where its bar goes. The clamp therefore fell through to its fallback every
   * single time, and the fallback was the 300px constant the measurement was
   * supposed to replace. Nothing scheduled a second render, so it stayed there.
   *
   * `useLayoutEffect` runs before paint, and the equality guard means this
   * settles in one extra pass and then stops.
   */
  const [styleBarSize, setStyleBarSize] = useState({ width: 0, height: 0 });
  /*
   * W2D-03: the legend column, measured with the bar. See `legendBoxes` and
   * `PlacementOptions.avoid` for why the bar keeps off it.
   */
  const [legendAvoid, setLegendAvoid] = useState<Box[]>([]);
  useLayoutEffect(() => {
    const width = styleBarRef.current?.offsetWidth ?? 0;
    const height = styleBarRef.current?.offsetHeight ?? 0;
    setStyleBarSize((previous) => (previous.width === width && previous.height === height
      ? previous : { width, height }));
    const boxes = legendBoxes(canvasRef.current?.parentElement ?? null);
    setLegendAvoid((previous) => (JSON.stringify(previous) === JSON.stringify(boxes) ? previous : boxes));
    // Which controls the bar holds — and so how wide it is — is decided by
    // WHICH drawing is selected and what kind it is: the profile block, the
    // Anchored-VWAP band count and the fill toggle are all per-tool.
  }, [sel?.id, sel?.tool]);

  /*
   * W2A-05: the reference's drag handle. Where the bar is dropped is kept for
   * this tab (`BAR_POSITION_KEY`) and reused for every drawing it does not
   * cover; the drawing it was dropped beside keeps it unconditionally, because
   * the user has just watched it go there.
   */
  const [barDrag, setBarDrag] = useState<{ left: number; top: number } | null>(() => recallBarPosition());
  const [barDropFor, setBarDropFor] = useState<string | null>(null);
  const paneSize = {
    width: (container?.clientWidth ?? 400) - (chart?.priceScale("right").width() ?? 0),
    height: (container?.clientHeight ?? 300) - (chart?.timeScale().height() ?? 0),
  };
  const barSize = { width: styleBarSize.width || 300, height: styleBarSize.height || 38 };
  const startBarDrag = (event: React.PointerEvent<HTMLElement>, from: { left: number; top: number }, id: string): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY };
    let last = from;
    const move = (e: PointerEvent): void => {
      last = clampPlacement(
        { left: from.left + e.clientX - origin.x, top: from.top + e.clientY - origin.y }, barSize, paneSize,
      );
      setBarDrag(last);
      setBarDropFor(id);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      rememberJson(BAR_POSITION_KEY, last, "session");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /*
   * W2A-03: a template REPLACES the look and keeps what the drawing says
   * (`applyDrawingTemplate`). A locked drawing is not restyled, as with
   * `applyStyle`.
   */
  const restyle =(look: DrawingStyle): void => {
    const target = drawings.find((d) => d.id === selected);
    if (!target || locked || target.locked) return;
    setStyle((s) => applyDrawingTemplate(s, look));
    onChange(drawings.map((d) => (d.id === target.id ? { ...d, style: applyDrawingTemplate(d.style, look) } : d)));
  };
  /*
   * A11: the bar never covers the drawing it belongs to.
   *
   * It sat 44px above the FIRST anchor, so a line rising to the right ran
   * straight under it and the click or right-click meant for the line hit a
   * button. `toolbarPlacement` takes the drawing's whole extent and the same
   * distance function hit-testing uses, and returns the first box — above,
   * below, beside, or docked at the top of the pane — that touches neither.
   */
  const styleBarAt = sel && selPx ? toolbarPlacement(
    sel.points.map((point) => toPx(point)),
    barSize,
    paneSize,
    (point) => distToDrawing(point, sel, toPx, candles),
    {
      // A legend column taller than half the pane leaves nowhere useful to
      // dock under it, and is more likely a measurement of nothing laid out
      // yet; the bar then keeps to the drawing rule alone, as before W2D-03.
      avoid: legendAvoid.filter((b) => b.bottom - b.top < paneSize.height / 2),
      preferred: barDrag ? { at: barDrag, force: barDropFor === sel.id } : undefined,
    },
  ) : null;
  const styleFocusRef = useRef(styleFocusSignal);
  useEffect(() => {
    if (styleFocusSignal === styleFocusRef.current) return;
    styleFocusRef.current = styleFocusSignal;
    styleBarRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [styleFocusSignal, sel]);

  // ── the inline text editor (M1 / F-01) ───────────────────────────────────
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editTarget = textEdit ? drawings.find((d) => d.id === textEdit.id) ?? null : null;
  const editAnchor = editTarget ? toPx(editTarget.points[0]!) : null;
  const editBox = editTarget && editAnchor ? textEditorBox(editTarget, editAnchor, editText) : null;

  /*
   * The editor follows its anchor through a pan or a zoom: the render loop
   * calls this whenever it repaints, which is whenever the scales move.
   */
  const placeEditorRef = useRef<() => void>(() => {});
  placeEditorRef.current = () => {
    const el = editorRef.current;
    if (!el || !editTarget) return;
    const box = textEditorBox(editTarget, toPx(editTarget.points[0]!), editTextRef.current);
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
  };

  // Focus on open, with the caret after what is already there.
  const editorShown = editTarget !== null;
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!textEdit || !editorShown || !el) return;
    el.focus();
    const end = el.value.length;
    try { el.setSelectionRange(end, end); } catch { /* not a text control in this environment */ }
  }, [textEdit, editorShown]);

  /*
   * Clicking anywhere else commits — on the chart too, where the drawing
   * layer's own presses call `preventDefault` and so would never move focus
   * out of the editor to blur it. Capture phase, so the commit lands before
   * the press that caused it places, selects or drags anything. The style bar
   * is part of the edit: changing the text colour or size is not leaving it.
   */
  useEffect(() => {
    if (!textEdit) return;
    const outside = (event: Event): void => {
      const target = event.target as Node | null;
      if (target && (editorRef.current?.contains(target) || styleBarRef.current?.contains(target))) return;
      finishTextEdit("commit");
    };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("touchstart", outside, true);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("touchstart", outside, true);
    };
  }, [textEdit, finishTextEdit]);

  // Selecting something else, or hiding every drawing, ends the edit.
  useEffect(() => {
    const edit = textEditRef.current;
    if (!edit) return;
    if (selected !== edit.id || hidden) finishTextEdit("commit");
  }, [selected, hidden, finishTextEdit]);

  /*
   * And a drawing that went away underneath the editor — an undo from the
   * toolbar, a symbol change, a sync — closes it without writing anything.
   * Only once the drawing has been SEEN: a freshly placed one reaches
   * `drawings` a render after the editor opens on it.
   */
  useEffect(() => {
    const edit = textEditRef.current;
    if (!edit) return;
    if (drawings.some((d) => d.id === edit.id)) { editSeenRef.current = true; return; }
    if (editSeenRef.current) setTextEdit(null);
  }, [drawings, textEdit, setTextEdit]);

  const editRows = editText.split("\n");
  const editColour = editTarget ? editTarget.style.textColor || editTarget.style.color : "";
  const editFont = editTarget
    ? textFont({ ...editTarget.style, fontSize: textSizeOf(editTarget.style, editTarget.tool) }) : "";
  const editWidth = editBox
    ? Math.ceil(Math.max(editBox.size * 2,
      ...editRows.map((row) => measureCaption(row, editFont, editBox.size)))) + 2 * editBox.padX + 4
    : 0;

  return (
    <>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10" />
      {textEdit && editTarget && editBox && !hidden && (
        <textarea
          ref={editorRef}
          aria-label="Drawing text"
          data-drawing-text-editor=""
          /*
           * Every key typed here is the text's. `data-owns-keys` and the
           * textarea itself are what `isTypingTarget` reads, so the workspace's
           * shortcuts — a bare letter opening the symbol search, Delete
           * removing the selection, ⌘Z undoing a drawing — stand back.
           */
          data-owns-keys=""
          spellCheck={false}
          wrap="off"
          rows={editRows.length}
          value={editText}
          onChange={(event) => setEditText(event.target.value)}
          onKeyDown={(event) => {
            // Bare keys are the text's alone; a modified one (⌘S) still
            // reaches the workspace, which asks `isTypingTarget` itself.
            if (!event.metaKey && !event.ctrlKey) event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finishTextEdit("cancel");
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              finishTextEdit("commit");
            }
          }}
          onBlur={(event) => {
            if (styleBarRef.current?.contains(event.relatedTarget as Node | null)) return;
            finishTextEdit("commit");
          }}
          onContextMenu={(event) => event.stopPropagation()}
          className="absolute z-30 m-0 resize-none overflow-hidden whitespace-pre outline-none"
          style={{
            left: editBox.left,
            top: editBox.top,
            transform: editBox.translate || undefined,
            width: editWidth,
            minHeight: editBox.minHeight,
            height: editRows.length * editBox.lineHeight + 2 * editBox.padY + (editBox.boxed ? 2 : 0),
            padding: `${editBox.padY}px ${editBox.padX}px`,
            font: editFont,
            lineHeight: `${editBox.lineHeight}px`,
            textAlign: editBox.align,
            color: editColour,
            caretColor: editColour,
            // A boxed tool's box, drawn by the editor while the canvas leaves
            // it out; a plain caption is outlined so the place to type shows.
            background: editBox.boxed ? withAlpha(editTarget.style.color, 16) : "transparent",
            border: editBox.boxed ? `1px solid ${editTarget.style.color}` : "none",
            boxShadow: editBox.boxed ? "none" : `0 0 0 1px ${withAlpha(editColour, 50)}`,
            borderRadius: 2,
          }}
        />
      )}
      {sel && styleBarAt && !hidden && !sel.hidden && (
        <div
          ref={styleBarRef}
          role="toolbar"
          aria-label="Drawing style"
          data-drawing-style-bar=""
          /*
           * The bar is measured, not assumed.
           *
           * The right-edge clamp was `clientWidth - 300`, a constant chosen
           * when every variant of this bar was about 300px wide. The `vprange`
           * variant grows to roughly 520px with its five profile controls, so
           * selecting a Fixed Range Volume Profile near the right edge pushed
           * its own controls off the pane.
           *
           * The measurement comes from `styleBarSize` — taken in a layout
           * effect — rather than from `styleBarRef.current` read during render,
           * which is null on the render that positions a newly selected bar.
           *
           * A12: `tvc-popover`, the surface without the menu grammar's 6px
           * padding, so the bar is its 38px controls tall and no taller — the
           * reference's measured 38px bar of 38×38 buttons. As a menu it was
           * 46px of mixed 34px and 28px buttons.
           */
          className="tvc-popover absolute z-30 flex items-center gap-0.5 pr-1"
          style={{ left: styleBarAt.left, top: styleBarAt.top }}
          /*
           * A12: right-clicking the bar is right-clicking the selection. The
           * bar sits outside the chart's own container, so the canvas never
           * saw the event and the browser's menu — or the chart's — opened
           * over a selected drawing.
           *
           * W2D-03: `z-30`, above the legend column's `z-20`. At `z-20` and
           * earlier in the DOM the bar lost to the legend wherever the two
           * met: the OHLC text painted over its buttons, and a right-click on
           * it landed on the study row underneath and opened the STUDY menu.
           */
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onContextMenuRef.current?.({
              x: event.clientX, y: event.clientY,
              drawingId: sel.id, price: null, region: "plot",
            });
          }}
        >
          {/*
            W2A-05: the reference's drag handle, 24px of six dots in the faint
            ink. Pointer-only, as the reference's is; every control on the bar
            is reachable from the keyboard without moving it.
          */}
          <div
            data-drawing-bar-handle=""
            title="Drag to move"
            aria-hidden="true"
            onPointerDown={(event) => startBarDrag(event, styleBarAt, sel.id)}
            className="flex h-[38px] w-6 shrink-0 cursor-grab items-center justify-center text-ink-faint opacity-70 active:cursor-grabbing"
          >
            <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
              <circle cx="2" cy="2" r="1" /><circle cx="6" cy="2" r="1" />
              <circle cx="2" cy="6" r="1" /><circle cx="6" cy="6" r="1" />
              <circle cx="2" cy="10" r="1" /><circle cx="6" cy="10" r="1" />
            </svg>
          </div>
          {/*
            W2A-03: `Template` opens the TEMPLATE menu. It opened the whole
            settings dialog — which the gear further along already does — so
            a control named for templates never showed one.
          */}
          <PopoverButton
            label="Drawing template"
            title="Template"
            className={BAR_ICON_BUTTON}
            popover={(close) => (
              <ToolbarTemplateMenu
                drawing={sel}
                readOnly={locked || Boolean(sel.locked)}
                close={close}
                onRestyle={restyle}
                ask={ask}
              />
            )}
          >
            <BarGlyph>
              <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
              <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
              <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
              <path d="M17 3.5v7M13.5 7h7" />
            </BarGlyph>
          </PopoverButton>
          {/*
            B-11: colour, width and style OPEN their pickers.

            Each carried a caret and none opened anything: a click stepped the
            value — red to yellow to purple, 3 to 4, Solid to Dashed — so the
            only way to a particular colour was to click past every other one.
            These are the drawing settings dialog's own pickers (`ColourPalette`,
            `WidthPicker`, `DashPicker`, the pieces its `LineStyleButton`
            opens), each behind its own toolbar trigger, as the reference has
            them.

            W2A-05: in the reference's widget grammar. No carets — a toolbar
            button that opens something says so by opening it — colour as a
            pencil over a bar OF that colour, width as its own sample beside
            `2px`, style as a sample of the pattern.
          */}
          {/*
            M1 / F-10: the widget set is the TOOL's, as the reference's is.
            Measured on Premium: a trend line's bar is Template · Colour · Text
            colour · Width · Style · Settings · (Add alert) · Lock · Delete ·
            More, and a Text's is Template · Text colour · `14` · Settings ·
            Lock · Delete · More. So a text drawing gets a font size where a
            line gets width and style, and the plain Text — which is nothing
            but its text — no line colour at all. Clone and Hide are not on the
            reference's bar; they stay in More and the right-click menu. Add
            alert is only offered where an alert can be made: a sloped
            drawing cannot have one here, so it has no dead control either.
          */}
          {sel.tool !== "text" && (
          <PopoverButton
            label="Line color"
            className={BAR_ICON_BUTTON}
            popover={(close) => (
              <ColourPalette value={sel.style.color} onDone={close} allowOpacity
                onChange={(color) => applyStyle({ color })} />
            )}
          >
            <ColourGlyph colour={sel.style.color}>
              <path d="M15.5 4.5l3 3L9 17l-4 1 1-4z" />
              <path d="M13.5 6.5l3 3" />
            </ColourGlyph>
          </PopoverButton>
          )}
          {/*
            The reference's text colour, on a drawing that HAS text — a
            control that moved nothing on an unlabelled line must not exist.
          */}
          {(TEXT_TOOLS.has(sel.tool) || Boolean(sel.style.text)) && (
            <PopoverButton
              label="Text color"
              className={BAR_ICON_BUTTON}
              popover={(close) => (
                <ColourPalette value={sel.style.textColor || sel.style.color} onDone={close} allowOpacity
                  onChange={(textColor) => applyStyle({ textColor })} />
              )}
            >
              <ColourGlyph colour={sel.style.textColor || sel.style.color}>
                <path d="M6 4.5h12M12 4.5V18" />
              </ColourGlyph>
            </PopoverButton>
          )}
          {TEXT_TOOLS.has(sel.tool) && (
            <PopoverButton
              label="Font size"
              className={BAR_TEXT_BUTTON}
              popover={(close) => (
                <FontSizePicker sizes={TEXT_SIZES} value={textSizeOf(sel.style, sel.tool)}
                  onChange={(fontSize) => { applyStyle({ fontSize }); close(); }} />
              )}
            >
              <span className="tabular">{textSizeOf(sel.style, sel.tool)}</span>
            </PopoverButton>
          )}
          {!TEXT_TOOLS.has(sel.tool) && (
          <>
          <PopoverButton
            label="Line width"
            className={BAR_TEXT_BUTTON}
            popover={(close) => (
              <WidthPicker layout="list" value={sel.style.width ?? 1}
                onChange={(width) => { applyStyle({ width }); close(); }} />
            )}
          >
            <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
              <path d="M0 6h18" stroke="currentColor" strokeWidth={Math.min(4, sel.style.width ?? 1)} />
            </svg>
            {sel.style.width ?? 1}px
          </PopoverButton>
          <PopoverButton
            label="Line style"
            className={BAR_ICON_BUTTON}
            popover={(close) => (
              <DashPicker layout="list" value={lineStyleOf(sel.style)} width={sel.style.width ?? 1}
                onChange={(next) => {
                  // `dashed` kept in step, as the settings dialog keeps it:
                  // every renderer here reads the boolean.
                  applyStyle({ lineStyle: next, dashed: next !== "solid" });
                  close();
                }} />
            )}
          >
            <BarGlyph>
              <path d="M3 12h18" strokeWidth="1.5"
                strokeDasharray={lineStyleOf(sel.style) === "solid" ? undefined
                  : lineStyleOf(sel.style) === "dotted" ? "1.5 3" : "5 3"} />
            </BarGlyph>
          </PopoverButton>
          </>
          )}
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
                  className="tvc-control flex h-[38px] items-center rounded-md px-1.5 text-[11px] text-ink-muted hover:text-ink"
                  aria-pressed={(sel.style.bands ?? 0) === n}
                  aria-label={n === 0 ? "No deviation bands" : `${n} standard-deviation band${n === 1 ? "" : "s"}`}
                  title={n === 0 ? "No bands" : `±${n}σ`}
                >
                  {n === 0 ? "0σ" : `${n}σ`}
                </button>
              ))}
            </>
          )}
          {/*
            A fixed range's own settings, on the bar beside it.

            Everything a profile is: how finely the price axis is cut, how much
            of the volume the value area holds, whether the rows are split by
            direction, and which edge they grow from. In the style bar rather
            than a dialog for the same reason the colour swatches are: this bar
            IS this product's per-drawing settings, and it appears next to
            whatever is selected.
          */}
          {sel.tool === "vprange" && (
            <>
              <span className="mx-0.5 h-4 w-px bg-border" />
              <select
                aria-label="Profile rows"
                title="How many price rows the profile is cut into"
                className="rounded bg-surface-2 px-1 py-0.5 text-[11px] text-ink-muted"
                value={String(profileStyle.rowSize)}
                onChange={(e) => applyProfile({
                  layout: "rows", rowSize: Number(e.target.value),
                })}
              >
                {[12, 24, 48, 100, 200].map((n) => (
                  <option key={n} value={n}>{n} rows</option>
                ))}
              </select>
              <select
                aria-label="Value area percent"
                title="Share of the range's volume inside the value area"
                className="rounded bg-surface-2 px-1 py-0.5 text-[11px] text-ink-muted"
                value={String(profileStyle.valueAreaPercent)}
                onChange={(e) => applyProfile({ valueAreaPercent: Number(e.target.value) })}
              >
                {[50, 60, 68, 70, 80, 90, 100].map((n) => (
                  <option key={n} value={n}>VA {n}%</option>
                ))}
              </select>
              <button
                onClick={() => applyProfile({
                  split: profileStyle.split === "upDown" ? "total" : "upDown",
                })}
                className="tvc-control flex h-[38px] items-center rounded-md px-1.5 text-[11px] text-ink-muted hover:text-ink"
                aria-pressed={profileStyle.split === "upDown"}
                aria-label={profileStyle.split === "upDown"
                  ? "Show total volume per row"
                  : "Split each row into up and down volume"}
                title={profileStyle.split === "upDown" ? "Up / down volume" : "Total volume"}
              >
                {profileStyle.split === "upDown" ? "↑↓" : "Σ"}
              </button>
              <button
                onClick={() => applyProfile({
                  side: profileStyle.side === "left" ? "right" : "left",
                })}
                className="tvc-control flex h-[38px] items-center rounded-md px-1.5 text-[11px] text-ink-muted hover:text-ink"
                aria-label={profileStyle.side === "left"
                  ? "Draw the rows from the right of the range"
                  : "Draw the rows from the left of the range"}
                title={`Drawn from the ${profileStyle.side}`}
              >
                {profileStyle.side === "left" ? "◧" : "◨"}
              </button>
              <button
                onClick={() => applyProfile({ showPoc: !profileStyle.showPoc })}
                className="tvc-control flex h-[38px] items-center rounded-md px-1.5 text-[11px] text-ink-muted hover:text-ink"
                aria-pressed={profileStyle.showPoc}
                aria-label={profileStyle.showPoc
                  ? "Hide the point-of-control line" : "Show the point-of-control line"}
                title="Point of control"
              >
                POC
              </button>
            </>
          )}
          {FILLABLE_TOOLS.has(sel.tool) && (
          <button
            onClick={() => applyStyle({ filled: !sel.style.filled })}
            className={BAR_ICON_BUTTON}
            title="Fill"
            aria-label={sel.style.filled ? "Remove the fill" : "Fill the shape"}
            aria-pressed={Boolean(sel.style.filled)}
          >
            <BarGlyph>
              <rect x="4" y="4" width="16" height="16" rx="2"
                fill={sel.style.filled ? "currentColor" : "none"} />
            </BarGlyph>
          </button>
          )}
          {/*
            TVP8: Settings.

            The settings dialog was reachable only by right-clicking — so the
            Coordinates tab, the text tab and every per-tool option were behind
            a gesture nobody had been told about. (Clone sat here too until
            M1 / F-10 measured the reference's bar without it; it is in More,
            the right-click menu and ⌘D.)
          */}
          <button
            onClick={() => {
              onOpenSettings?.(sel.id);
              const handler = onContextMenuRef.current;
              if (!onOpenSettings && handler && styleBarRef.current) {
                const box = styleBarRef.current.getBoundingClientRect();
                handler({
                  x: Math.round(box.left), y: Math.round(box.bottom + 4),
                  drawingId: sel.id, price: null, region: "plot",
                });
              }
            }}
            className={BAR_ICON_BUTTON}
            title="Settings"
            aria-label="Settings for this drawing"
          >
            <BarGlyph>
              <path d="M18.06 10.26L20.96 10.42L20.96 13.58L18.06 13.74L17.51 15.05L19.45 17.22L17.22 19.45L15.05 17.51L13.74 18.06L13.58 20.96L10.42 20.96L10.26 18.06L8.95 17.51L6.78 19.45L4.55 17.22L6.49 15.05L5.94 13.74L3.04 13.58L3.04 10.42L5.94 10.26L6.49 8.95L4.55 6.78L6.78 4.55L8.95 6.49L10.26 5.94L10.42 3.04L13.58 3.04L13.74 5.94L15.05 6.49L17.22 4.55L19.45 6.78L17.51 8.95Z" />
              <circle cx="12" cy="12" r="2.9" />
            </BarGlyph>
          </button>
          <button
            onClick={() => onChange(drawings.map((d) => (d.id === selected ? { ...d, locked: !d.locked } : d)))}
            className={BAR_ICON_BUTTON}
            title={sel.locked ? "Unlock" : "Lock"}
            aria-label={sel.locked ? "Unlock this drawing" : "Lock this drawing"}
            aria-pressed={Boolean(sel.locked)}
          >
            <BarGlyph>
              <rect x="5" y="10.5" width="14" height="10" rx="2" />
              {/* An open shackle leans clear of the body, so locked and unlocked
                  differ in SHAPE and not only in tint. */}
              <path d={sel.locked ? "M8 10.5V7.5a4 4 0 0 1 8 0v3" : "M8 10.5V7.5a4 4 0 0 1 7.8-1.1"} />
            </BarGlyph>
          </button>
          <button
            onClick={() => { onChange(drawings.filter((d) => d.id !== selected)); setSelected(null); }}
            disabled={locked || sel.locked}
            className="flex h-[38px] w-[38px] items-center justify-center rounded-md text-ink hover:bg-down/15 hover:text-down disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink"
            title={locked || sel.locked ? "Unlock this drawing to delete it" : "Delete (Del)"}
            aria-label="Delete this drawing"
          >
            {/*
              A bin, at the same size as its neighbours. A 10px cross was both
              the smallest thing on the bar and the wrong metaphor — a cross
              closes something, it does not delete it.
            */}
            <BarGlyph>
              <path d="M4 6h16M9 6V4h6v2M6.5 6l1 14h9l1-14" />
            </BarGlyph>
          </button>
          {/*
            `More` opens the drawing's MENU. It used to call `onOpenSettings`,
            which is exactly what the gear four controls to its left does — two
            controls, one behaviour, and no route to the menu at all from a
            selected drawing. That menu already exists and is good: right-
            clicking the same drawing gives Add alert / Visual order / Clone /
            Copy / Lock / Hide / Remove / Settings, with icons and shortcuts.
            This points at it, anchored to the button as every other menu is.

            The glyph is drawn rather than typed. `⋯` was a text character, so
            it took the font's own metrics instead of the icon grammar's —
            contract §3: "Icons are drawn, never typed."
          */}
          <button
            type="button"
            onClick={(event) => {
              const handler = onContextMenuRef.current;
              if (!handler) { onOpenSettings?.(sel.id); return; }
              const box = event.currentTarget.getBoundingClientRect();
              handler({
                x: Math.round(box.left), y: Math.round(box.bottom + 4),
                drawingId: sel.id, price: null, region: "plot",
              });
            }}
            className={BAR_ICON_BUTTON}
            title="More drawing actions" aria-label="More drawing actions"
          >
            <BarGlyph fill="currentColor">
              <circle cx="5" cy="12" r="1.4" stroke="none" />
              <circle cx="12" cy="12" r="1.4" stroke="none" />
              <circle cx="19" cy="12" r="1.4" stroke="none" />
            </BarGlyph>
          </button>
        </div>
      )}
    </>
  );
}

// ── per-tool geometry ───────────────────────────────────────────────────────

export type ToPx = (a: Anchor) => Pt;

function barsPatternSource(d: Drawing, candles: Candle[], toPx: ToPx): Pt[] {
  const from = Math.min(d.points[0]?.time ?? 0, d.points[1]?.time ?? 0);
  const to = Math.max(d.points[0]?.time ?? 0, d.points[1]?.time ?? 0);
  return candles.filter((c) => c.openTime / 1000 >= from && c.openTime / 1000 <= to)
    .map((c) => toPx({ time: c.openTime / 1000, price: c.close }));
}

const addPx = (p: Pt, normal: Pt, amount: number): Pt => ({ x: p.x + normal.x * amount, y: p.y + normal.y * amount });
const unitPerpendicular = (a: Pt, b: Pt): Pt => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
};

/** Multi-anchor TradingView families share one persisted template geometry. */
const TEMPLATE_TOOLS = new Set<DrawingTool>([
  "regression", "flatTopBottom", "schiffPitchfork", "modifiedSchiffPitchfork", "insidePitchfork",
  "fibChannel", "fibTimeZone", "trendFibTime", "fibSpeedResistanceFan", "fibSpeedResistanceArcs",
  "fibCircles", "fibSpiral", "fibWedge", "pitchfan", "gannBox", "gannSquareFixed", "gannSquare", "gannFan",
  "xabcd", "cypher", "headAndShoulders", "abcdPattern", "trianglePattern", "threeDrives",
  "elliottImpulse", "elliottCorrection", "elliottTriangle", "elliottDoubleCombo", "elliottTripleCombo",
  "cyclicLines", "timeCycles", "sineLine", "positionForecast", "barsPattern", "sector", "rotatedRectangle", "table",
]);
const GANN_TEMPLATE_TOOLS = new Set<DrawingTool>(["gannBox", "gannSquareFixed", "gannSquare", "gannFan"]);
const PATTERN_TEMPLATE_TOOLS = new Set<DrawingTool>([
  "xabcd", "cypher", "headAndShoulders", "abcdPattern", "trianglePattern", "threeDrives",
  "elliottImpulse", "elliottCorrection", "elliottTriangle", "elliottDoubleCombo", "elliottTripleCombo",
]);

/** Extend a→b far past b (used for rays and infinite lines). */
/**
 * The face a drawing's own text asks for.
 *
 * In the product's UI face (B-21), the chart's own `CHART_FONT`. It was
 * `ui-monospace`, on the argument that labels against prices should agree
 * about their width — but a text drawing is prose a user typed, and a code
 * face on it is the contract's §3 "prose in the costume of a stack trace":
 * beside Premium it read as a different product. Size, weight and slant come
 * from the Text tab; everything unset keeps the 13px the branch always had.
 */
function textFont(style: DrawingStyle): string {
  const bits: string[] = [];
  if (style.italic === true) bits.push("italic");
  if (style.bold === true) bits.push("bold");
  bits.push(`${style.fontSize ?? 13}px`);
  bits.push(CHART_FONT);
  return bits.join(" ");
}

/** The dash array a style asks for: the named style first, the boolean behind it. */
function dashPattern(style: DrawingStyle): number[] {
  if (style.lineStyle === "dotted") return [2, 3];
  if (style.lineStyle === "dashed") return [6, 4];
  if (style.lineStyle === "solid") return [];
  return style.dashed ? [6, 4] : [];
}

/**
 * The two ends to draw, after `Extend` has been applied.
 *
 * `far` already projects one point away from another; this is the same
 * geometry the `ray` and `extended` TOOLS use, reached from the settings
 * dialog instead of from a second tool — which is exactly what the reference
 * does.
 */
function extendedEnds(a: Pt, b: Pt, extend: DrawingExtend | undefined, span: number): [Pt, Pt] {
  switch (extend) {
    case "right": return [a, far(a, b, span)];
    case "left": return [far(b, a, span), b];
    case "both": return [far(b, a, span), far(a, b, span)];
    default: return [a, b];
  }
}

function far(a: Pt, b: Pt, span: number): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: b.x + (dx / len) * span, y: b.y + (dy / len) * span };
}

function distToDrawing(p: Pt, d: Drawing, toPx: ToPx, candles: Candle[] = []): number {
  const q = d.points.map(toPx);
  const a = q[0]!;
  const b = q[1] ?? a;
  const span = 6000;
  if (TEMPLATE_TOOLS.has(d.tool)) {
    if (["schiffPitchfork", "modifiedSchiffPitchfork", "insidePitchfork"].includes(d.tool)) {
      const variant: "schiff" | "modifiedSchiff" | "inside" = d.tool === "schiffPitchfork" ? "schiff" : d.tool === "modifiedSchiffPitchfork" ? "modifiedSchiff" : "inside";
      return Math.min(...pitchforkGeometry(q, variant, span).segments.map((s) => distToSegment(p, s.a, s.b)));
    }
    if (d.tool === "fibChannel" || d.tool === "pitchfan") {
      return Math.min(...fibChannelGeometry(q, undefined, span).segments.map((s) => distToSegment(p, s.a, s.b)));
    }
    if (d.tool === "fibTimeZone" || d.tool === "trendFibTime") {
      const period = Math.max(8, Math.abs(b.x - a.x));
      return Math.min(...[0, 1, 2, 3, 5, 8, 13, 21].map((step) => Math.abs(p.x - (a.x + Math.sign(b.x - a.x || 1) * period * step))));
    }
    if (d.tool === "fibWedge") {
      const c = q[2] ?? b;
      return Math.min(distToSegment(p, a, b), distToSegment(p, a, c), distToSegment(p, b, c),
        ...[0.382, 0.618].map((ratio) => distToSegment(p,
          { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio },
          { x: a.x + (c.x - a.x) * ratio, y: a.y + (c.y - a.y) * ratio })));
    }
    if (d.tool === "flatTopBottom") {
      const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
      return Math.min(distToSegment(p, a, b), Math.abs(p.y - top), Math.abs(p.y - bottom));
    }
    if (d.tool === "gannFan") {
      return Math.min(...[-2, -1, -0.5, 0.5, 1, 2].map((slope) => distToSegment(p, a, { x: a.x + span, y: a.y + slope * span })));
    }
    if (d.tool === "gannBox" || d.tool === "gannSquareFixed" || d.tool === "gannSquare") {
      return Math.min(...gannSquareGeometry(a, b, d.tool === "gannSquareFixed").segments.map((s) => distToSegment(p, s.a, s.b)));
    }
    if (d.tool === "fibSpeedResistanceFan") {
      const direction = { x: b.x - a.x, y: b.y - a.y };
      return Math.min(...[0.236, 0.382, 0.5, 0.618, 0.786, 1].map((ratio) => distToSegment(p, a, { x: a.x + direction.x * 4, y: a.y + direction.y * ratio * 4 })));
    }
    if (d.tool === "fibSpeedResistanceArcs" || d.tool === "fibCircles" || d.tool === "fibSpiral") {
      const radius = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y));
      return Math.min(...[1, 2, 3, 4, 5].map((i) => Math.abs(Math.hypot(p.x - a.x, p.y - a.y) - radius * i / 3)));
    }
    if (d.tool === "sector") {
      const c = q[2] ?? b; const radius = Math.hypot(b.x - a.x, b.y - a.y);
      return Math.min(Math.abs(Math.hypot(p.x - a.x, p.y - a.y) - radius), distToSegment(p, a, b), distToSegment(p, a, c));
    }
    if (d.tool === "rotatedRectangle" && q[2]) {
      const c = q[2]!; const d4 = { x: a.x + c.x - b.x, y: a.y + c.y - b.y };
      return Math.min(distToSegment(p, a, b), distToSegment(p, b, c), distToSegment(p, c, d4), distToSegment(p, d4, a));
    }
    if (d.tool === "table") {
      const width = Math.max(90, Math.abs(b.x - a.x)); let best = Infinity;
      for (let i = 0; i <= 4; i++) best = Math.min(best, distToSegment(p, { x: a.x, y: a.y + i * 20 }, { x: a.x + width, y: a.y + i * 20 }));
      return Math.min(best, distToSegment(p, a, { x: a.x, y: a.y + 80 }), distToSegment(p, { x: a.x + width, y: a.y }, { x: a.x + width, y: a.y + 80 }), distToSegment(p, { x: a.x + width / 2, y: a.y }, { x: a.x + width / 2, y: a.y + 80 }));
    }
    if (d.tool === "regression") {
      const t0 = Math.min(d.points[0]!.time, d.points[1]!.time);
      const t1 = Math.max(d.points[0]!.time, d.points[1]!.time);
      const observations = candles.filter((c) => c.openTime / 1000 >= t0 && c.openTime / 1000 <= t1)
        .map((c) => toPx({ time: c.openTime / 1000, price: c.close }));
      const fit = regressionGeometry(q, observations);
      if (fit) {
        const normal = unitPerpendicular(fit.center.a, fit.center.b);
        return Math.min(distToSegment(p, fit.center.a, fit.center.b),
          distToSegment(p, addPx(fit.center.a, normal, fit.deviation), addPx(fit.center.b, normal, fit.deviation)),
          distToSegment(p, addPx(fit.center.a, normal, -fit.deviation), addPx(fit.center.b, normal, -fit.deviation)));
      }
    }
    if (d.tool === "cyclicLines" || d.tool === "timeCycles" || d.tool === "sineLine") {
      const projection = timeProjection(d.tool, q, 10000);
      return Math.min(...projection.verticals.map((x) => Math.abs(p.x - x)), ...projection.segments.map((s) => distToSegment(p, s.a, s.b)));
    }
    if (d.tool === "positionForecast") {
      return Math.min(...positionForecastGeometry(q, span).segments.map((s) => distToSegment(p, s.a, s.b)));
    }
    if (d.tool === "barsPattern") {
      const source = barsPatternSource(d, candles, toPx);
      return Math.min(...barsPatternGeometry(q, source, span).segments.map((s) => distToSegment(p, s.a, s.b)));
    }
    let best = Math.hypot(p.x - a.x, p.y - a.y);
    for (let i = 1; i < q.length; i++) best = Math.min(best, distToSegment(p, q[i - 1]!, q[i]!));
    return best;
  }
  switch (d.tool) {
    case "trend": case "trendAngle": case "arrow": case "arrowMarker": case "infoline": case "pricerange": case "daterange": case "datePriceRange": case "ruler":
      return distToSegment(p, a, b);
    case "ray": return distToRay(p, a, b);
    case "extended": return distToLine(p, a, b);
    case "dot": case "arrowUp": case "arrowDown": return Math.hypot(p.x - a.x, p.y - a.y);
    case "hline": return Math.abs(p.y - a.y);
    case "crossline": return Math.min(Math.abs(p.x - a.x), Math.abs(p.y - a.y));
    case "hray": return p.x >= a.x - HIT_PX ? Math.abs(p.y - a.y) : Math.hypot(p.x - a.x, p.y - a.y);
    case "vline": return Math.abs(p.x - a.x);
    // The anchor is the grabbable part; the computed line is an overlay and is
    // not on this canvas to be hit at all.
    case "avwap": return Math.hypot(p.x - a.x, p.y - a.y);
    /*
     * Only the two vertical edges are grabbable, at any height.
     *
     * The histogram itself is a decoration on another canvas and is not here to
     * be hit — and it must not be, because a profile drawn 30 % of the way
     * across the pane would otherwise swallow every click that lands on the
     * candles behind it.
     */
    case "vprange": return Math.min(Math.abs(p.x - a.x), Math.abs(p.x - b.x));
    case "avprofile": return Math.hypot(p.x - a.x, p.y - a.y);
    case "rect": case "long": case "short":
      return distToRect(p, a, b, !!d.style.filled || d.tool !== "rect");
    case "ellipse": return distToEllipse(p, a, b, !!d.style.filled);
    case "circle": {
      const radius = Math.hypot(b.x - a.x, b.y - a.y);
      const distance = Math.hypot(p.x - a.x, p.y - a.y);
      return d.style.filled && distance <= radius ? 0 : Math.abs(distance - radius);
    }
    case "triangle": {
      const c = q[2] ?? b;
      return Math.min(distToSegment(p, a, b), distToSegment(p, b, c), distToSegment(p, c, a));
    }
    case "arc": case "curve": case "doubleCurve": {
      let best = Infinity;
      for (let i = 1; i < q.length; i++) best = Math.min(best, distToSegment(p, q[i - 1]!, q[i]!));
      return best;
    }
    case "parallel": {
      const c = q[2] ?? b;
      const off = c.y - (a.y + b.y) / 2;
      return Math.min(
        distToSegment(p, a, b),
        distToSegment(p, { x: a.x, y: a.y + off }, { x: b.x, y: b.y + off })
      );
    }
    case "disjointChannel": {
      const c = q[2] ?? b;
      return Math.min(distToRay(p, a, b), distToRay(p, a, c));
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
    case "path": case "polyline": case "brush": case "highlighter": {
      let best = Infinity;
      for (let i = 1; i < q.length; i++) best = Math.min(best, distToSegment(p, q[i - 1]!, q[i]!));
      return best;
    }
    case "text": case "note": case "priceNote": case "pin": case "comment": case "callout": case "pricelabel": case "signpost": case "flagMark":
      return Math.hypot(p.x - a.x, p.y - a.y) <= 40 ? 0 : Infinity;
    // The glyph is painted centred on its anchor at 22px, so its own box is
    // what can be grabbed — not the 40px reach the text tools need for a
    // caption that trails off to the right of theirs.
    case "icon":
      return Math.max(Math.abs(p.x - a.x), Math.abs(p.y - a.y)) <= 14 ? 0 : Infinity;
    default:
      return Infinity;
  }
}

/**
 * Exported for `drawingStyleRender.test.ts`.
 *
 * Eleven controls in the settings dialog were writing style keys this function
 * never read — the dialog's own tests asserted its SHAPE, so nothing noticed.
 * The tests that do notice have to drive this directly with a recording
 * context, which is why it is reachable from outside.
 */
export function drawOne(
  ctx: CanvasRenderingContext2D, d: Drawing, toPx: ToPx,
  w: number, h: number, selected: boolean, hovered: boolean, candles: Candle[] = [],
  /**
   * M1 / F-01: paint the drawing without its caption (and a note's box), for
   * the one being typed into — the inline editor sits where they would be.
   */
  omitText = false,
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
  /*
   * The three-value vocabulary, not the boolean.
   *
   * `lineStyle` is what the settings dialog writes; `dashed` is the older key
   * kept in step beside it. Reading only the boolean is what made a DOTTED
   * line draw identically to a dashed one — the control moved, the picture did
   * not. The boolean is still the fallback, so a drawing saved before
   * `lineStyle` existed keeps drawing exactly as it did.
   */
  ctx.setLineDash(dashPattern(d.style));
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.font = `11px ${CHART_FONT}`;

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
    // Chosen from the chip, not fixed: `bg` defaults to the DRAWING's own
    // colour, and on the light theme even the semantic green is dark enough
    // that black text on it reads at 2.2:1.
    ctx.fillStyle = readableOn(opaque(bg));
    ctx.fillText(text, x + pad, y);
    ctx.fillStyle = color;
  };
  const fillAlpha = (fn: () => void, alpha: number): void => {
    ctx.save(); ctx.globalAlpha = alpha; fn(); ctx.restore();
  };

  if (TEMPLATE_TOOLS.has(d.tool)) {
    // Advanced tools are rendered from their actual construction rules. The
    // persisted anchors remain the handles; all secondary lines are derived.
    if (["schiffPitchfork", "modifiedSchiffPitchfork", "insidePitchfork"].includes(d.tool)) {
      const variant: "schiff" | "modifiedSchiff" | "inside" = d.tool === "schiffPitchfork" ? "schiff" : d.tool === "modifiedSchiffPitchfork" ? "modifiedSchiff" : "inside";
      for (const segment of pitchforkGeometry(q, variant).segments) line(segment.a, segment.b);
    } else if (d.tool === "fibChannel" || d.tool === "pitchfan") {
      for (const segment of fibChannelGeometry(q).segments) line(segment.a, segment.b);
    } else if (d.tool === "fibTimeZone" || d.tool === "trendFibTime") {
      const fibSteps = [0, 1, 2, 3, 5, 8, 13, 21];
      const period = Math.max(8, Math.abs(b.x - a.x));
      for (const step of fibSteps) {
        const x = a.x + Math.sign(b.x - a.x || 1) * period * step;
        line({ x, y: 0 }, { x, y: h });
        label(`${step}`, x + 3, 14);
      }
    } else if (d.tool === "fibSpeedResistanceFan" || d.tool === "fibSpeedResistanceArcs") {
      const direction = { x: b.x - a.x, y: b.y - a.y };
      for (const ratio of [0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
        if (d.tool === "fibSpeedResistanceFan") line(a, { x: a.x + direction.x * 4, y: a.y + direction.y * ratio * 4 });
        else { ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(8, Math.hypot(direction.x, direction.y) * ratio), 0, Math.PI * 2); ctx.stroke(); }
      }
    } else if (d.tool === "fibCircles" || d.tool === "fibSpiral") {
      const radius = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y));
      for (let i = 1; i <= 5; i++) { ctx.beginPath(); ctx.arc(a.x, a.y, radius * i / 3, 0, Math.PI * 2); ctx.stroke(); }
      if (d.tool === "fibSpiral") { ctx.beginPath(); for (let t = 0; t < Math.PI * 4; t += 0.12) { const r = radius * t / (Math.PI * 2); const p = { x: a.x + Math.cos(t) * r, y: a.y + Math.sin(t) * r }; if (t === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); } ctx.stroke(); }
    } else if (d.tool === "fibWedge") {
      const c = q[2] ?? b; line(a, b); line(a, c); line(b, c);
      for (const ratio of [0.382, 0.618]) line({ x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }, { x: a.x + (c.x - a.x) * ratio, y: a.y + (c.y - a.y) * ratio });
    } else if (d.tool === "flatTopBottom") {
      // Flat top/bottom channel: the first segment is the trend edge and the
      // second handle chooses which horizontal boundary is active.
      line(a, b);
      const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
      line({ x: 0, y: top }, { x: w, y: top });
      line({ x: 0, y: bottom }, { x: w, y: bottom });
    } else if (d.tool === "gannFan") {
      for (const slope of [-2, -1, -0.5, 0.5, 1, 2]) line(a, { x: a.x + span, y: a.y + slope * span });
    } else if (GANN_TEMPLATE_TOOLS.has(d.tool)) {
      for (const segment of gannSquareGeometry(a, b, d.tool === "gannSquareFixed").segments) line(segment.a, segment.b);
    } else if (PATTERN_TEMPLATE_TOOLS.has(d.tool)) {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); for (let i = 1; i < q.length; i++) ctx.lineTo(q[i]!.x, q[i]!.y); ctx.stroke();
      const labels = patternLabels(d.tool); q.forEach((point, index) => label(labels[index] ?? String(index + 1), point.x + 4, point.y - 4));
    } else if (d.tool === "regression") {
      const t0 = Math.min(d.points[0]!.time, d.points[1]!.time);
      const t1 = Math.max(d.points[0]!.time, d.points[1]!.time);
      const observations = candles.filter((c) => c.openTime / 1000 >= t0 && c.openTime / 1000 <= t1).map((c) => toPx({ time: c.openTime / 1000, price: c.close }));
      const fit = regressionGeometry(q, observations);
      if (fit) {
        line(fit.center.a, fit.center.b);
        const normal = unitPerpendicular(fit.center.a, fit.center.b);
        line(addPx(fit.center.a, normal, fit.deviation), addPx(fit.center.b, normal, fit.deviation));
        line(addPx(fit.center.a, normal, -fit.deviation), addPx(fit.center.b, normal, -fit.deviation));
      }
    } else if (d.tool === "cyclicLines" || d.tool === "timeCycles" || d.tool === "sineLine") {
      const projection = timeProjection(d.tool, q, h);
      for (const x of projection.verticals) line({ x, y: 0 }, { x, y: h });
      for (const segment of projection.segments) line(segment.a, segment.b);
    } else if (d.tool === "positionForecast") {
      const geometry = positionForecastGeometry(q, span);
      for (const segment of geometry.segments) line(segment.a, segment.b);
      if (geometry.polygons[0]) { ctx.globalAlpha = 0.08; ctx.beginPath(); geometry.polygons[0]!.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; }
    } else if (d.tool === "barsPattern") {
      const geometry = barsPatternGeometry(q, barsPatternSource(d, candles, toPx), span);
      for (const segment of geometry.segments) line(segment.a, segment.b);
      if (geometry.polygons[0]) { ctx.globalAlpha = 0.08; ctx.beginPath(); geometry.polygons[0]!.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; }
    } else if (d.tool === "sector") {
      const c = q[2] ?? b; const r = Math.hypot(b.x - a.x, b.y - a.y); const start = Math.atan2(b.y - a.y, b.x - a.x); const end = Math.atan2(c.y - a.y, c.x - a.x);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.arc(a.x, a.y, r, start, end); ctx.closePath();
      if (d.style.filled) fillAlpha(() => ctx.fill(), 0.12);
      ctx.stroke();
    } else if (d.tool === "table") {
      const width = Math.max(90, Math.abs(b.x - a.x)); const rows = 4; for (let i = 0; i <= rows; i++) line({ x: a.x, y: a.y + i * 20 }, { x: a.x + width, y: a.y + i * 20 }); line({ x: a.x, y: a.y }, { x: a.x, y: a.y + rows * 20 }); line({ x: a.x + width / 2, y: a.y }, { x: a.x + width / 2, y: a.y + rows * 20 });
    } else if (d.tool === "rotatedRectangle" && q.length >= 3) {
      /*
       * TVP8: this used to sit AFTER the generic `else`, not inside the ladder,
       * so a rotated rectangle was stroked twice — once as an open polyline
       * through its three anchors and again as the closed parallelogram. On a
       * translucent or thick line the doubled edges were visibly darker than
       * every other shape's, and the stray open path ran where no edge is.
       */
      const c = q[2]!; const d4 = { x: a.x + c.x - b.x, y: a.y + c.y - b.y };
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d4.x, d4.y); ctx.closePath();
      if (d.style.filled) fillAlpha(() => ctx.fill(), 0.12); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); for (let i = 1; i < q.length; i++) ctx.lineTo(q[i]!.x, q[i]!.y); ctx.stroke();
    }
    if (selected) {
      ctx.setLineDash([]);
      for (const point of q) {
        ctx.beginPath(); ctx.arc(point.x, point.y, HANDLE_PX, 0, Math.PI * 2);
        ctx.fillStyle = chartSurface(); ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }

  switch (d.tool) {
    case "dot":
      ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(3, d.style.width + 1), 0, Math.PI * 2); ctx.fill();
      break;
    case "trend": {
      const [from, to] = extendedEnds(a, b, d.style.extend, span);
      line(from, to);
      break;
    }
    case "trendAngle": {
      const [from, to] = extendedEnds(a, b, d.style.extend, span);
      line(from, to);
      const degrees = Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI;
      label(`${degrees.toFixed(1)}°`, b.x + 5, b.y - 5);
      break;
    }
    case "infoline": {
      line(a, b);
      line({ x: a.x, y: a.y }, { x: a.x, y: b.y });
      line({ x: a.x, y: b.y }, { x: b.x, y: b.y });
      label(`${fmtPrice(d.points[1]!.price - d.points[0]!.price)} · ${fmtDuration(Math.abs(d.points[1]!.time - d.points[0]!.time))}`, b.x + 5, b.y - 5);
      break;
    }
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
    // B-21: the level's price is tagged on the price AXIS, by
    // `DrawingAxisLabelsPrimitive` — not as a box over the plot.
    case "hline":
      line({ x: 0, y: a.y }, { x: w, y: a.y });
      break;
    case "hray":
      line(a, { x: w, y: a.y });
      break;
    case "vline": line({ x: a.x, y: 0 }, { x: a.x, y: h }); break;
    case "crossline":
      line({ x: 0, y: a.y }, { x: w, y: a.y }); line({ x: a.x, y: 0 }, { x: a.x, y: h }); break;
    /*
     * Anchored VWAP: the canvas draws only the ANCHOR.
     *
     * The line itself is a chart overlay (`lib/anchoredVwap`), so it sits on
     * the price scale, joins the legend at the right precision, and is drawn
     * by the same renderer as every other series. What the canvas owns is what
     * makes it a drawing: a grabbable point at the bar it starts from, and a
     * short marker so the anchor is visible even where the line is far away.
     */
    case "avwap": case "avprofile": {
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      line({ x: a.x, y: a.y - 8 }, { x: a.x, y: a.y + 8 });
      break;
    }
    /*
     * The range, and nothing else.
     *
     * Two verticals across the full height, because a volume profile covers
     * every price its bars traded at — bounding it top and bottom would draw a
     * limit the profile does not have. The histogram is painted by
     * `VolumeProfileLayer`, against price, on its own canvas.
     */
    case "vprange": {
      const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      fillAlpha(() => ctx.fillRect(left, 0, right - left, h), 0.06);
      ctx.save();
      ctx.setLineDash([5, 4]);
      line({ x: left, y: 0 }, { x: left, y: h });
      line({ x: right, y: 0 }, { x: right, y: h });
      ctx.restore();
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
    case "circle": {
      const radius = Math.hypot(b.x - a.x, b.y - a.y);
      ctx.beginPath(); ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
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
    case "path": case "polyline": case "brush": case "highlighter": {
      if (d.tool === "highlighter") { ctx.save(); ctx.globalAlpha = 0.28; ctx.lineWidth = Math.max(8, d.style.width * 3); }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (let i = 1; i < q.length; i++) ctx.lineTo(q[i]!.x, q[i]!.y);
      ctx.stroke();
      if (d.tool === "highlighter") ctx.restore();
      break;
    }
    case "arrowMarker": {
      ctx.beginPath(); ctx.arc(a.x, a.y, 4, 0, Math.PI * 2); ctx.fill();
      line(a, { x: a.x + 22, y: a.y - 22 });
      break;
    }
    case "arrowUp": case "arrowDown": {
      const dir = d.tool === "arrowUp" ? -1 : 1;
      line({ x: a.x, y: a.y - dir * 10 }, { x: a.x, y: a.y + dir * 10 });
      ctx.beginPath(); ctx.moveTo(a.x, a.y + dir * 10); ctx.lineTo(a.x - 6, a.y + dir * 3); ctx.lineTo(a.x + 6, a.y + dir * 3); ctx.closePath(); ctx.fill();
      break;
    }
    case "arc": case "curve": case "doubleCurve": {
      const control = q[1] ?? a;
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(control.x, control.y, (q[2] ?? b).x, (q[2] ?? b).y);
      if (d.tool === "doubleCurve" && q[3]) ctx.quadraticCurveTo(q[2]!.x, q[2]!.y, q[3]!.x, q[3]!.y);
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
    case "disjointChannel": {
      const c = q[2] ?? b;
      const bFar = far(a, b, span), cFar = far(a, c, span);
      fillAlpha(() => {
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        ctx.lineTo(bFar.x, bFar.y); ctx.lineTo(cFar.x, cFar.y); ctx.closePath(); ctx.fill();
      }, 0.08);
      line(a, bFar); line(a, cFar);
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
    case "pricerange": case "daterange": case "datePriceRange": case "ruler": {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
      const dp = d.points[1]!.price - d.points[0]!.price;
      const pct = d.points[0]!.price !== 0 ? (dp / d.points[0]!.price) * 100 : 0;
      const bars = Math.round((d.points[1]!.time - d.points[0]!.time) /
        Math.max(1, Math.abs(d.points[1]!.time - d.points[0]!.time) || 1));
      const up = dp >= 0;
      const tone = up ? chartPositive() : chartNegative();
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
      fillAlpha(() => { ctx.fillStyle = chartPositive(); ctx.fillRect(x1, Math.min(pe.y, pt.y), rw, Math.abs(pt.y - pe.y)); }, 0.18);
      fillAlpha(() => { ctx.fillStyle = chartNegative(); ctx.fillRect(x1, Math.min(pe.y, ps.y), rw, Math.abs(ps.y - pe.y)); }, 0.18);
      const rule = chartInkMuted();
      ctx.strokeStyle = rule;
      line({ x: x1, y: pe.y }, { x: x1 + rw, y: pe.y });
      const risk = Math.abs(entry.price - stop.price);
      const reward = Math.abs(target.price - entry.price);
      const rr = risk > 0 ? reward / risk : 0;
      // No `fillStyle` here: `label` paints its own chip and its own text.
      label(`${d.tool === "long" ? "LONG" : "SHORT"}  R:R ${rr.toFixed(2)}`, x1 + 4, Math.min(pe.y, pt.y) - 6, rule);
      ctx.fillStyle = chartPositive();
      ctx.fillText(`TP ${fmtPrice(target.price)}`, x1 + 4, pt.y + (pt.y < pe.y ? 12 : -4));
      ctx.fillStyle = chartNegative();
      ctx.fillText(`SL ${fmtPrice(stop.price)}`, x1 + 4, ps.y + (ps.y > pe.y ? -4 : 12));
      break;
    }
    case "text": case "note": case "priceNote": case "pin": case "comment": case "signpost": case "flagMark": {
      /*
       * The Text tab, which the dialog has offered and this branch ignored.
       *
       * `13px ui-monospace` was hardcoded and `fillStyle` came from the line
       * colour, so Bold, Italic, size, the text's own colour and both
       * alignments were controls that changed the stored drawing and nothing
       * else. The line colour is still the fallback for `textColor`, so a
       * drawing that never set one looks exactly as it did.
       *
       * M1 / F-10: and the TEXT colour is the text's on every one of these.
       * The note, comment, signpost and price note painted their caption in
       * the line colour, so the toolbar's Text colour moved nothing on them.
       * Their box and stem stay in the line colour. A caption may now hold
       * line breaks (Shift+Enter in the inline editor): the plain caption and
       * the note's box stack them; the one-line chips join them with spaces.
       */
      const textColour = d.style.textColor || color;
      ctx.fillStyle = textColour;
      ctx.font = textFont(d.style);
      const caption = d.style.text ?? "";
      const lineHeight = textLineHeight(textSizeOf(d.style, d.tool));
      const widest = (rows: string[]): number => Math.max(0, ...rows.map((row) => ctx.measureText(row).width));
      if (d.tool === "pin") {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x - 8, a.y - 18);
        ctx.lineTo(a.x, a.y - 28); ctx.lineTo(a.x + 8, a.y - 18); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.arc(a.x, a.y - 18, 3, 0, Math.PI * 2); ctx.fillStyle = chartSurface(); ctx.fill();
        break;
      }
      if (d.tool === "priceNote") {
        line(a, { x: a.x + 18, y: a.y - 18 });
        if (omitText) break;
        const text = `${fmtPrice(d.points[0]!.price)}${caption ? ` · ${caption.replace(/\n/g, " ")}` : ""}`;
        const tw = ctx.measureText(text).width + 10;
        ctx.fillStyle = color;
        fillAlpha(() => ctx.fillRect(a.x + 18, a.y - 30, tw, 20), 0.16);
        ctx.strokeRect(a.x + 18, a.y - 30, tw, 20);
        ctx.fillStyle = textColour; ctx.fillText(text, a.x + 23, a.y - 16);
        break;
      }
      if (d.tool === "note" || d.tool === "comment") {
        if (omitText) break;
        const rows = (caption || (d.tool === "note" ? "Note" : "Comment")).split("\n");
        const tw = widest(rows) + 12;
        const bh = 20 + (rows.length - 1) * lineHeight;
        const bx = a.x + 10, by = a.y - 30;
        ctx.fillStyle = color;
        fillAlpha(() => ctx.fillRect(bx, by, tw, bh), 0.16);
        ctx.strokeRect(bx, by, tw, bh);
        ctx.beginPath(); ctx.moveTo(bx + 8, by + bh); ctx.lineTo(bx + 3, by + bh + 6); ctx.lineTo(bx + 15, by + bh); ctx.stroke();
        ctx.fillStyle = textColour;
        rows.forEach((row, i) => ctx.fillText(row, bx + 6, by + 14 + i * lineHeight));
        break;
      }
      if (d.tool === "signpost") {
        line(a, { x: a.x, y: a.y - 28 });
        if (omitText) break;
        const text = caption.replace(/\n/g, " ") || "Signpost";
        const tw = ctx.measureText(text).width + 12;
        ctx.fillStyle = color;
        fillAlpha(() => ctx.fillRect(a.x - tw / 2, a.y - 45, tw, 18), 0.16);
        ctx.strokeRect(a.x - tw / 2, a.y - 45, tw, 18);
        ctx.fillStyle = textColour; ctx.fillText(text, a.x - tw / 2 + 6, a.y - 32);
        break;
      }
      if (d.tool === "flagMark") {
        line(a, { x: a.x, y: a.y - 24 });
        ctx.beginPath(); ctx.moveTo(a.x, a.y - 24); ctx.lineTo(a.x + 22, a.y - 16); ctx.lineTo(a.x, a.y - 8); ctx.closePath(); ctx.fill();
      }
      if (omitText) break;
      ctx.fillStyle = textColour;
      // Alignment is set for this draw only and put back, because the context
      // is shared with every branch below and a leaked `textAlign` would move
      // labels that never asked to be moved.
      const hAlign = d.style.textHAlign ?? "left";
      const vAlign = d.style.textVAlign ?? "bottom";
      ctx.textAlign = hAlign === "center" ? "center" : hAlign === "right" ? "right" : "left";
      ctx.textBaseline = vAlign === "top" ? "top" : vAlign === "middle" ? "middle" : "alphabetic";
      // Several lines stack from the anchor the way the alignment says: a
      // bottom-aligned caption keeps its LAST line on the anchor.
      const rows = caption.split("\n");
      const firstY = a.y - (vAlign === "bottom" ? (rows.length - 1) * lineHeight
        : vAlign === "middle" ? ((rows.length - 1) * lineHeight) / 2 : 0);
      rows.forEach((row, i) => ctx.fillText(row, hAlign === "left" ? a.x + 4 : a.x, firstY + i * lineHeight));
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      break;
    }
    /*
     * Zoom in, mid-drag. Nothing is ever committed with this tool, so this
     * branch only ever draws the DRAFT: the band of time the release will
     * become the viewport.
     */
    case "zoom": {
      const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
      fillAlpha(() => ctx.fillRect(x1, 0, x2 - x1, h), 0.12);
      line({ x: x1, y: 0 }, { x: x1, y: h });
      line({ x: x2, y: 0 }, { x: x2, y: h });
      break;
    }
    case "icon": {
      /*
       * Text, not artwork: the glyph is a Unicode character the platform draws
       * with its own emoji face, so it needs no asset, scales with the canvas
       * and carries no third-party image.
       */
      ctx.font = "22px " + EMOJI_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(d.style.glyph ?? "\u{1F600}", a.x, a.y);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      break;
    }
    case "callout": {
      /*
       * M1 / F-10: the callout reads its Text tab too — size, weight, slant
       * and the text colour — with the 12px it always had as the default.
       */
      const size = textSizeOf(d.style, d.tool);
      const rows = (d.style.text ?? "").split("\n");
      const lineHeight = textLineHeight(size);
      ctx.font = textFont({ ...d.style, fontSize: size });
      const tw = Math.max(0, ...rows.map((row) => ctx.measureText(row).width)) + 14;
      const bh = 24 + (rows.length - 1) * lineHeight;
      const bx = a.x + 26, by = a.y - 44;
      line(a, { x: bx, y: by + 22 });
      if (omitText) break;
      fillAlpha(() => { ctx.fillStyle = color; ctx.fillRect(bx, by, tw, bh); }, 0.18);
      ctx.strokeRect(bx, by, tw, bh);
      ctx.fillStyle = d.style.textColor || color;
      rows.forEach((row, i) => ctx.fillText(row, bx + 7, by + 16 + i * lineHeight));
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

  /*
   * ── The settings the dialog writes and the switch above does not read ────
   *
   * Middle point, price labels and the info block are drawn HERE rather than
   * inside each tool's case: they are the same decoration on any drawing with
   * two anchors, and repeating them per branch is how three of them ended up
   * implemented nowhere at all.
   *
   * The dialog offers Middle point and the info block when the tool has two
   * anchors, and Price labels on everything, so the gating matches it exactly.
   */
  const anchors = TOOL_POINTS[d.tool] ?? d.points.length;
  ctx.setLineDash([]);

  // `Price labels` are tagged on the price AXIS (B-21) — see
  // `lib/drawingAxisLabels` — rather than painted here, 62px inside the plot.

  if (anchors >= 2 && d.style.middlePoint === true && q.length >= 2) {
    ctx.beginPath();
    ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(3, d.style.width + 1), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /*
   * The info block: bars, change and angle.
   *
   * The maths is the `Info line` tool's own — this is the same computation
   * offered where the reference offers it, rather than a second one that could
   * disagree with it. `alwaysShowStats` is what decides whether it survives
   * deselection; without it the block is a selection affordance.
   */
  if (
    anchors >= 2 && d.style.stats === true && q.length >= 2 &&
    d.points.length >= 2 && (selected || d.style.alwaysShowStats === true)
  ) {
    const p0 = d.points[0]!, p1 = d.points[1]!;
    const change = p1.price - p0.price;
    const pct = p0.price === 0 ? 0 : (change / p0.price) * 100;
    const degrees = Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI;
    const text =
      `${change >= 0 ? "+" : ""}${fmtPrice(change)} (${pct.toFixed(2)}%) · ` +
      `${fmtDuration(Math.abs(p1.time - p0.time))} · ${degrees.toFixed(1)}°`;

    ctx.font = `11px ${CHART_FONT}`;
    const tw = ctx.measureText(text).width;
    const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
    const x = d.style.statsPosition === "left" ? left
      : d.style.statsPosition === "center" ? (left + right) / 2 - tw / 2
      : right + 8;
    label(text, x, Math.min(a.y, b.y) - 8);
  }

  // Anchor handles for the selected drawing.
  if (selected) {
    ctx.setLineDash([]);
    for (const p of q) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_PX, 0, Math.PI * 2);
      // The pane's ground, not black: a handle is a coloured RING around a
      // hole in the chart, and on a white chart `#0f0f0f` is an ink blot.
      ctx.fillStyle = chartSurface();
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
