/**
 * `line.*`, `box.*`, `label.*` and `table.*` — Pine's drawing objects.
 *
 * A registry owns every drawing a run creates, in creation order. Pine caps
 * how many of each kind survive (`max_lines_count` and friends, default 50):
 * once the cap is passed the OLDEST drawing is dropped, which is what makes
 * scripts that draw one line per bar terminate with a bounded picture instead
 * of an unbounded one. That eviction is load-bearing, not an optimisation —
 * without it a 120k-bar run would emit 120k lines to the browser.
 *
 * Coordinates are stored exactly as the script gave them, in whatever `xloc`
 * it chose, and are only resolved to chart time when the run is serialised —
 * see `emit`. A script may move a drawing many times before the run ends, and
 * only the final position is ever drawn.
 */
import { PineDrawing, type DrawingKind, type PineValue, type TableCell } from "./values";

function bad(msg: string): never { throw new Error(msg); }

/** What the chart receives for one finished drawing. */
export interface DrawnLine {
  x1: number; y1: number; x2: number; y2: number;
  color: string; width: number; style: string; extend: string;
}
export interface DrawnBox {
  left: number; top: number; right: number; bottom: number;
  borderColor: string; borderWidth: number; borderStyle: string; bgColor: string;
  text: string; textColor: string;
}
export interface DrawnLabel {
  x: number; y: number; text: string;
  color: string; textColor: string; style: string; size: string;
}
export interface DrawnTable {
  position: string;
  cells: { col: number; row: number; text: string; textColor: string; bgColor: string }[];
}
export interface DrawnOutput {
  lines: DrawnLine[];
  boxes: DrawnBox[];
  labels: DrawnLabel[];
  tables: DrawnTable[];
}

/** Bar context the registry needs to turn an x coordinate into chart time. */
export interface BarContext {
  /** bar open time in ms for a bar index, extrapolated past the last bar */
  timeAt(barIndex: number): number;
}

const DEFAULT_MAX = 50;
/** Hard ceiling regardless of what the script declares, to bound the payload. */
const ABSOLUTE_MAX = 500;

export class DrawingRegistry {
  private byKind = new Map<DrawingKind, PineDrawing[]>();
  private limits = new Map<DrawingKind, number>();
  private nextId = 1;

  /** Apply `max_lines_count` etc. from the indicator()/strategy() call. */
  setLimit(kind: DrawingKind, n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    this.limits.set(kind, Math.min(Math.trunc(n), ABSOLUTE_MAX));
  }

  private limitFor(kind: DrawingKind): number {
    return this.limits.get(kind) ?? DEFAULT_MAX;
  }

  create(kind: DrawingKind, props: Map<string, PineValue>): PineDrawing {
    const d = new PineDrawing(kind, this.nextId++, props);
    let list = this.byKind.get(kind);
    if (!list) { list = []; this.byKind.set(kind, list); }
    list.push(d);
    // Evict oldest beyond the cap. Tombstoned entries are dropped first, so a
    // script that deletes as it goes keeps its live drawings.
    const limit = this.limitFor(kind);
    if (list.length > limit) {
      const keep = list.filter((x) => !x.deleted);
      const drop = list.length - limit;
      if (keep.length <= limit) {
        this.byKind.set(kind, keep.slice(Math.max(0, keep.length - limit)));
      } else {
        this.byKind.set(kind, list.slice(drop));
      }
    }
    return d;
  }

  private live(kind: DrawingKind): PineDrawing[] {
    return (this.byKind.get(kind) ?? []).filter((d) => !d.deleted);
  }

  /** Final state of every surviving drawing, resolved to chart coordinates. */
  emit(ctx: BarContext): DrawnOutput {
    const xOf = (d: PineDrawing, key: string): number => {
      const raw = numOf(d.props.get(key));
      const xloc = String(d.props.get("xloc") ?? "bar_index");
      // bar_time coordinates are already ms; bar_index needs a lookup.
      const ms = xloc.includes("time") ? raw : ctx.timeAt(raw);
      return Math.round(ms / 1000);
    };

    return {
      lines: this.live("line").map((d) => ({
        x1: xOf(d, "x1"), y1: numOf(d.props.get("y1")),
        x2: xOf(d, "x2"), y2: numOf(d.props.get("y2")),
        color: strOf(d.props.get("color"), "#2962ff"),
        width: numOf(d.props.get("width")) || 1,
        style: strOf(d.props.get("style"), "solid"),
        extend: strOf(d.props.get("extend"), "none"),
      })).filter((l) => Number.isFinite(l.y1) && Number.isFinite(l.y2)),

      boxes: this.live("box").map((d) => ({
        left: xOf(d, "left"), top: numOf(d.props.get("top")),
        right: xOf(d, "right"), bottom: numOf(d.props.get("bottom")),
        borderColor: strOf(d.props.get("border_color"), "#2962ff"),
        borderWidth: numOf(d.props.get("border_width")) || 1,
        borderStyle: strOf(d.props.get("border_style"), "solid"),
        bgColor: strOf(d.props.get("bgcolor"), ""),
        text: strOf(d.props.get("text"), ""),
        textColor: strOf(d.props.get("text_color"), "#d1d4dc"),
      })).filter((b) => Number.isFinite(b.top) && Number.isFinite(b.bottom)),

      labels: this.live("label").map((d) => ({
        x: xOf(d, "x"), y: numOf(d.props.get("y")),
        text: strOf(d.props.get("text"), ""),
        color: strOf(d.props.get("color"), "#2962ff"),
        textColor: strOf(d.props.get("textcolor"), "#d1d4dc"),
        style: strOf(d.props.get("style"), "label_down"),
        size: strOf(d.props.get("size"), "normal"),
      })).filter((l) => Number.isFinite(l.y)),

      tables: this.live("table").map((d) => ({
        position: strOf(d.props.get("position"), "top_right"),
        cells: [...d.cells.entries()].map(([key, c]) => {
          const [col, row] = key.split(":").map(Number);
          return {
            col: col ?? 0, row: row ?? 0,
            text: c.text, textColor: c.textColor, bgColor: c.bgColor,
          };
        }),
      })).filter((t) => t.cells.length > 0),
    };
  }
}

// A property the script never set reads as `undefined`; treat that exactly
// like na so unset coordinates drop the drawing rather than drawing at 0.
function numOf(v: PineValue | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return NaN;
}

function strOf(v: PineValue | undefined, dflt: string): string {
  return typeof v === "string" && v !== "" ? v : dflt;
}

/** Argument names for `X.new(...)`, in positional order. */
export const NEW_PARAMS: Record<string, string[]> = {
  line: ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width"],
  box: ["left", "top", "right", "bottom", "border_color", "border_width",
    "border_style", "extend", "xloc", "bgcolor", "text", "text_size",
    "text_color", "text_halign", "text_valign"],
  label: ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor",
    "size", "textalign", "tooltip"],
  table: ["position", "columns", "rows", "bgcolor", "frame_color",
    "frame_width", "border_color", "border_width"],
};

/** `set_x1` → `x1`; the setter name is the property name for most functions. */
const SETTER_ALIASES: Record<string, string> = {
  set_bgcolor: "bgcolor",
  set_border_color: "border_color",
  set_border_width: "border_width",
  set_border_style: "border_style",
  set_text_color: "text_color",
  set_textcolor: "textcolor",
  set_text_size: "text_size",
};

/**
 * Dispatch one drawing call. `self` is the receiver for method-form calls
 * (`myLine.set_x2(n)`); otherwise the first argument is the handle.
 */
export function callDrawing(
  registry: DrawingRegistry,
  ns: string,
  fn: string,
  args: PineValue[]
): PineValue {
  const kind = ns as DrawingKind;

  if (fn === "new") {
    const params = NEW_PARAMS[ns];
    if (!params) bad(`${ns}.new is not supported by this engine`);
    const props = new Map<string, PineValue>();
    args.forEach((v, i) => {
      const key = params[i];
      if (key) props.set(key, v);
    });
    return registry.create(kind, props);
  }

  if (fn === "all") {
    bad(`${ns}.all is not supported by this engine`);
  }

  const target = args[0];
  // Calling a setter on `na` is a silent no-op in Pine, not an error. `na`
  // reaches here either as a null handle or as NaN, depending on whether the
  // variable was ever assigned a real drawing, so both spellings count.
  if (target === null || target === undefined) return NaN;
  if (typeof target === "number" && Number.isNaN(target)) return NaN;
  if (!(target instanceof PineDrawing)) bad(`${ns}.${fn}: expected a ${ns}`);

  if (fn === "delete") { target.deleted = true; return NaN; }
  if (target.deleted) return NaN;

  // ── tables ──
  if (fn === "cell") {
    const [, col, row, text, , , textColor, , bgColor] = args;
    setCell(target, numOf(col ?? 0), numOf(row ?? 0), {
      text: text === null || text === undefined ? "" : String(text),
      textColor: strOf(textColor ?? "", "#d1d4dc"),
      bgColor: strOf(bgColor ?? "", ""),
      align: "center",
    });
    return NaN;
  }
  if (fn.startsWith("cell_set_")) {
    const key = `${numOf(args[1] ?? 0)}:${numOf(args[2] ?? 0)}`;
    const cell = target.cells.get(key) ??
      { text: "", textColor: "#d1d4dc", bgColor: "", align: "center" };
    const what = fn.slice("cell_set_".length);
    const v = args[3];
    if (what === "text") cell.text = v === null || v === undefined ? "" : String(v);
    else if (what === "text_color") cell.textColor = strOf(v ?? "", "#d1d4dc");
    else if (what === "bgcolor") cell.bgColor = strOf(v ?? "", "");
    else if (what === "text_halign") cell.align = strOf(v ?? "", "center");
    // Other cell_set_* (font size, tooltip…) are accepted and ignored.
    target.cells.set(key, cell);
    return NaN;
  }
  if (fn === "clear") { target.cells.clear(); return NaN; }

  // ── getters ──
  if (fn.startsWith("get_")) {
    return target.props.get(fn.slice(4)) ?? NaN;
  }

  // ── setters ──
  if (fn.startsWith("set_")) {
    const suffix = fn.slice(4);
    // Paired setters write two properties at once.
    if (suffix === "xy1" || suffix === "xy2") {
      target.props.set(`x${suffix.slice(-1)}`, args[1] ?? NaN);
      target.props.set(`y${suffix.slice(-1)}`, args[2] ?? NaN);
      return NaN;
    }
    if (suffix === "xy") {
      target.props.set("x", args[1] ?? NaN);
      target.props.set("y", args[2] ?? NaN);
      return NaN;
    }
    if (suffix === "lefttop" || suffix === "rightbottom") {
      const [a, b] = suffix === "lefttop" ? ["left", "top"] : ["right", "bottom"];
      target.props.set(a!, args[1] ?? NaN);
      target.props.set(b!, args[2] ?? NaN);
      return NaN;
    }
    const prop = SETTER_ALIASES[fn] ?? suffix;
    target.props.set(prop, args[1] ?? NaN);
    return NaN;
  }

  bad(`${ns}.${fn} is not supported by this engine`);
}

/** Positional parameter names for any drawing call, receiver included. */
export function paramNamesFor(ns: string, fn: string): string[] {
  if (fn === "new") return NEW_PARAMS[ns] ?? [];
  if (fn === "cell") {
    return ["table_id", "column", "row", "text", "width", "height",
      "text_color", "text_halign", "bgcolor"];
  }
  if (fn.startsWith("cell_set_")) return ["table_id", "column", "row", "value"];
  const self = ns === "table" ? "table_id" : `${ns}_id`;
  if (fn === "set_xy1" || fn === "set_xy2") return [self, "x", "y"];
  if (fn === "set_xy") return [self, "x", "y"];
  if (fn === "set_lefttop") return [self, "left", "top"];
  if (fn === "set_rightbottom") return [self, "right", "bottom"];
  if (fn.startsWith("set_")) return [self, "value"];
  return [self];
}

function setCell(t: PineDrawing, col: number, row: number, cell: TableCell): void {
  t.cells.set(`${col}:${row}`, cell);
}
