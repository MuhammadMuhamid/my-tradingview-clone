/**
 * Pine Script v5 interpreter — bar-by-bar execution over a single feed.
 *
 * Execution model mirrors Pine: the whole script body runs once per bar, in
 * source order. Every expression node owns a ring buffer of its past values,
 * which is what makes `x[1]`, `var` and self-referencing series work the same
 * way they do on TradingView.
 *
 * TA functions are not reimplemented here. Window functions slice a node's
 * history and call the Pine-verified array code in `engine/ta.ts`; recursive
 * ones use the small state machines in `./streamTa.ts`, which are asserted
 * equal to the array versions by `tests/pineStreamTa.test.ts`.
 *
 * Arrays, matrices, user-defined types and methods are reference values —
 * see ./values.ts for why they are boxed handles rather than plain values,
 * and ./collections.ts for the `array.*` / `matrix.*` surface.
 *
 * Deliberately unsupported semantics (maps, libraries, lookahead-on and
 * unknown builtins) raise line-numbered errors. Unsupported visual-only
 * primitives execute their arguments and emit explicit compatibility warnings
 * so a chart never invents a plausible but semantically wrong substitute.
 */
import * as ta from "../engine/ta";
import { Broker } from "../engine/broker";
import { pineTfToInterval, type Bars } from "../engine/mtf";
import { INTERVAL_MS, type Interval } from "../types/market";
import type { EquityPoint } from "../types/backtest";
import { parse, type Expr, type Stmt, type TypeField } from "./parser";
import { PineSyntaxError } from "./lexer";
import { Atr, BarsSince, Cum, Ema, RecursiveMa, Rsi, TrueRange, ValueWhen, rmaState } from "./streamTa";
import { callArray, callMatrix } from "./collections";
import { DrawingRegistry, callDrawing, paramNamesFor as drawingParamNames, type DrawnOutput } from "./drawings";
import { PineArray, PineDrawing, PineMatrix, PineObject, isRef, type PineValue as Value } from "./values";

export type PineValue = Value;
export { PineArray, PineMatrix, PineObject } from "./values";

export interface PineError { line: number; col: number; message: string }

export interface PineCompatibilityWarning { line: number; message: string }

export interface PineInputDef {
  /** variable the input was assigned to (used as the params key) */
  key: string;
  title: string;
  type: "int" | "float" | "bool" | "string" | "source" | "color" | "timeframe";
  defval: number | string | boolean;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: (string | number)[];
  group?: string;
  tooltip?: string;
}

export interface PinePlot {
  id: string;
  title: string;
  color: string;
  width: number;
  style: "line" | "histogram" | "columns" | "circles" | "cross" | "stepline" | "area";
  /** Pine display offset, in chart bars. */
  offset: number;
  /** A non-overlay script may explicitly force one plot onto the price pane. */
  forceOverlay: boolean;
  /** False suppresses chart output for a hidden or unsupported visual style. */
  renderable: boolean;
  /** Per-bar colours; null hides that point without inventing another colour. */
  colors: (string | null)[];
  /** null = na (line breaks) */
  data: (number | null)[];
}

export interface PineHline {
  id: string;
  price: number;
  color: string;
  title: string;
  width: number;
  style: "solid" | "dashed" | "dotted";
  renderable: boolean;
}

export interface PineFill {
  id: string;
  title: string;
  firstId: string;
  secondId: string;
  /** True when both endpoints belong to the price pane. */
  forceOverlay: boolean;
  renderable: boolean;
  fillgaps: boolean;
  /** Per-bar colours; null means no fill on that bar. */
  colors: (string | null)[];
}

export interface PineBackground {
  id: string;
  title: string;
  offset: number;
  forceOverlay: boolean;
  /** Per-bar colours; null leaves the pane background unchanged. */
  colors: (string | null)[];
}

export interface PineBarColor {
  id: string;
  title: string;
  offset: number;
  /** Per-bar presentation overrides; canonical OHLC is never changed. */
  colors: (string | null)[];
}

export interface PineOhlcPoint {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PineOhlcPlot {
  id: string;
  title: string;
  style: "candles" | "bars";
  color: string;
  forceOverlay: boolean;
  renderable: boolean;
  data: (PineOhlcPoint | null)[];
  colors: (string | null)[];
  wickColors: (string | null)[];
  borderColors: (string | null)[];
}

export interface PineShapeMark {
  time: number;
  position: "above" | "below";
  color: string;
  text: string;
  shape: string;
}

export interface PineMeta {
  kind: "indicator" | "strategy";
  title: string;
  shortTitle: string;
  overlay: boolean;
  format: string;
  precision: number | null;
  inputs: PineInputDef[];
  /** Explicitly surfaced constructs that executed but cannot yet be rendered. */
  warnings: PineCompatibilityWarning[];
  /**
   * Timeframes the script asks for through `request.security`, other than the
   * chart's own. Collected during the declaration pass so the caller knows
   * which extra feeds to load BEFORE the run — the interpreter itself is
   * deterministic and never fetches data.
   */
  securityTimeframes: string[];
}

/**
 * Execution limits. A Pine script is untrusted input. API runs are additionally
 * isolated in runInWorker, while these cooperative limits also protect direct
 * test/research callers. Every limit aborts with a normal PineRuntimeError.
 */
const LIMITS = {
  /** wall-clock budget for one run, ms */
  timeMs: Number(process.env.PINE_TIME_BUDGET_MS ?? 10_000),
  /** ceiling a caller may raise the budget to (interactive chart requests) */
  maxTimeMs: Number(process.env.PINE_MAX_TIME_BUDGET_MS ?? 60_000),
  /** total loop iterations across the whole run, all bars and all loops */
  loopIterations: 20_000_000,
  /** largest `length` argument any ta.* call may use */
  taLength: 100_000,
  /** distinct plot() call sites */
  plots: 64,
  /** largest history offset for `x[n]` */
  historyOffset: 100_000,
};

/** Namespaces handled by ./drawings.ts. */
const DRAWING_NS = /^(line|box|label|table)\./;

const DEFAULT_COLORS = [
  "#2962ff", "#2ebd85", "#f6465d", "#f0b90b", "#a855f7", "#22d3ee", "#fb923c",
];

const NAMED_COLORS: Record<string, string> = {
  red: "#f23645", green: "#089981", blue: "#2962ff", orange: "#ff9800",
  yellow: "#ffeb3b", purple: "#9c27b0", teal: "#00897b", white: "#ffffff",
  black: "#000000", gray: "#787b86", silver: "#b2b5be", maroon: "#880e4f",
  lime: "#00e676", olive: "#808000", navy: "#000080", aqua: "#00bcd4",
  fuchsia: "#e040fb",
};

/** Circular history buffer for one expression node or variable. */
class Series {
  private buf: PineValue[] = [];
  private cap = 2;
  private head = 0;     // next write slot
  private count = 0;

  ensure(cap: number): void {
    if (cap <= this.cap) return;
    // Re-linearise oldest→newest before growing so ordering survives.
    // `count` is the total number of bars seen and must NOT be reset here —
    // callers use it to decide whether enough history exists yet.
    const linear = this.toArray();
    this.cap = cap;
    this.buf = linear;
    this.head = linear.length % this.cap;
  }

  push(v: PineValue): void {
    if (this.buf.length < this.cap) {
      this.buf.push(v);
      this.head = this.buf.length % this.cap;
    } else {
      this.buf[this.head] = v;
      this.head = (this.head + 1) % this.cap;
    }
    this.count++;
  }

  /**
   * Value `offset` bars back; na when it predates the buffer.
   *
   * The wrap MUST be taken modulo the buffer's current length, not its
   * capacity: after `ensure()` grows `cap`, the buffer is still short, and
   * padding by `cap` would rotate the index by `cap % length` and return the
   * wrong bar. Normalising a possibly-negative remainder avoids that entirely.
   */
  get(offset: number): PineValue {
    const len = this.buf.length;
    if (offset < 0 || len === 0) return NaN;
    const stored = Math.min(this.count, len);
    if (offset >= stored) return NaN;
    const idx = (((this.head - 1 - offset) % len) + len) % len;
    const v = this.buf[idx];
    return v === undefined ? NaN : v;
  }

  /** Overwrite the current bar's value (used by `:=`). */
  set(v: PineValue): void {
    if (this.count === 0) { this.push(v); return; }
    const idx = (this.head - 1 + this.buf.length) % this.buf.length;
    this.buf[idx] = v;
  }

  private toArray(): PineValue[] {
    const n = Math.min(this.count, this.buf.length);
    const out: PineValue[] = [];
    for (let k = n - 1; k >= 0; k--) out.push(this.get(k));
    return out;
  }

  /** Last `len` values oldest→newest, NaN-padded when history is short. */
  window(len: number): number[] {
    this.ensure(len);
    const out = new Array<number>(len);
    for (let k = 0; k < len; k++) {
      const v = this.get(len - 1 - k);
      out[k] = typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : NaN;
    }
    return out;
  }

  get length(): number { return this.count; }
}

interface VarSlot { series: Series; declaredBar: number }

class BreakSignal extends Error {}
class ContinueSignal extends Error {}

export class PineRuntimeError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = "PineRuntimeError";
    this.line = line;
  }
}

export interface RunOptions {
  bars: Bars;
  /** inclusive bar index range to execute (warmup bars before startIdx still run) */
  startIdx: number;
  endIdx: number;
  /** user overrides for input.* defaults, keyed by PineInputDef.key */
  params?: Record<string, number | string | boolean>;
  /** strategy execution; omit for indicator-only evaluation */
  broker?: Broker;
  /**
   * Wall-clock budget for this run, ms. Defaults to LIMITS.timeMs, which is
   * sized for the live alert runner — an interactive chart request can afford
   * more, because a user is waiting on it and nothing else is blocked behind
   * it. Never unbounded: a runaway script must still terminate.
   */
  timeBudgetMs?: number;
  /**
   * Higher-timeframe feeds for `request.security`, keyed exactly as the script
   * spells the timeframe. Load the ones `meta.securityTimeframes` names; a
   * request for a timeframe that is absent still errors, by name.
   */
  htf?: Record<string, Bars>;
}

export interface RunOutput {
  meta: PineMeta;
  plots: PinePlot[];
  hlines: PineHline[];
  fills: PineFill[];
  backgrounds: PineBackground[];
  barColors: PineBarColor[];
  ohlcPlots: PineOhlcPlot[];
  shapes: PineShapeMark[];
  /** final state of every surviving line/box/label/table */
  drawings: DrawnOutput;
  /** bar times (seconds) aligned with plot data */
  times: number[];
  /** close-marked equity, only when a broker was supplied */
  equityCurve: EquityPoint[];
}

export class PineInterpreter {
  private program: Stmt[];
  private nodeSeries = new Map<string, Series>();
  private scopes: Map<string, VarSlot>[] = [new Map()];
  private funcs = new Map<string, Extract<Stmt, { k: "func" }>>();
  /** user `type` declarations, by name */
  private types = new Map<string, TypeField[]>();
  /** `method` declarations, by method name */
  private methods = new Map<string, Extract<Stmt, { k: "func" }>>();
  private callState = new Map<string, unknown>();
  private nextNodeId = 0;
  private nodeIds = new WeakMap<object, number>();

  /**
   * Pine gives every *call site* of a user function its own copy of the
   * function's internal series state — `smooth(close, 10)` and
   * `smooth(close, 30)` must not share one `ta.ema` accumulator. These track
   * the active call-site chain so node history, TA state and local variables
   * are all keyed per frame.
   */
  private frameStack: number[] = [];
  private frameScopes = new Map<string, Map<string, VarSlot>>();
  /** index in `scopes` where the innermost function frame begins */
  private frameFloor = 0;

  private bars!: Bars;
  private i = 0;
  /** The source, kept so a higher-timeframe pass can re-instantiate the program. */
  private source: string;
  /** Higher-timeframe feeds supplied by the caller, keyed by timeframe string. */
  private htf: Record<string, Bars> = {};
  /**
   * `request.security` results for a higher timeframe, keyed by its stable AST
   * call id, active user-function call chain and resolved timeframe, then
   * indexed by HTF bar. Filled by a capture pass before the main loop; read
   * during it.
   */
  private htfValues = new Map<string, PineValue[]>();
  /**
   * Set while this instance is the capture pass for one timeframe. Security
   * calls for any OTHER timeframe answer NaN rather than erroring, because a
   * script may legitimately ask for two.
   */
  private captureTf: string | null = null;
  private captureInto: Map<string, PineValue[]> | null = null;
  /** Declaration pass: record requested timeframes instead of refusing. */
  private declaring = false;
  /** Timeframes seen during declaration. */
  private needTf = new Set<string>();
  private broker: Broker | undefined;
  private inRange = false;

  private meta: PineMeta = {
    kind: "indicator", title: "Untitled", shortTitle: "", overlay: false, inputs: [],
    format: "inherit", precision: null, warnings: [], securityTimeframes: [],
  };
  private inputsSeen = new Set<string>();
  private params: Record<string, number | string | boolean> = {};
  private plots = new Map<string, PinePlot>();
  private plotOrder: string[] = [];
  private hlines: PineHline[] = [];
  private fills = new Map<string, PineFill>();
  private fillOrder: string[] = [];
  private backgrounds = new Map<string, PineBackground>();
  private backgroundOrder: string[] = [];
  private barColors = new Map<string, PineBarColor>();
  private barColorOrder: string[] = [];
  private ohlcPlots = new Map<string, PineOhlcPlot>();
  private ohlcPlotOrder: string[] = [];
  private warningsSeen = new Set<string>();
  private drawings = new DrawingRegistry();
  private shapes: PineShapeMark[] = [];
  private times: number[] = [];
  /** name of the variable currently being declared — names anonymous inputs/plots */
  private declName: string | null = null;

  /** resource budgets (see LIMITS) */
  private deadline = Infinity;
  /** the budget actually in force, for the timeout message */
  private budgetMs = LIMITS.timeMs;
  private loopBudget = LIMITS.loopIterations;

  /** Abort the run if it has outstayed its wall-clock budget. */
  private checkDeadline(line: number): void {
    if (Date.now() > this.deadline) {
      throw new PineRuntimeError(
        `script exceeded its ${(this.budgetMs / 1000).toFixed(0)}s execution budget — ` +
        "check for an unbounded loop or a very large length", line
      );
    }
  }

  private spendLoop(n: number, line: number): void {
    this.loopBudget -= n;
    if (this.loopBudget < 0) {
      throw new PineRuntimeError(
        `script exceeded ${LIMITS.loopIterations.toLocaleString()} total loop iterations`, line
      );
    }
  }

  private compatibilityWarning(line: number, message: string): void {
    const key = `${line}:${message}`;
    if (this.warningsSeen.has(key)) return;
    this.warningsSeen.add(key);
    this.meta.warnings.push({ line, message });
  }

  constructor(source: string) {
    this.source = source;
    this.program = parse(source);
    for (const st of this.program) {
      if (st.k === "func") {
        if (st.isMethod) this.methods.set(st.name, st);
        else this.funcs.set(st.name, st);
      }
      if (st.k === "typedef") this.types.set(st.name, st.fields);
    }
  }

  /** Parse-and-declare only: metadata + input list, without touching data. */
  static compile(
    source: string,
    params?: Record<string, number | string | boolean>
  ): { meta: PineMeta; errors: PineError[] } {
    try {
      const interp = new PineInterpreter(source);
      // The user's input overrides matter here, not just at run time: a script
      // that picks its `request.security` timeframe from an input reports a
      // different feed once that input is changed, and the caller loads feeds
      // from this result.
      interp.params = params ?? {};
      const meta = interp.collectMeta();
      return { meta, errors: [] };
    } catch (err) {
      if (err instanceof PineSyntaxError) {
        return {
          meta: {
            kind: "indicator", title: "", shortTitle: "", overlay: false,
            format: "inherit", precision: null, inputs: [], warnings: [], securityTimeframes: [],
          },
          errors: [{ line: err.line, col: err.col, message: err.message }],
        };
      }
      if (err instanceof PineRuntimeError) {
        return {
          meta: {
            kind: "indicator", title: "", shortTitle: "", overlay: false,
            format: "inherit", precision: null, inputs: [], warnings: [], securityTimeframes: [],
          },
          errors: [{ line: err.line, col: 1, message: err.message }],
        };
      }
      // Stack exhaustion from a pathological script is a script error, not a
      // server fault — every caller of compile() is an HTTP handler.
      if (err instanceof RangeError) {
        return {
          meta: {
            kind: "indicator", title: "", shortTitle: "", overlay: false,
            format: "inherit", precision: null, inputs: [], warnings: [], securityTimeframes: [],
          },
          errors: [{ line: 1, col: 1, message: "script is too complex to compile (call stack exhausted)" }],
        };
      }
      throw err;
    }
  }

  /**
   * Metadata pass: runs the script over a single synthetic bar so that
   * `indicator()`/`strategy()` and every `input.*` call is observed. Data
   * builtins read as na, which never affects a declaration.
   */
  private collectMeta(): PineMeta {
    this.bars = {
      symbol: "", interval: "1m", time: [0], open: [NaN], high: [NaN],
      low: [NaN], close: [NaN], volume: [NaN], closeTime: [0], length: 1,
    };
    this.i = 0;
    this.inRange = false;
    this.declaring = true;
    // The editor compiles on every keystroke, so the declaration pass gets a
    // much tighter budget than a full run.
    this.deadline = Date.now() + Math.min(2_000, LIMITS.timeMs);
    this.loopBudget = 1_000_000;
    this.execBar();
    this.declaring = false;
    this.meta.securityTimeframes = [...this.needTf];
    return this.meta;
  }

  run(opts: RunOptions): RunOutput {
    this.bars = opts.bars;
    this.broker = opts.broker;
    this.params = opts.params ?? {};
    this.htf = opts.htf ?? {};
    const { startIdx, endIdx } = opts;

    const equityCurve: EquityPoint[] = [];
    let peak = this.broker?.opts.initialCapital ?? 0;
    const budget = Math.min(
      Math.max(opts.timeBudgetMs ?? LIMITS.timeMs, 1_000),
      LIMITS.maxTimeMs
    );
    this.deadline = Date.now() + budget;
    this.budgetMs = budget;
    this.loopBudget = LIMITS.loopIterations;

    // Higher-timeframe values must exist before the first chart bar reads one.
    if (Object.keys(this.htf).length > 0) this.captureHtf();

    for (let i = 0; i <= endIdx && i < this.bars.length; i++) {
      // Cheap enough to check every bar; loops check it internally too.
      this.checkDeadline(0);
      this.i = i;
      this.inRange = i >= startIdx;
      if (this.inRange) {
        this.times.push(this.bars.time[i]! / 1000);
        this.broker?.processOpen(this.bars, i);
        this.broker?.processIntrabar(this.bars, i, { tp: {}, sl: "SL" });
      }
      this.execBar();
      if (this.inRange && this.broker) {
        this.broker.processClose(this.bars, i);
        // Same convention as the built-in strategies: close-marked equity,
        // drawdown measured against the running peak using the bar's low.
        const equity = this.broker.equityAt(this.bars.close[i]!);
        const lowEquity = this.broker.equityAt(this.bars.low[i]!);
        if (equity > peak) peak = equity;
        equityCurve.push({
          t: this.bars.time[i]!,
          equity,
          drawdownPct: peak > 0 ? ((peak - Math.min(equity, lowEquity)) / peak) * 100 : 0,
        });
      }
    }

    // Cumulative profit per closed leg (the trade-list column).
    if (this.broker) {
      let cum = 0;
      for (const trade of this.broker.closed) {
        cum += trade.pnl ?? 0;
        trade.cumProfit = cum;
      }
    }

    return {
      meta: this.meta,
      plots: this.plotOrder.map((id) => this.plots.get(id)!),
      hlines: this.hlines,
      fills: this.fillOrder.map((id) => this.fills.get(id)!),
      backgrounds: this.backgroundOrder.map((id) => this.backgrounds.get(id)!),
      barColors: this.barColorOrder.map((id) => this.barColors.get(id)!),
      ohlcPlots: this.ohlcPlotOrder.map((id) => this.ohlcPlots.get(id)!),
      shapes: this.shapes,
      drawings: this.drawings.emit({ timeAt: (b) => this.timeAtBar(b) }),
      times: this.times,
      equityCurve,
    };
  }

  /**
   * Bar open time in ms for a bar index. Scripts routinely project drawings
   * into the future (`bar_index + 20`), so indices past the last bar are
   * extrapolated at the feed's own spacing rather than clamped — clamping
   * would pile every projection onto the final candle.
   */
  private timeAtBar(barIndex: number): number {
    const b = this.bars;
    const i = Math.round(barIndex);
    if (!Number.isFinite(i) || b.length === 0) return NaN;
    if (i >= 0 && i < b.length) return b.time[i]!;
    const step = b.length > 1 ? b.time[1]! - b.time[0]! : 60_000;
    return i < 0 ? b.time[0]! + i * step : b.time[b.length - 1]! + (i - (b.length - 1)) * step;
  }

  // ── execution ────────────────────────────────────────────────────────────
  private execBar(): void {
    this.scopes = [this.scopes[0] ?? new Map()];
    this.frameStack = [];
    this.frameFloor = 0;
    for (const st of this.program) this.execStmt(st);
  }

  private execStmt(st: Stmt): PineValue {
    switch (st.k) {
      case "func": case "typedef":
        return NaN; // hoisted in the constructor
      case "massign": {
        const target = st.target as Extract<Expr, { k: "member" }>;
        const owner = this.evalExpr(target.obj);
        if (!(owner instanceof PineObject)) {
          throw new PineRuntimeError(
            owner === null
              ? `cannot set '${target.name}' on an na object`
              : `'${target.name}' is not a field of a user-defined type`,
            st.line
          );
        }
        if (!owner.fields.has(target.name)) {
          throw new PineRuntimeError(
            `type '${owner.type}' has no field '${target.name}'`, st.line
          );
        }
        const rhs = this.evalExpr(st.value);
        let next = rhs;
        if (st.op !== ":=") {
          const cur = this.num(owner.fields.get(target.name)!, st.line);
          const r = this.num(rhs, st.line);
          next = st.op === "+=" ? cur + r : st.op === "-=" ? cur - r
            : st.op === "*=" ? cur * r : st.op === "/=" ? cur / r : cur % r;
        }
        owner.fields.set(target.name, next);
        return next;
      }
      case "decl": {
        // `var` / `varip` initialise exactly once. The initialiser must not be
        // re-evaluated on later bars: for a pure expression that would only
        // waste work, but for one with an effect — `var t = table.new(…)` —
        // re-running it creates a fresh object every bar and the variable ends
        // up pointing at an orphan.
        if (st.mode !== "none" && st.names.every((n) => this.lookupForDeclare(n))) {
          for (const n of st.names) this.declare(n, NaN, st.mode, st.line);
          const first = this.lookupForDeclare(st.names[0]!);
          return first ? first.series.get(0) : NaN;
        }
        const prev = this.declName;
        this.declName = st.names[0] ?? null;
        let value: PineValue;
        try {
          value = this.evalExpr(st.value);
        } finally {
          this.declName = prev;
        }
        if (st.names.length > 1) {
          const items = Array.isArray(value) ? value : [value];
          st.names.forEach((n, k) => this.declare(n, items[k] ?? NaN, st.mode, st.line));
        } else {
          this.declare(st.names[0]!, value, st.mode, st.line);
        }
        return value;
      }
      case "assign": {
        const slot = this.lookup(st.name);
        if (!slot) throw new PineRuntimeError(`undeclared variable '${st.name}'`, st.line);
        const rhs = this.evalExpr(st.value);
        let next = rhs;
        if (st.op !== ":=") {
          const cur = this.num(slot.series.get(0), st.line);
          const r = this.num(rhs, st.line);
          next = st.op === "+=" ? cur + r : st.op === "-=" ? cur - r
            : st.op === "*=" ? cur * r : st.op === "/=" ? cur / r : cur % r;
        }
        slot.series.set(next);
        return next;
      }
      case "if": {
        const cond = this.truthy(this.evalExpr(st.cond));
        const block = cond ? st.then : st.else;
        if (!block) return NaN;
        return this.execBlock(block);
      }
      case "for": {
        const from = this.num(this.evalExpr(st.from), st.line);
        const to = this.num(this.evalExpr(st.to), st.line);
        const step = st.step ? this.num(this.evalExpr(st.step), st.line) : (from <= to ? 1 : -1);
        if (step === 0) throw new PineRuntimeError("for-loop step cannot be 0", st.line);
        let guard = 0;
        for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
          if (++guard > 100_000) throw new PineRuntimeError("for-loop exceeded 100000 iterations", st.line);
          this.spendLoop(1, st.line);
          if ((guard & 1023) === 0) this.checkDeadline(st.line);
          this.declare(st.name, v, "none", st.line);
          try {
            this.execBlock(st.body);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (!(e instanceof ContinueSignal)) throw e;
          }
        }
        return NaN;
      }
      case "forin": {
        const coll = this.evalExpr(st.iter);
        // Iterating na is a no-op, matching Pine, rather than an error.
        if (coll === null) return NaN;
        const items = coll instanceof PineArray ? coll.items
          : coll instanceof PineMatrix ? coll.rows.map((r) => new PineArray(coll.type, r))
            : null;
        if (items === null) {
          throw new PineRuntimeError("for-in expects an array or matrix", st.line);
        }
        // Pine iterates a snapshot, so mutating the array inside the body
        // cannot make the loop run forever.
        const snapshot = items.slice();
        this.spendLoop(snapshot.length, st.line);
        for (let k = 0; k < snapshot.length; k++) {
          if ((k & 1023) === 0) this.checkDeadline(st.line);
          if (st.names.length > 1) {
            this.declare(st.names[0]!, k, "none", st.line);
            this.declare(st.names[1]!, snapshot[k]!, "none", st.line);
          } else {
            this.declare(st.names[0]!, snapshot[k]!, "none", st.line);
          }
          try {
            this.execBlock(st.body);
          } catch (err) {
            if (err instanceof BreakSignal) break;
            if (!(err instanceof ContinueSignal)) throw err;
          }
        }
        return NaN;
      }
      case "while": {
        let guard = 0;
        while (this.truthy(this.evalExpr(st.cond))) {
          if (++guard > 100_000) throw new PineRuntimeError("while-loop exceeded 100000 iterations", st.line);
          this.spendLoop(1, st.line);
          if ((guard & 1023) === 0) this.checkDeadline(st.line);
          try {
            this.execBlock(st.body);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (!(e instanceof ContinueSignal)) throw e;
          }
        }
        return NaN;
      }
      case "break": throw new BreakSignal();
      case "continue": throw new ContinueSignal();
      case "expr": return this.evalExpr(st.value);
    }
  }

  /**
   * A block's value is its last statement's value (Pine's block-expression
   * rule). Blocks deliberately share the enclosing scope rather than getting a
   * throwaway one: a variable declared inside an `if` must keep its series
   * across bars, or `var` and `x[1]` would reset every bar.
   */
  private execBlock(block: Stmt[]): PineValue {
    let last: PineValue = NaN;
    for (const st of block) last = this.execStmt(st);
    return last;
  }

  // ── variables ────────────────────────────────────────────────────────────
  private lookup(name: string): VarSlot | undefined {
    for (let k = this.scopes.length - 1; k >= 0; k--) {
      const slot = this.scopes[k]!.get(name);
      if (slot) return slot;
    }
    return undefined;
  }

  /**
   * Declaration lookup stops at the innermost function frame: a local may
   * shadow a global of the same name, but reads (via `lookup`) still see the
   * whole chain, matching Pine's scoping.
   */
  private lookupForDeclare(name: string): VarSlot | undefined {
    for (let k = this.scopes.length - 1; k >= this.frameFloor; k--) {
      const slot = this.scopes[k]!.get(name);
      if (slot) return slot;
    }
    return undefined;
  }

  private declare(name: string, value: PineValue, mode: "var" | "varip" | "none", line: number): void {
    void line;
    const scope = this.scopes[this.scopes.length - 1]!;
    // `var` initialises once and then persists; plain declarations re-evaluate
    // every bar but still keep history for `x[1]`.
    const existing = this.lookupForDeclare(name);
    if (existing) {
      if (mode === "var" || mode === "varip") {
        // Value carries over: push the previous bar's value forward.
        if (existing.declaredBar !== this.i) {
          existing.series.push(existing.series.get(0));
          existing.declaredBar = this.i;
        }
        return;
      }
      if (existing.declaredBar !== this.i) {
        existing.series.push(value);
        existing.declaredBar = this.i;
      } else {
        existing.series.set(value);
      }
      return;
    }
    const slot: VarSlot = { series: new Series(), declaredBar: this.i };
    slot.series.push(value);
    scope.set(name, slot);
  }

  // ── higher-timeframe feeds ───────────────────────────────────────────────

  /**
   * Identity of a `request.security` series, shared between the capture pass
   * and the main run.
   *
   * Both passes parse the exact same source, so the parser's monotonically
   * assigned call id is deterministic across them. The function call chain is
   * deterministic for the same reason and separates one wrapper invocation
   * from another. Including the resolved timeframe also handles a wrapper
   * whose single security node is invoked with different timeframe values.
   */
  private securityKey(e: Extract<Expr, { k: "call" }>, timeframe: string): string {
    return `sec@${this.frameKey()}${e.id}@${timeframe}`;
  }

  /**
   * The HTF value in force at the current chart bar.
   *
   * Lookahead is OFF: only a higher-timeframe bar that has actually CLOSED at
   * or before this chart bar's open is visible. Reading the forming HTF bar
   * would leak the rest of the hour into a 15m decision, which is the classic
   * multi-timeframe backtest lie — and this engine also drives live alerts,
   * where that value simply does not exist yet.
   *
   * ── Deliberate deviation from TradingView ──
   * TradingView returns the DEVELOPING higher-timeframe bar, which is why
   * ported scripts say `close[1]` to reach the last completed one. Here the
   * developing bar is never returned, so `request.security(s, "D", close)`
   * already IS the previous completed day and a `[1]` steps back one period
   * too far. The developing value cannot be reconstructed for an arbitrary
   * expression — `ta.sma(close, 20)` part-way through a day is not derivable
   * from completed daily bars — so the engine offers the definition it can
   * compute honestly rather than one it would have to approximate.
   */
  private alignHtf(series: PineValue[], bars: Bars): PineValue {
    const now = this.bars.time[this.i];
    if (now === undefined) return NaN;
    let lo = 0, hi = bars.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      // closeTime is the last millisecond of the bar, so <= now means closed.
      if (bars.closeTime[mid]! <= now) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found < 0) return NaN;
    const v = series[found];
    return v === undefined ? NaN : v;
  }

  /**
   * Run the program once per requested timeframe over that timeframe's bars,
   * recording what each `request.security` expression evaluated to on each of
   * its bars.
   *
   * A fresh interpreter is used rather than re-entering this one: every `ta.*`
   * accumulator and node history in this instance belongs to the chart series,
   * and stepping them through a second, coarser series would corrupt the run
   * the user actually asked for.
   */
  private captureHtf(): void {
    for (const [tf, bars] of Object.entries(this.htf)) {
      if (!bars || bars.length === 0) continue;
      const sub = new PineInterpreter(this.source);
      sub.bars = bars;
      sub.params = this.params;
      sub.captureTf = tf;
      sub.captureInto = new Map();
      // The capture pass shares this run's budget: it is part of the same
      // request, and must not be able to double the time it takes.
      sub.deadline = this.deadline;
      sub.budgetMs = this.budgetMs;
      sub.loopBudget = this.loopBudget;
      sub.meta = { ...this.meta, inputs: [] };
      for (let j = 0; j < bars.length; j++) {
        sub.checkDeadline(0);
        sub.i = j;
        sub.inRange = false;   // no plots, shapes or equity from this pass
        sub.execBar();
      }
      for (const [key, values] of sub.captureInto) this.htfValues.set(key, values);
      // Loop budget is a shared pool, so hand back what the pass did not use.
      this.loopBudget = sub.loopBudget;
    }
  }

  // ── node history ─────────────────────────────────────────────────────────
  private idOf(node: object): number {
    let id = this.nodeIds.get(node);
    if (id === undefined) {
      id = this.nextNodeId++;
      this.nodeIds.set(node, id);
    }
    return id;
  }

  /** Identity of the current user-function call-site chain (empty at top level). */
  private frameKey(): string {
    return this.frameStack.length === 0 ? "" : `${this.frameStack.join(">")}>`;
  }

  private seriesOf(node: object): Series {
    const key = `${this.frameKey()}${this.idOf(node)}`;
    let s = this.nodeSeries.get(key);
    if (!s) {
      s = new Series();
      this.nodeSeries.set(key, s);
    }
    return s;
  }

  // ── expressions ──────────────────────────────────────────────────────────
  private evalExpr(e: Expr): PineValue {
    switch (e.k) {
      case "num": return e.v;
      case "str": return e.v;
      case "color": return e.v;
      case "bool": return e.v;
      case "na": return NaN;
      case "tuple": return e.items.map((x) => this.evalExpr(x));
      case "ident": return this.evalIdent(e.name, e.line);
      case "member": return this.evalMember(e);
      case "un": {
        const v = this.evalExpr(e.arg);
        if (e.op === "not") return !this.truthy(v);
        const n = this.num(v, e.line);
        return e.op === "-" ? -n : n;
      }
      case "bin": return this.evalBinary(e);
      case "cond":
        return this.truthy(this.evalExpr(e.c)) ? this.evalExpr(e.t) : this.evalExpr(e.f);
      case "ifexpr": {
        const cond = this.truthy(this.evalExpr(e.cond));
        const block = cond ? e.then : e.else;
        return block ? this.execBlock(block) : NaN;
      }
      case "hist": {
        const offset = Math.trunc(this.num(this.evalExpr(e.offset), e.line));
        // A call owns its history buffer, but reading `call(...)[n]` used to
        // consult that buffer without ever evaluating the call on this bar.
        // It therefore stayed empty forever and the expression was always na.
        // Evaluate exactly once before looking back; evalCall records it.
        if (e.base.k === "call") this.evalExpr(e.base);
        return this.historyOf(e.base, offset, e.line);
      }
      case "switch": {
        // With a subject, arms match it by equality; without one, each arm is
        // a condition. A `match: null` arm is the default and always fires.
        const subject = e.subject ? this.evalExpr(e.subject) : null;
        for (const arm of e.cases) {
          if (arm.match === null) return this.execBlock(arm.body);
          const m = this.evalExpr(arm.match);
          const hit = e.subject ? looseEq(subject, m) : this.truthy(m);
          if (hit) return this.execBlock(arm.body);
        }
        return NaN;
      }
      case "call": return this.evalCall(e);
    }
  }

  /**
   * `expr[n]` — variables read straight from their own series; any other
   * expression reads from the per-node ring buffer recorded on past bars.
   */
  private historyOf(base: Expr, offset: number, line: number): PineValue {
    if (offset < 0) throw new PineRuntimeError("history offset cannot be negative", line);
    if (!(offset <= LIMITS.historyOffset)) {
      throw new PineRuntimeError(
        `history offset must be at most ${LIMITS.historyOffset.toLocaleString()}`, line
      );
    }
    if (base.k === "ident") {
      const slot = this.lookup(base.name);
      if (slot) {
        slot.series.ensure(offset + 1);
        return slot.series.get(offset);
      }
      // built-in series: read the bar directly
      return this.builtinSeries(base.name, this.i - offset, line);
    }
    const s = this.seriesOf(base);
    s.ensure(offset + 1);
    return s.get(offset);
  }

  /** Record a node's value for later `[n]` access, and return it. */
  private record(node: object, v: PineValue): PineValue {
    this.seriesOf(node).push(v);
    return v;
  }

  private evalIdent(name: string, line: number): PineValue {
    const slot = this.lookup(name);
    if (slot) return slot.series.get(0);
    const b = this.builtinSeries(name, this.i, line);
    if (b !== undefined) return b;
    throw new PineRuntimeError(`unknown identifier '${name}'`, line);
  }

  private builtinSeries(name: string, idx: number, line: number): PineValue {
    void line;
    const b = this.bars;
    const at = (arr: number[]): number => (idx >= 0 && idx < b.length ? arr[idx]! : NaN);
    switch (name) {
      case "open": return at(b.open);
      case "high": return at(b.high);
      case "low": return at(b.low);
      case "close": return at(b.close);
      case "volume": return at(b.volume);
      case "hl2": return (at(b.high) + at(b.low)) / 2;
      case "hlc3": return (at(b.high) + at(b.low) + at(b.close)) / 3;
      case "ohlc4": return (at(b.open) + at(b.high) + at(b.low) + at(b.close)) / 4;
      case "hlcc4": return (at(b.high) + at(b.low) + at(b.close) * 2) / 4;
      case "time": return idx >= 0 && idx < b.length ? b.time[idx]! : NaN;
      case "time_close": return idx >= 0 && idx < b.length ? b.closeTime[idx]! : NaN;
      case "bar_index": return idx;
      case "last_bar_index": return b.length - 1;
      case "barstate": return NaN;
      default: return undefined as unknown as PineValue;
    }
  }

  private evalMember(e: Extract<Expr, { k: "member" }>): PineValue {
    // A field read on a user-defined type instance wins over any namespace of
    // the same shape — `zz.d` is a field, not a builtin path.
    const owner = this.tryEvalObject(e.obj);
    if (owner instanceof PineObject) {
      if (!owner.fields.has(e.name)) {
        throw new PineRuntimeError(`type '${owner.type}' has no field '${e.name}'`, e.line);
      }
      return owner.fields.get(e.name)!;
    }
    // Reading a field off an na object is na in Pine, not an error. A bound
    // variable shadows any same-named namespace, so once we know the base is
    // a variable we must not fall through to the builtin path lookup — that
    // would report `d.sup_area` as an unsupported namespace.
    if (e.obj.k === "ident" && this.lookup(e.obj.name) !== undefined) {
      if (owner === null) return NaN;
      if (typeof owner === "number" && Number.isNaN(owner)) return NaN;
    }

    const path = memberPath(e);
    if (path === null) {
      // The base is an expression — `(d[1]).sup` — so this can only be a field
      // read. On a bar where the base has no history yet it is na, and a field
      // of na is na rather than an error.
      const base = this.evalExpr(e.obj);
      if (base instanceof PineObject) {
        if (!base.fields.has(e.name)) {
          throw new PineRuntimeError(`type '${base.type}' has no field '${e.name}'`, e.line);
        }
        return base.fields.get(e.name)!;
      }
      if (base === null || (typeof base === "number" && Number.isNaN(base))) return NaN;
      throw new PineRuntimeError(`'${e.name}' is not a field of this value`, e.line);
    }

    if (path) {
      const v = this.namespaceConstant(path, e.line);
      if (v !== undefined) return v;
      throw new PineRuntimeError(`'${path}' is not supported by this engine`, e.line);
    }
    throw new PineRuntimeError("unsupported member access", e.line);
  }

  /**
   * Value of a member-access base, when it is something that could hold an
   * object. Deliberately limited to pure reads: evaluating a call here to find
   * out would run its side effects a second time.
   */
  private tryEvalObject(obj: Expr): PineValue | undefined {
    if (obj.k === "ident") {
      const slot = this.lookup(obj.name);
      return slot ? slot.series.get(0) : undefined;
    }
    if (obj.k === "member" || obj.k === "hist") {
      try {
        // Returned as-is, na included: a field holding `na` still identifies
        // the base as a value rather than a namespace, and callers rely on
        // that to no-op setters instead of reporting an unknown function.
        return this.evalExpr(obj);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private namespaceConstant(path: string, line: number): PineValue | undefined {
    if (path.startsWith("color.")) {
      const name = path.slice(6);
      if (NAMED_COLORS[name]) return NAMED_COLORS[name];
      return undefined;
    }
    switch (path) {
      case "math.pi": return Math.PI;
      case "math.e": return Math.E;
      case "strategy.long": return "long";
      case "strategy.short": return "short";
      case "strategy.position_size":
        return this.broker ? this.broker.positionQty : 0;
      case "strategy.position_avg_price":
        return this.broker ? this.broker.avgPrice : NaN;
      case "strategy.closedtrades":
        return this.broker ? this.broker.closed.length : 0;
      case "strategy.opentrades":
        return this.broker && this.broker.positionQty > 0 ? 1 : 0;
      case "strategy.equity":
        return this.broker ? this.broker.equityAt(this.bars.close[this.i] ?? NaN) : NaN;
      case "strategy.netprofit":
        return this.broker ? this.broker.realizedNet : 0;
      // `ta.tr` is a series, not a call — true range of the current bar, which
      // falls back to high−low on the first bar (Pine's handle_na default).
      case "ta.tr": {
        const b = this.bars;
        const i = this.i;
        const prev = i > 0 ? b.close[i - 1]! : NaN;
        const hl = b.high[i]! - b.low[i]!;
        if (!Number.isFinite(prev)) return hl;
        return Math.max(hl, Math.abs(b.high[i]! - prev), Math.abs(b.low[i]! - prev));
      }
      case "syminfo.tickerid": case "syminfo.ticker": return this.bars.symbol;
      case "syminfo.mintick": return this.broker?.opts.tickSize ?? NaN;
      case "timeframe.period": return this.bars.interval;
      case "timeframe.isintraday": return INTERVAL_MS[this.bars.interval] < 86_400_000;
      case "timeframe.isdaily": return this.bars.interval === "1d";
      case "timeframe.isdwm": return INTERVAL_MS[this.bars.interval] >= 86_400_000;
      case "timeframe.multiplier": {
        const ms = INTERVAL_MS[this.bars.interval];
        return ms < 86_400_000 ? ms / 60_000 : 1;
      }
      // The chart's own palette, as used by scripts that colour text to
      // contrast with the background. Matches the CandleChart theme.
      case "chart.fg_color": return "#d1d4dc";
      case "chart.bg_color": return "#121722";
      case "barstate.islast": return this.i === this.bars.length - 1;
      case "barstate.isfirst": return this.i === 0;
      case "barstate.isconfirmed": return true;
      case "barstate.isrealtime": return false;
      case "barstate.ishistory": return true;
      // Style/position enums are accepted and passed through as plain strings.
      default:
        if (/^(plot|hline|shape|location|size|display|scale|format|extend|line|label|text|position|alert|order|xloc|yloc|barmerge|currency|session|adjustment|math)\./.test(path)) {
          return path.split(".").slice(1).join(".");
        }
        void line;
        return undefined;
    }
  }

  private evalBinary(e: Extract<Expr, { k: "bin" }>): PineValue {
    const op = e.op;
    if (op === "and") return this.truthy(this.evalExpr(e.l)) && this.truthy(this.evalExpr(e.r));
    if (op === "or") return this.truthy(this.evalExpr(e.l)) || this.truthy(this.evalExpr(e.r));
    const l = this.evalExpr(e.l);
    const r = this.evalExpr(e.r);
    if (op === "==") return looseEq(l, r);
    if (op === "!=") return !looseEq(l, r);
    if (op === "+" && (typeof l === "string" || typeof r === "string")) {
      return `${toStr(l)}${toStr(r)}`;
    }
    const a = this.num(l, e.line);
    const b = this.num(r, e.line);
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return a / b;
      case "%": return a % b;
      case "<": return a < b;
      case ">": return a > b;
      case "<=": return a <= b;
      case ">=": return a >= b;
      default: throw new PineRuntimeError(`unsupported operator '${op}'`, e.line);
    }
  }

  // ── calls ────────────────────────────────────────────────────────────────
  private evalCall(e: Extract<Expr, { k: "call" }>): PineValue {
    // `Foo.new(…)`, `obj.method(…)` and `myArray.push(x)` are all member calls
    // whose base is a value, not a namespace — resolve those before falling
    // through to the builtin path lookup.
    if (e.callee.k === "member") {
      const dispatched = this.tryMemberCall(e.callee, e);
      if (dispatched !== undefined) return this.record(e, dispatched);
    }

    const path = e.callee.k === "ident"
      ? e.callee.name
      : e.callee.k === "member" ? memberPath(e.callee) : null;
    if (!path) throw new PineRuntimeError("unsupported call target", e.line);

    const user = this.funcs.get(path);
    if (user) return this.callUser(user, e);

    const value = this.callBuiltin(path, e);
    return this.record(e, value);
  }

  /**
   * Member calls that dispatch on a value rather than a namespace:
   *
   *  - `MyType.new(…)`      constructor for a user `type`
   *  - `obj.someMethod(…)`  a `method` declaration, receiver passed as `self`
   *  - `arr.push(x)`        Pine lets every array/matrix function be a method
   *
   * Returns `undefined` when the callee is an ordinary namespace path such as
   * `ta.sma`, so the builtin lookup carries on unchanged.
   */
  private tryMemberCall(
    callee: Extract<Expr, { k: "member" }>,
    e: Extract<Expr, { k: "call" }>
  ): PineValue | undefined {
    // Constructor: the base names a declared type.
    if (callee.obj.k === "ident" && callee.name === "new") {
      const fields = this.types.get(callee.obj.name);
      if (fields) return this.construct(callee.obj.name, fields, e);
    }

    const recv = this.tryEvalObject(callee.obj);
    if (recv === undefined) return undefined;

    if (recv instanceof PineArray || recv instanceof PineMatrix) {
      const ns = recv instanceof PineArray ? "array" : "matrix";
      const args = [recv, ...e.args.map((a) => this.evalExpr(a.value))];
      try {
        return ns === "array"
          ? callArray(callee.name, args, e.typeArg ?? null)
          : callMatrix(callee.name, args, e.typeArg ?? null);
      } catch (err) {
        if (err instanceof PineRuntimeError) throw err;
        throw new PineRuntimeError((err as Error).message, e.line);
      }
    }

    if (recv instanceof PineDrawing) {
      return this.dispatchDrawing(
        recv.kind, callee.name,
        this.drawingArgs(recv.kind, callee.name, e, recv),
        e.line
      );
    }

    if (recv instanceof PineObject || recv === null) {
      const m = this.methods.get(callee.name);
      if (m) return this.callUser(m, e, recv);
      if (recv instanceof PineObject) {
        throw new PineRuntimeError(
          `type '${recv.type}' has no method '${callee.name}'`, e.line
        );
      }
    }

    // A method call on something that holds `na` — a variable, a field, or a
    // history read. Scripts routinely declare `var box b = na` and call
    // setters before the handle exists; Pine treats that as a no-op rather
    // than an error, and so must this, or the call falls through and gets
    // reported as an unknown function.
    // na arrives as either a null handle (from a cast like `box(na)`) or NaN
    // (from a bare `na` initialiser), and both must behave the same here.
    const baseIsValue = (callee.obj.k === "ident" && this.lookup(callee.obj.name) !== undefined) ||
      callee.obj.k === "member" || callee.obj.k === "hist";
    const isNa = recv === null || (typeof recv === "number" && Number.isNaN(recv));
    if (baseIsValue && isNa) return NaN;
    return undefined;
  }

  /** Build a `type` instance: named args, then positional, then defaults. */
  private construct(
    name: string,
    fields: TypeField[],
    e: Extract<Expr, { k: "call" }>
  ): PineObject {
    const positional = e.args.filter((a) => !a.name);
    const values = new Map<string, PineValue>();
    fields.forEach((f, k) => {
      const named = e.args.find((a) => a.name === f.name);
      const supplied = named ?? positional[k];
      values.set(
        f.name,
        supplied ? this.evalExpr(supplied.value)
          : f.def ? this.evalExpr(f.def)
            : defaultFieldValue(f.type)
      );
    });
    return new PineObject(name, values);
  }

  private callUser(
    fn: Extract<Stmt, { k: "func" }>,
    e: Extract<Expr, { k: "call" }>,
    self?: PineValue
  ): PineValue {
    // Arguments are evaluated in the CALLER's frame, before switching.
    // For a method, the receiver fills the first parameter and the written
    // arguments shift one place right.
    const shift = self !== undefined ? 1 : 0;
    const positional = e.args.filter((a) => !a.name);
    const argValues = fn.params.map((p, k) => {
      if (shift && k === 0) return self!;
      const supplied = e.args.find((a) => a.name === p.name) ?? positional[k - shift];
      return supplied ? this.evalExpr(supplied.value) : p.def ? this.evalExpr(p.def) : NaN;
    });

    const key = `${this.frameKey()}${e.id}`;
    let scope = this.frameScopes.get(key);
    if (!scope) {
      scope = new Map();
      this.frameScopes.set(key, scope);
    }

    this.frameStack.push(e.id);
    this.scopes.push(scope);
    const prevFloor = this.frameFloor;
    this.frameFloor = this.scopes.length - 1;
    try {
      fn.params.forEach((p, k) => this.declare(p.name, argValues[k]!, "none", e.line));
      let last: PineValue = NaN;
      for (const st of fn.body) last = this.execStmt(st);
      return last;
    } finally {
      this.frameFloor = prevFloor;
      this.scopes.pop();
      this.frameStack.pop();
    }
  }

  /** Positional/named argument resolution against a declared signature. */
  private args(e: Extract<Expr, { k: "call" }>, names: string[]): (Expr | undefined)[] {
    const positional = e.args.filter((a) => !a.name);
    const named = new Map(e.args.filter((a) => a.name).map((a) => [a.name!, a] as const));
    return names.map((n, k) => named.get(n)?.value ?? positional[k]?.value);
  }

  private argVal(x: Expr | undefined, fallback: PineValue = NaN): PineValue {
    return x === undefined ? fallback : this.evalExpr(x);
  }

  private stateFor<T>(e: Extract<Expr, { k: "call" }>, make: () => T): T {
    const key = `${this.frameKey()}${e.id}`;
    let s = this.callState.get(key) as T | undefined;
    if (s === undefined) {
      s = make();
      this.callState.set(key, s);
    }
    return s;
  }

  /**
   * Declared variables already keep their own history; every other argument
   * expression (a builtin like `close`, or a compound like `(high+low)/2`)
   * gets history recorded on its AST node by `evalSeriesArg`.
   */
  private ownsHistory(arg: Expr): boolean {
    return arg.k === "ident" && this.lookup(arg.name) !== undefined;
  }

  /**
   * Reserve history depth for a call argument. Must run on the very first bar
   * a windowed TA call is evaluated — otherwise the node's ring buffer stays
   * at its default capacity and the early bars are overwritten before the
   * window is ever requested.
   */
  private ensureHistory(arg: Expr, len: number): void {
    if (arg.k === "ident") {
      const slot = this.lookup(arg.name);
      if (slot) { slot.series.ensure(len); return; }
    }
    this.seriesOf(arg).ensure(len);
  }

  /** How many bars of history a call argument has accumulated so far. */
  private historyDepth(arg: Expr): number {
    if (arg.k === "ident") {
      const slot = this.lookup(arg.name);
      if (slot) return slot.series.length;
    }
    return this.seriesOf(arg).length;
  }

  /** Series history for a call argument, sliced to `len` (oldest→newest). */
  private windowOf(arg: Expr | undefined, len: number, line: number): number[] {
    if (arg === undefined) throw new PineRuntimeError("missing series argument", line);
    if (arg.k === "ident") {
      const slot = this.lookup(arg.name);
      if (slot) return slot.series.window(len);
    }
    const s = this.seriesOf(arg);
    s.ensure(Math.max(len, 2));
    return s.window(len);
  }

  /** Evaluate an argument AND record it into its node series (so windows work). */
  private evalSeriesArg(arg: Expr | undefined, line: number): number {
    if (arg === undefined) throw new PineRuntimeError("missing series argument", line);
    const v = this.evalExpr(arg);
    if (!this.ownsHistory(arg)) this.seriesOf(arg).push(v);
    return this.num(v, line);
  }

  private callBuiltin(path: string, e: Extract<Expr, { k: "call" }>): PineValue {
    const line = e.line;
    const L = (x: Expr | undefined, d = NaN): number => this.num(this.argVal(x, d), line);
    const S = (x: Expr | undefined, d = ""): string => toStr(this.argVal(x, d));
    const B = (x: Expr | undefined, d = false): boolean => this.truthy(this.argVal(x, d));

    switch (path) {
      // ── declarations ──
      case "indicator": case "strategy": {
        const [title, shorttitle, overlay, format, precision] = this.args(
          e, ["title", "shorttitle", "overlay", "format", "precision"]
        );
        this.meta.kind = path === "strategy" ? "strategy" : "indicator";
        this.meta.title = S(title, "Untitled");
        this.meta.shortTitle = S(shorttitle, "");
        this.meta.overlay = B(overlay, path === "strategy");
        this.meta.format = S(format, "inherit") || "inherit";
        const digits = L(precision);
        this.meta.precision = Number.isFinite(digits)
          ? Math.max(0, Math.min(16, Math.trunc(digits)))
          : null;
        // Drawing caps are declared here; they bound the emitted payload.
        for (const [arg, kind] of [
          ["max_lines_count", "line"], ["max_boxes_count", "box"],
          ["max_labels_count", "label"],
        ] as const) {
          const supplied = e.args.find((a) => a.name === arg);
          if (supplied) this.drawings.setLimit(kind, this.num(this.evalExpr(supplied.value), line));
        }
        return NaN;
      }

      // ── inputs ──
      case "input": case "input.int": case "input.float": case "input.bool":
      case "input.string": case "input.source": case "input.color": case "input.timeframe":
      case "input.price": case "input.session": case "input.symbol":
        return this.declareInput(path, e);

      case "time": {
        const [timeframeE, sessionE, timezoneE, barsBackE] = this.args(
          e, ["timeframe", "session", "timezone", "bars_back"]
        );
        if (barsBackE !== undefined || e.args.filter((arg) => !arg.name).length > 3) {
          for (const arg of e.args) this.evalExpr(arg.value);
          throw new PineRuntimeError(
            "time() supports only time(timeframe), time(timeframe, session), and time(timeframe, session, timezone)",
            line
          );
        }
        const rawTimeframe = S(timeframeE, this.bars.interval).trim();
        let interval: Interval;
        try {
          interval = rawTimeframe === "" || rawTimeframe === this.bars.interval ||
            rawTimeframe.toLowerCase() === "chart"
            ? this.bars.interval
            : pineTfToInterval(rawTimeframe, this.bars.interval);
        } catch {
          throw new PineRuntimeError(`unsupported time() timeframe '${rawTimeframe}'`, line);
        }
        if (interval !== this.bars.interval) {
          throw new PineRuntimeError(
            `time() session filtering supports only the chart timeframe ('${this.bars.interval}')`,
            line
          );
        }
        const barTime = this.bars.time[this.i] ?? NaN;
        if (sessionE === undefined) return barTime;
        const session = S(sessionE).trim();
        if (session === "") return barTime;
        const timezone = timezoneE === undefined ? "UTC" : S(timezoneE, "UTC").trim();
        try {
          return sessionContains(barTime, session, timezone) ? barTime : NaN;
        } catch (err) {
          throw new PineRuntimeError((err as Error).message, line);
        }
      }

      case "timeframe.in_seconds": {
        const [timeframe] = this.args(e, ["timeframe"]);
        const raw = S(timeframe, this.bars.interval);
        try {
          const interval = raw === this.bars.interval
            ? this.bars.interval
            : pineTfToInterval(raw, this.bars.interval);
          return INTERVAL_MS[interval] / 1000;
        } catch {
          throw new PineRuntimeError(`unsupported timeframe '${raw}'`, line);
        }
      }
      case "timeframe.change": {
        const [timeframe] = this.args(e, ["timeframe"]);
        const raw = S(timeframe, this.bars.interval);
        if (this.i === 0) return true;
        try {
          return timeframeBucket(raw, this.bars.interval, this.bars.time[this.i]!) !==
            timeframeBucket(raw, this.bars.interval, this.bars.time[this.i - 1]!);
        } catch {
          throw new PineRuntimeError(`unsupported timeframe '${raw}'`, line);
        }
      }

      // ── plotting ──
      case "plot": return this.doPlot(e);
      case "plotshape": case "plotchar": return this.doPlotShape(e);
      case "hline": {
        const [price, title, color, linestyle, linewidth, , display] = this.args(
          e, ["price", "title", "color", "linestyle", "linewidth", "editable", "display"]
        );
        const id = `hline_${e.id}`;
        if (this.i === 0) {
          const rawStyle = S(linestyle, "solid");
          this.hlines.push({
            id,
            price: L(price),
            title: S(title, ""),
            color: pineColor(color ? this.argVal(color) : "#787b86") ?? "#787b86",
            width: Math.max(1, Math.min(4, Math.trunc(L(linewidth, 1)))) as 1 | 2 | 3 | 4,
            style: rawStyle.includes("dot") ? "dotted"
              : rawStyle.includes("dash") ? "dashed" : "solid",
            renderable: S(display, "all") !== "none",
          });
        }
        return id;
      }
      case "fill": return this.doFill(e);
      case "bgcolor": return this.doBackground(e);
      case "barcolor": return this.doBarColor(e);
      case "plotcandle": case "plotbar": return this.doOhlcPlot(path, e);

      // ── colours ──
      case "color.new": {
        // Pine's `transp` is 0 = opaque … 100 = invisible, the inverse of an
        // alpha channel. Dropping it (as this used to) makes every shaded
        // zone render as a solid block that hides the candles behind it.
        const [c, transp] = this.args(e, ["color", "transp"]);
        const base = S(c, "#787b86");
        const t = transp ? L(transp, 0) : 0;
        return withAlpha(base, Number.isFinite(t) ? t : 0);
      }
      case "color.from_gradient": {
        // Linear blend between two colours by where `value` sits in [bottom, top].
        const [val, lo, hi, cLo, cHi] = this.args(
          e, ["value", "bottom_value", "top_value", "bottom_color", "top_color"]
        );
        const v = L(val), a = L(lo), b = L(hi);
        const t = b === a ? 0 : Math.max(0, Math.min(1, (v - a) / (b - a)));
        return mixHex(S(cLo, "#787b86"), S(cHi, "#787b86"), t);
      }
      case "color.rgb": {
        const [r, g, b, transp] = this.args(e, ["red", "green", "blue", "transp"]);
        const hex = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
        const color = `#${hex(L(r, 0))}${hex(L(g, 0))}${hex(L(b, 0))}`;
        return transp === undefined ? color : withAlpha(color, L(transp, 0));
      }

      // ── na handling ──
      case "na": {
        const v = this.argVal(e.args[0]?.value);
        // A null handle is an na object/collection; a live handle never is.
        if (v === null) return true;
        if (isRef(v)) return false;
        return typeof v === "number" ? Number.isNaN(v) : v === undefined;
      }
      case "nz": {
        const v = this.argVal(e.args[0]?.value);
        const repl = e.args[1] ? this.argVal(e.args[1].value) : 0;
        if (typeof v === "number") return Number.isNaN(v) ? repl : v;
        return v;
      }
      case "fixnan": {
        const st = this.stateFor(e, () => ({ last: NaN }));
        const v = L(e.args[0]?.value);
        if (!Number.isNaN(v)) st.last = v;
        return st.last;
      }

      // ── math ──
      case "math.abs": return Math.abs(L(e.args[0]?.value));
      case "math.max": return Math.max(...e.args.map((a) => this.num(this.evalExpr(a.value), line)));
      case "math.min": return Math.min(...e.args.map((a) => this.num(this.evalExpr(a.value), line)));
      case "math.pow": return Math.pow(L(e.args[0]?.value), L(e.args[1]?.value));
      case "math.sqrt": return Math.sqrt(L(e.args[0]?.value));
      case "math.log": return Math.log(L(e.args[0]?.value));
      case "math.log10": return Math.log10(L(e.args[0]?.value));
      case "math.exp": return Math.exp(L(e.args[0]?.value));
      case "math.sign": return Math.sign(L(e.args[0]?.value));
      case "math.floor": return Math.floor(L(e.args[0]?.value));
      case "math.ceil": return Math.ceil(L(e.args[0]?.value));
      case "math.round": {
        const v = L(e.args[0]?.value);
        const p = e.args[1] ? L(e.args[1].value) : 0;
        const f = Math.pow(10, p);
        return Math.round(v * f) / f;
      }
      case "math.avg": {
        const vals = e.args.map((a) => this.num(this.evalExpr(a.value), line));
        return vals.reduce((s, v) => s + v, 0) / vals.length;
      }
      case "math.todegrees": return (L(e.args[0]?.value) * 180) / Math.PI;
      case "math.toradians": return (L(e.args[0]?.value) * Math.PI) / 180;
      case "math.sin": return Math.sin(L(e.args[0]?.value));
      case "math.cos": return Math.cos(L(e.args[0]?.value));
      case "math.tan": return Math.tan(L(e.args[0]?.value));

      // ── strings ──
      case "str.tostring": {
        const v = this.argVal(e.args[0]?.value);
        return typeof v === "number" && e.args[1]
          ? v.toFixed(Math.max(0, (S(e.args[1].value, "#.##").split(".")[1] ?? "").length))
          : toStr(v);
      }
      case "str.tonumber": return Number(S(e.args[0]?.value)) || NaN;
      case "str.lower": return S(e.args[0]?.value).toLowerCase();
      case "str.upper": return S(e.args[0]?.value).toUpperCase();
      case "str.contains": return S(e.args[0]?.value).includes(S(e.args[1]?.value));
      case "str.startswith": return S(e.args[0]?.value).startsWith(S(e.args[1]?.value));
      case "str.endswith": return S(e.args[0]?.value).endsWith(S(e.args[1]?.value));
      case "str.replace_all":
        return S(e.args[0]?.value).split(S(e.args[1]?.value)).join(S(e.args[2]?.value));
      case "str.substring": {
        const s = S(e.args[0]?.value);
        const from = Math.trunc(L(e.args[1]?.value, 0));
        const to = e.args[2] ? Math.trunc(L(e.args[2].value, s.length)) : s.length;
        return s.slice(from, to);
      }
      case "str.pos": {
        const at = S(e.args[0]?.value).indexOf(S(e.args[1]?.value));
        return at < 0 ? NaN : at;
      }
      case "str.format": return S(e.args[0]?.value);
      case "str.length": return S(e.args[0]?.value).length;

      // ── ta: window functions (slice history → engine/ta.ts) ──
      case "ta.sma": case "ta.wma": case "ta.hma": case "ta.highest": case "ta.lowest":
      case "ta.stdev": case "ta.variance": case "ta.median": case "ta.sum":
      case "ta.highestbars": case "ta.lowestbars": case "ta.percentrank":
      case "ta.cci": case "ta.dev": case "math.sum":
        return this.taWindow(path, e);

      case "ta.linreg": {
        const [src, len, off] = this.args(e, ["source", "length", "offset"]);
        const n = this.taLength(this.argVal(len), line);
        this.evalSeriesArg(src, line);
        const w = this.windowOf(src, n, line);
        return last(ta.linreg(w, n, Math.trunc(L(off, 0))));
      }
      case "ta.vwma": {
        const [src, len] = this.args(e, ["source", "length"]);
        const n = this.taLength(this.argVal(len), line);
        this.evalSeriesArg(src, line);
        const w = this.windowOf(src, n, line);
        const vol = this.barWindow(this.bars.volume, n);
        return last(ta.vwma(w, vol, n));
      }
      case "ta.mfi": {
        if (e.args.length !== 2 || e.args.some((arg) =>
          arg.name !== undefined && arg.name !== "series" && arg.name !== "length" && arg.name !== "source"
        )) {
          for (const arg of e.args) this.evalExpr(arg.value);
          throw new PineRuntimeError("ta.mfi supports only ta.mfi(series, length)", line);
        }
        const [src, len] = this.args(e, ["series", "length"]);
        const source = src ?? e.args.find((arg) => arg.name === "source")?.value;
        const n = this.taLength(this.argVal(len), line);
        this.evalSeriesArg(source, line);
        this.ensureHistory(source!, n + 1);
        if (this.historyDepth(source!) < n + 1) return NaN;
        const values = this.windowOf(source, n + 1, line);
        const volume = this.barWindow(this.bars.volume, n + 1);
        return last(ta.mfi(values, volume, n));
      }

      // ── ta: recursive functions (streaming state) ──
      case "ta.ema": {
        const [src, len] = this.args(e, ["source", "length"]);
        const st = this.stateFor(e, () => new Ema(this.taLength(this.argVal(len), line)));
        return st.next(this.evalSeriesArg(src, line));
      }
      case "ta.rma": {
        const [src, len] = this.args(e, ["source", "length"]);
        const st = this.stateFor(e, () => rmaState(this.taLength(this.argVal(len), line)));
        return (st as RecursiveMa).next(this.evalSeriesArg(src, line));
      }
      case "ta.atr": {
        const [len] = this.args(e, ["length"]);
        const st = this.stateFor(e, () => new Atr(this.taLength(this.argVal(len), line)));
        return st.next(this.bars.high[this.i]!, this.bars.low[this.i]!, this.bars.close[this.i]!);
      }
      case "ta.tr": {
        const handleNa = e.args[0] ? B(e.args[0].value) : false;
        const st = this.stateFor(e, () => new TrueRange(handleNa));
        return st.next(this.bars.high[this.i]!, this.bars.low[this.i]!, this.bars.close[this.i]!);
      }
      case "ta.rsi": {
        const [src, len] = this.args(e, ["source", "length"]);
        const st = this.stateFor(e, () => new Rsi(this.taLength(this.argVal(len), line)));
        return st.next(this.evalSeriesArg(src, line));
      }
      case "ta.cum": {
        const st = this.stateFor(e, () => new Cum());
        return st.next(L(e.args[0]?.value));
      }
      case "ta.vwap": {
        const [source, anchor, multiplier] = this.args(e, ["source", "anchor", "stdev_mult"]);
        const price = L(source);
        const volume = this.bars.volume[this.i] ?? NaN;
        const reset = anchor === undefined
          ? timeframeBucket("D", this.bars.interval, this.bars.time[this.i]!) !==
            (this.i > 0
              ? timeframeBucket("D", this.bars.interval, this.bars.time[this.i - 1]!)
              : -1)
          : B(anchor);
        const st = this.stateFor(e, () => ({ weighted: 0, squared: 0, volume: 0 }));
        if (reset) { st.weighted = 0; st.squared = 0; st.volume = 0; }
        if (Number.isFinite(price) && Number.isFinite(volume) && volume >= 0) {
          st.weighted += price * volume;
          st.squared += price * price * volume;
          st.volume += volume;
        }
        if (!(st.volume > 0)) return multiplier === undefined ? NaN : [NaN, NaN, NaN];
        const mean = st.weighted / st.volume;
        if (multiplier === undefined) return mean;
        const deviation = Math.sqrt(Math.max(0, st.squared / st.volume - mean * mean)) * L(multiplier);
        return [mean, mean + deviation, mean - deviation];
      }
      case "ta.barssince": {
        const st = this.stateFor(e, () => new BarsSince());
        return st.next(this.truthy(this.argVal(e.args[0]?.value)));
      }
      case "ta.valuewhen": {
        const [cond, src, occ] = this.args(e, ["condition", "source", "occurrence"]);
        const st = this.stateFor(e, () => new ValueWhen(Math.trunc(L(occ, 0))));
        return st.next(this.truthy(this.argVal(cond)), L(src));
      }
      case "ta.change": case "ta.mom": {
        const [src, len] = this.args(e, ["source", "length"]);
        const n = this.taLength(this.argVal(len, 1), line);
        const cur = this.evalSeriesArg(src, line);
        const w = this.windowOf(src, n + 1, line);
        return cur - (w[0] ?? NaN);
      }
      case "ta.roc": {
        const [src, len] = this.args(e, ["source", "length"]);
        const n = this.taLength(this.argVal(len, 1), line);
        const cur = this.evalSeriesArg(src, line);
        const w = this.windowOf(src, n + 1, line);
        const prev = w[0] ?? NaN;
        return ((cur - prev) / prev) * 100;
      }
      case "ta.crossover": case "ta.crossunder": case "ta.cross": {
        const [a, b] = this.args(e, ["source1", "source2"]);
        const av = this.evalSeriesArg(a, line);
        const bv = this.evalSeriesArg(b, line);
        const st = this.stateFor(e, () => ({ pa: NaN, pb: NaN, primed: false }));
        const over = st.primed && st.pa <= st.pb && av > bv;
        const under = st.primed && st.pa >= st.pb && av < bv;
        st.pa = av; st.pb = bv; st.primed = true;
        return path === "ta.crossover" ? over : path === "ta.crossunder" ? under : over || under;
      }
      case "ta.pivothigh": case "ta.pivotlow": {
        // (source?, leftbars, rightbars) — source defaults to high/low.
        const hasSrc = e.args.length >= 3;
        const srcExpr = hasSrc ? this.args(e, ["source", "leftbars", "rightbars"])[0] : undefined;
        const [leftA, rightA] = hasSrc
          ? this.args(e, ["source", "leftbars", "rightbars"]).slice(1)
          : this.args(e, ["leftbars", "rightbars"]);
        const left = this.taLength(this.argVal(leftA), line);
        const right = this.taLength(this.argVal(rightA), line);
        const need = left + right + 1;
        let w: number[];
        if (srcExpr) {
          this.evalSeriesArg(srcExpr, line);
          w = this.windowOf(srcExpr, need, line);
        } else {
          w = this.barWindow(path === "ta.pivothigh" ? this.bars.high : this.bars.low, need);
        }
        const series = path === "ta.pivothigh" ? ta.pivothigh(w, left, right) : ta.pivotlow(w, left, right);
        return last(series);
      }
      case "ta.macd": {
        const [src, fast, slow, sig] = this.args(e, ["source", "fastlen", "slowlen", "siglen"]);
        const st = this.stateFor(e, () => ({
          fast: new Ema(this.taLength(this.argVal(fast, 12), line)),
          slow: new Ema(this.taLength(this.argVal(slow, 26), line)),
          sig: new Ema(this.taLength(this.argVal(sig, 9), line)),
        }));
        const v = this.evalSeriesArg(src, line);
        const macd = st.fast.next(v) - st.slow.next(v);
        const signal = st.sig.next(macd);
        return [macd, signal, macd - signal];
      }
      case "ta.bb": {
        const [src, len, mult] = this.args(e, ["series", "length", "mult"]);
        const n = this.taLength(this.argVal(len), line);
        const m = L(mult, 2);
        this.evalSeriesArg(src, line);
        const w = this.windowOf(src, n, line);
        const basis = last(ta.sma(w, n));
        const dev = m * last(ta.stdev(w, n));
        return [basis, basis + dev, basis - dev];
      }
      case "ta.stoch": {
        const [src, hi, lo, len] = this.args(e, ["source", "high", "low", "length"]);
        const n = this.taLength(this.argVal(len), line);
        const c = this.evalSeriesArg(src, line);
        this.evalSeriesArg(hi, line);
        this.evalSeriesArg(lo, line);
        const hh = Math.max(...this.windowOf(hi, n, line).filter((x) => !Number.isNaN(x)));
        const ll = Math.min(...this.windowOf(lo, n, line).filter((x) => !Number.isNaN(x)));
        return hh === ll ? NaN : (100 * (c - ll)) / (hh - ll);
      }

      // ── strategy ──
      case "strategy.entry": return this.strategyEntry(e);
      case "strategy.close": case "strategy.close_all": {
        const [id] = this.args(e, ["id"]);
        this.requireBroker(line).queueClose(S(id, "close") || "close");
        return NaN;
      }
      case "strategy.exit": return this.strategyExit(e);
      case "strategy.cancel": case "strategy.cancel_all": return NaN;

      // ── alerts (accepted, not delivered from a backtest) ──
      case "alert": case "alertcondition": return NaN;

      // Buffer hints. The engine grows history on demand, so these are
      // declarations with nothing to declare.
      case "max_bars_back": return NaN;

      // ── chart.point ──
      // A plain record of (index, time, price) that polyline/label APIs pass
      // around; modelled as an ordinary object so field reads just work.
      case "chart.point.from_index": case "chart.point.from_time":
      case "chart.point.new": case "chart.point.now": {
        const a0 = this.argVal(e.args[0]?.value);
        const a1 = this.argVal(e.args[1]?.value);
        const fields = new Map<string, PineValue>();
        if (path === "chart.point.from_index") {
          fields.set("index", a0);
          fields.set("time", this.timeAtBar(this.num(a0, line)));
          fields.set("price", a1);
        } else if (path === "chart.point.from_time") {
          fields.set("index", NaN);
          fields.set("time", a0);
          fields.set("price", a1);
        } else if (path === "chart.point.now") {
          fields.set("index", this.i);
          fields.set("time", this.bars.time[this.i] ?? NaN);
          fields.set("price", a0 === undefined ? this.bars.close[this.i] ?? NaN : a0);
        } else {
          fields.set("time", a0);
          fields.set("index", a1);
          fields.set("price", this.argVal(e.args[2]?.value));
        }
        return new PineObject("chart.point", fields);
      }

      // ── type casts ──
      // `box(na)`, `line(na)`, `float(x)` … are casts, not constructors. The
      // engine is dynamically typed, so the value passes through; only the
      // na-to-null mapping matters, so a cast na reads as an absent handle.
      case "color": case "line": case "label": case "box": case "table": case "linefill": {
        const v = this.argVal(e.args[0]?.value);
        return typeof v === "number" && Number.isNaN(v) ? null : v;
      }
      case "int": case "float": {
        const v = this.num(this.argVal(e.args[0]?.value), line);
        return path === "int" ? Math.trunc(v) : v;
      }
      case "bool": return this.truthy(this.argVal(e.args[0]?.value));
      case "string": return toStr(this.argVal(e.args[0]?.value));

      /**
       * Multi-timeframe requests, supported only where they need no second
       * feed: asking for the chart's own timeframe. Scripts commonly gate an
       * intrabar fetch behind a toggle and fall back to `timeframe.period`
       * when it is off, and that path is exactly the current series.
       *
       * A genuinely different timeframe still errors — silently substituting
       * chart-timeframe data there would produce plausible, wrong numbers.
       */
      case "request.security": case "request.security_lower_tf": {
        const [, tf, expr, gaps, lookahead] = this.args(
          e,
          ["symbol", "timeframe", "expression", "gaps", "lookahead"]
        );
        const want = S(tf, "").trim();
        const own = this.bars.interval;
        const sameTf = want === "" || want === own || want.toLowerCase() === "chart";

        // This engine deliberately implements completed bars with gaps_off and
        // lookahead_off semantics. Optional values outside that subset must be
        // rejected instead of being accepted and silently ignored.
        if (path === "request.security") {
          if (gaps !== undefined) {
            const value = this.evalExpr(gaps);
            if (value !== "gaps_off") {
              throw new PineRuntimeError(
                "request.security gaps supports only barmerge.gaps_off", line
              );
            }
          }
          if (lookahead !== undefined) {
            const value = this.evalExpr(lookahead);
            // Pine v4 scripts commonly spell lookahead_off as `false`.
            if (value !== "lookahead_off" && value !== false) {
              throw new PineRuntimeError(
                "request.security lookahead supports only barmerge.lookahead_off (or false)",
                line
              );
            }
          }
        }
        /**
         * During a capture pass this instance IS the requested timeframe, even
         * though the two are spelled differently: Pine says "60", the platform
         * calls the same feed "1h". Match on the raw string the pass was
         * started with rather than on `bars.interval`.
         */
        const isCaptureTarget = this.captureTf !== null && want === this.captureTf;

        if (!sameTf && !isCaptureTarget) {
          // Declaration pass: note what the script needs so the caller can
          // load it, and answer with a placeholder.
          if (this.declaring) {
            this.needTf.add(want);
            return path === "request.security" ? NaN : new PineArray("float", [NaN]);
          }
          // A capture pass is running as ONE timeframe; a call for any other is
          // not what it is collecting, so it answers empty rather than failing.
          if (this.captureTf !== null) {
            return path === "request.security" ? NaN : new PineArray("float", [NaN]);
          }
          const series = this.htfValues.get(this.securityKey(e, want));
          if (!series) {
            throw new PineRuntimeError(
              `request.${path.slice(8)} for a different timeframe ('${want}' vs the chart's ` +
              `'${own}') has no feed loaded — the caller must supply it in RunOptions.htf`,
              line
            );
          }
          const bars = this.htf[want];
          const v = bars ? this.alignHtf(series, bars) : NaN;
          if (path === "request.security") return v;
          const wrapOne = (x: PineValue): PineValue => new PineArray("float", [x]);
          return Array.isArray(v) ? v.map(wrapOne) : wrapOne(v);
        }

        const v = expr ? this.evalExpr(expr) : NaN;
        // Capturing this timeframe: record the value this HTF bar produced.
        if (this.captureInto && isCaptureTarget) {
          const key = this.securityKey(e, want);
          let arr = this.captureInto.get(key);
          if (!arr) { arr = []; this.captureInto.set(key, arr); }
          arr[this.i] = v;
        }
        if (path === "request.security") return v;
        // The lower_tf form answers with one array per requested series; at the
        // chart's own resolution each bar contributes exactly one element.
        const wrap = (x: PineValue): PineValue => new PineArray("float", [x]);
        return Array.isArray(v) ? v.map(wrap) : wrap(v);
      }
      default:
        if (path.startsWith("array.") || path.startsWith("matrix.")) {
          return this.callCollection(path, e);
        }
        if (path.startsWith("map.")) {
          throw new PineRuntimeError(`maps (${path}) are not supported by this engine`, line);
        }
        if (DRAWING_NS.test(path)) return this.callDrawingPath(path, e);
        if (path.startsWith("linefill.") || path.startsWith("polyline.")) {
          for (const arg of e.args) this.evalExpr(arg.value);
          this.compatibilityWarning(
            line,
            `${path} is not rendered by this chart runtime; no substitute was drawn`
          );
          return NaN;
        }
        throw new PineRuntimeError(`unknown function '${path}'`, line);
    }
  }

  /**
   * `array.*` / `matrix.*`. Arguments are positional here — Pine's collection
   * functions take no named arguments — and the flat `Error`s the collection
   * layer throws are re-tagged with this call's line.
   */
  private callCollection(path: string, e: Extract<Expr, { k: "call" }>): PineValue {
    const dot = path.indexOf(".");
    const ns = path.slice(0, dot);
    const fn = path.slice(dot + 1);
    const args = e.args.map((a) => this.evalExpr(a.value));
    try {
      return ns === "array"
        ? callArray(fn, args, e.typeArg ?? null)
        : callMatrix(fn, args, e.typeArg ?? null);
    } catch (err) {
      if (err instanceof PineRuntimeError) throw err;
      throw new PineRuntimeError((err as Error).message, e.line);
    }
  }

  /**
   * `line.*` / `box.*` / `label.*` / `table.*`.
   *
   * Named arguments matter here — `label.new(x, y, text, color=…, style=…)` is
   * the normal way these are called — so arguments are resolved against the
   * declared parameter order before dispatch.
   */
  private callDrawingPath(path: string, e: Extract<Expr, { k: "call" }>): PineValue {
    const dot = path.indexOf(".");
    const ns = path.slice(0, dot);
    const fn = path.slice(dot + 1);
    return this.dispatchDrawing(ns, fn, this.drawingArgs(ns, fn, e, undefined), e.line);
  }

  /** Positional + named arguments for one drawing call, receiver first. */
  private drawingArgs(
    ns: string, fn: string,
    e: Extract<Expr, { k: "call" }>,
    self: PineValue | undefined
  ): PineValue[] {
    const names = drawingParamNames(ns, fn);
    const positional = e.args.filter((a) => !a.name);
    const out: PineValue[] = [];
    // A method call supplies the receiver; the plain form takes it as arg 0.
    if (self !== undefined) out.push(self);
    const offset = self !== undefined ? 1 : 0;
    for (let k = 0; k < names.length; k++) {
      const pname = names[k]!;
      const named = e.args.find((a) => a.name === pname);
      const supplied = named ?? positional[k - offset];
      out[k] = supplied ? this.evalExpr(supplied.value) : undefined as unknown as PineValue;
    }
    // Any extra positional arguments beyond the known signature still count.
    for (let k = names.length; k < positional.length + offset; k++) {
      const supplied = positional[k - offset];
      if (supplied) out[k] = this.evalExpr(supplied.value);
    }
    return out;
  }

  private dispatchDrawing(ns: string, fn: string, args: PineValue[], line: number): PineValue {
    try {
      return callDrawing(this.drawings, ns, fn, args);
    } catch (err) {
      if (err instanceof PineRuntimeError) throw err;
      throw new PineRuntimeError((err as Error).message, line);
    }
  }

  /** Rolling window straight off a bar array (high/low/volume). */
  private barWindow(arr: number[], len: number): number[] {
    const out = new Array<number>(len);
    for (let k = 0; k < len; k++) {
      const idx = this.i - (len - 1 - k);
      out[k] = idx >= 0 && idx < arr.length ? arr[idx]! : NaN;
    }
    return out;
  }

  private taWindow(path: string, e: Extract<Expr, { k: "call" }>): PineValue {
    const line = e.line;
    const [src, len] = this.args(e, ["source", "length"]);
    const n = this.taLength(this.argVal(len), line);
    this.evalSeriesArg(src, line);
    this.ensureHistory(src!, n);
    // Not enough bars yet: na, matching engine/ta.ts's warmup convention.
    // (The array helpers that skip NaN would otherwise answer from a partial
    // window — `ta.highest` being the obvious one.)
    if (this.historyDepth(src!) < n) return NaN;
    const w = this.windowOf(src, n, line);
    switch (path) {
      case "ta.cci": {
        // (src − SMA) / (0.015 × mean absolute deviation) over the window.
        const mean = w.reduce((s, v) => s + v, 0) / n;
        const md = w.reduce((s, v) => s + Math.abs(v - mean), 0) / n;
        return md === 0 ? 0 : (w[n - 1]! - mean) / (0.015 * md);
      }
      case "ta.dev": {
        const mean = w.reduce((s, v) => s + v, 0) / n;
        return w.reduce((s, v) => s + Math.abs(v - mean), 0) / n;
      }
      case "math.sum": return w.reduce((s, v) => s + v, 0);
      case "ta.sma": return last(ta.sma(w, n));
      case "ta.wma": return last(ta.wma(w, n));
      case "ta.hma": return last(ta.hma(w, n));
      case "ta.highest": return last(ta.highest(w, n));
      case "ta.lowest": return last(ta.lowest(w, n));
      case "ta.sum": return last(ta.rollSum(w, n));
      case "ta.stdev": return last(ta.stdev(w, n));
      case "ta.variance": {
        const s = last(ta.stdev(w, n));
        return s * s;
      }
      case "ta.median": {
        const vals = w.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
        if (vals.length < n) return NaN;
        const mid = Math.floor(vals.length / 2);
        return vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2;
      }
      case "ta.highestbars": {
        const hi = last(ta.highest(w, n));
        for (let k = w.length - 1; k >= 0; k--) if (w[k] === hi) return -(w.length - 1 - k);
        return NaN;
      }
      case "ta.lowestbars": {
        const lo = last(ta.lowest(w, n));
        for (let k = w.length - 1; k >= 0; k--) if (w[k] === lo) return -(w.length - 1 - k);
        return NaN;
      }
      case "ta.percentrank": {
        const cur = w[w.length - 1]!;
        const prior = w.slice(0, -1).filter((v) => !Number.isNaN(v));
        if (prior.length === 0) return NaN;
        return (prior.filter((v) => v <= cur).length / prior.length) * 100;
      }
      default: throw new PineRuntimeError(`unknown function '${path}'`, line);
    }
  }

  /**
   * Validate a `length` argument. Bounded because a window length ultimately
   * sizes an allocation, and `ta.sma(close, 5e7)` would otherwise try to build
   * a 50-million-element array once enough bars exist.
   */
  private taLength(v: PineValue, line: number): number {
    const n = Math.trunc(this.num(v, line));
    if (!Number.isFinite(n) || n <= 0) {
      throw new PineRuntimeError("length must be a positive number", line);
    }
    if (n > LIMITS.taLength) {
      throw new PineRuntimeError(
        `length must be at most ${LIMITS.taLength.toLocaleString()} (got ${n.toLocaleString()})`, line
      );
    }
    return n;
  }

  private requireBroker(line: number): Broker {
    if (!this.broker) {
      throw new PineRuntimeError(
        "strategy.* calls require a strategy() script — declare strategy(\"…\") at the top", line
      );
    }
    return this.broker;
  }

  private strategyEntry(e: Extract<Expr, { k: "call" }>): PineValue {
    const [id, direction] = this.args(e, ["id", "direction", "qty", "limit", "stop", "comment"]);
    const dir = toStr(this.argVal(direction, "long"));
    const broker = this.requireBroker(e.line);
    if (dir === "short") {
      // The broker is long-only (as is every strategy this platform runs);
      // a short entry closes any long rather than silently reversing.
      if (broker.positionQty > 0) broker.queueClose("short signal");
      return NaN;
    }
    if (this.inRange) broker.queueEntry(toStr(this.argVal(id, "Long")) || "Long");
    return NaN;
  }

  private strategyExit(e: Extract<Expr, { k: "call" }>): PineValue {
    const [id, , qty, , limit, stop] = this.args(
      e, ["id", "from_entry", "qty", "qty_percent", "limit", "stop", "trail_price", "trail_points", "trail_offset", "comment"]
    );
    const broker = this.requireBroker(e.line);
    if (!this.inRange || broker.positionQty <= 0) return NaN;
    const lim = this.num(this.argVal(limit), e.line);
    const stp = this.num(this.argVal(stop), e.line);
    if (Number.isNaN(lim) && Number.isNaN(stp)) return NaN;
    const q = this.num(this.argVal(qty), e.line);
    broker.setExitLeg(
      toStr(this.argVal(id, "exit")) || "exit",
      Number.isNaN(q) ? null : q,
      Number.isNaN(lim) ? Infinity : lim,
      Number.isNaN(stp) ? -Infinity : stp,
      this.i
    );
    return NaN;
  }

  // ── inputs ───────────────────────────────────────────────────────────────
  private declareInput(path: string, e: Extract<Expr, { k: "call" }>): PineValue {
    const line = e.line;
    const [defvalE, titleE] = this.args(e, ["defval", "title"]);
    const named = new Map(e.args.filter((a) => a.name).map((a) => [a.name!, a.value] as const));
    // `input.source(high, …)` names a series. Evaluating the default would
    // reduce `high` to the current bar's number and lose the name the input is
    // actually selecting, so take it from the AST instead.
    const isSource = path === "input.source";
    const sourceName = isSource && defvalE
      ? (defvalE.k === "ident" ? defvalE.name
        : defvalE.k === "member" ? (memberPath(defvalE) ?? "close")
          : toStr(this.argVal(defvalE, "close")) || "close")
      : "";
    const raw = isSource ? sourceName : this.argVal(defvalE, NaN);
    // input.price / input.symbol / input.session all carry plain string values.
    const suffix = path === "input" ? inferKind(raw) : path.split(".")[1]!;
    const kind: PineInputDef["type"] =
      suffix === "price" || suffix === "symbol" || suffix === "session"
        ? "string"
        : (suffix as PineInputDef["type"]);
    const title = toStr(this.argVal(titleE ?? named.get("title"), ""));
    const key = this.declName ?? (title || `input_${e.id}`);

    if (!this.inputsSeen.has(key)) {
      this.inputsSeen.add(key);
      const optionsExpr = named.get("options");
      const def: PineInputDef = {
        key,
        title: title || key,
        type: kind,
        defval: raw as number | string | boolean,
      };
      const min = named.get("minval");
      const max = named.get("maxval");
      const step = named.get("step");
      const group = named.get("group");
      const tooltip = named.get("tooltip");
      if (min) def.minval = this.num(this.evalExpr(min), line);
      if (max) def.maxval = this.num(this.evalExpr(max), line);
      if (step) def.step = this.num(this.evalExpr(step), line);
      if (group) def.group = toStr(this.evalExpr(group));
      if (tooltip) def.tooltip = toStr(this.evalExpr(tooltip));
      if (optionsExpr && optionsExpr.k === "tuple") {
        def.options = optionsExpr.items.map((x) => this.evalExpr(x) as string | number);
      }
      this.meta.inputs.push(def);
    }

    const override = this.params[key];
    const value = override !== undefined ? override : raw;
    // input.source names a built-in series; resolve it to that series' value.
    if (kind === "source") {
      const name = toStr(value) || "close";
      const v = this.builtinSeries(name, this.i, line);
      return v === undefined ? NaN : v;
    }
    if (kind === "int") return Math.trunc(this.num(value, line));
    if (kind === "float") return this.num(value, line);
    if (kind === "bool") return this.truthy(value);
    return value as PineValue;
  }

  // ── plots ────────────────────────────────────────────────────────────────
  private doPlot(e: Extract<Expr, { k: "call" }>): PineValue {
    const line = e.line;
    const [seriesE, titleE, colorE, widthE, styleE, , histbaseE, offsetE, , , , displayE, , precisionE, forceOverlayE] = this.args(
      e, [
        "series", "title", "color", "linewidth", "style", "trackprice", "histbase",
        "offset", "join", "editable", "show_last", "display", "format", "precision",
        "force_overlay",
      ]
    );
    const id = `plot_${e.id}`;
    const rawColor = colorE ? this.argVal(colorE) : undefined;
    let plot = this.plots.get(id);
    if (!plot && this.plotOrder.length + this.ohlcPlotOrder.length >= LIMITS.plots) {
      throw new PineRuntimeError(`a script may declare at most ${LIMITS.plots} plots`, line);
    }
    if (!plot) {
      const style = normaliseStyle(toStr(this.argVal(styleE, "line")));
      const initialDisplay = toStr(this.argVal(displayE, "all"));
      const requestedOffset = Math.trunc(this.num(this.argVal(offsetE, 0), line));
      if (!Number.isFinite(requestedOffset) || Math.abs(requestedOffset) > 500) {
        throw new PineRuntimeError("plot offset must be between -500 and 500 bars", line);
      }
      const renderable = initialDisplay !== "none";
      // Evaluate histbase even though the current chart adapter uses Pine's
      // normal zero baseline. A non-zero baseline would otherwise be a silent
      // semantic substitution, so surface it explicitly.
      const histbase = this.num(this.argVal(histbaseE, 0), line);
      if ((style === "histogram" || style === "columns") && histbase !== 0) {
        this.compatibilityWarning(
          line,
          `plot histbase=${histbase} is not rendered; histogram columns use a zero baseline`
        );
      }
      const plotPrecision = this.num(this.argVal(precisionE), line);
      if (Number.isFinite(plotPrecision) && this.meta.precision === null) {
        this.meta.precision = Math.max(0, Math.min(16, Math.trunc(plotPrecision)));
      }
      plot = {
        id,
        title: toStr(this.argVal(titleE, "")) || this.declName || `Plot ${this.plotOrder.length + 1}`,
        color: pineColor(rawColor)
          ?? DEFAULT_COLORS[this.plotOrder.length % DEFAULT_COLORS.length]!,
        width: Math.max(1, Math.trunc(this.num(this.argVal(widthE, 1), line))) || 1,
        style,
        offset: requestedOffset,
        forceOverlay: this.truthy(this.argVal(forceOverlayE, false)),
        renderable,
        colors: [],
        data: [],
      };
      this.plots.set(id, plot);
      this.plotOrder.push(id);
    }
    const v = this.num(this.argVal(seriesE), line);
    const display = toStr(this.argVal(displayE, "all"));
    const pointColor = colorE ? pineColor(rawColor) : plot.color;
    if (this.inRange) {
      plot.data.push(display === "none" || !Number.isFinite(v) ? null : v);
      plot.colors.push(display === "none" ? null : pointColor);
    }
    // `plot()` returns a stable plot handle used by fill().
    return id;
  }

  private doFill(e: Extract<Expr, { k: "call" }>): PineValue {
    const positional = e.args.filter((arg) => !arg.name);
    const gradient = e.args.some((arg) =>
      arg.name === "top_value" || arg.name === "bottom_value" ||
      arg.name === "top_color" || arg.name === "bottom_color"
    ) || positional.length >= 6;
    if (gradient) {
      for (const arg of e.args) this.evalExpr(arg.value);
      this.compatibilityWarning(
        e.line,
        "gradient fill() is not rendered; only fill(plot, plot, color) and fill(hline, hline, color) are supported"
      );
      return NaN;
    }

    const [firstE, secondE, colorE, titleE, , showLastE, fillgapsE, displayE] = this.args(
      e, ["plot1", "plot2", "color", "title", "editable", "show_last", "fillgaps", "display"]
    );
    const firstId = toStr(this.argVal(firstE));
    const secondId = toStr(this.argVal(secondE));
    const color = pineColor(this.argVal(colorE));
    const display = toStr(this.argVal(displayE, "all"));
    const fillgaps = this.truthy(this.argVal(fillgapsE, true));
    if (showLastE !== undefined) {
      this.evalExpr(showLastE);
      this.compatibilityWarning(e.line, "fill() show_last is not supported; the fill was not rendered");
    }

    const id = `fill_${e.id}`;
    let fill = this.fills.get(id);
    if (!fill) {
      const firstKind = firstId.startsWith("plot_") ? "plot"
        : firstId.startsWith("hline_") ? "hline" : "unknown";
      const secondKind = secondId.startsWith("plot_") ? "plot"
        : secondId.startsWith("hline_") ? "hline" : "unknown";
      const firstPlot = this.plots.get(firstId);
      const secondPlot = this.plots.get(secondId);
      const known = firstKind !== "unknown" && firstKind === secondKind &&
        (firstKind === "hline" || (firstPlot !== undefined && secondPlot !== undefined));
      const firstOnPrice = this.meta.overlay || (firstPlot?.forceOverlay ?? false);
      const secondOnPrice = this.meta.overlay || (secondPlot?.forceOverlay ?? false);
      const samePane = firstOnPrice === secondOnPrice;
      const endpointsVisible = firstKind === "hline" ||
        (firstPlot?.renderable === true && secondPlot?.renderable === true);
      const renderable = known && samePane && endpointsVisible && showLastE === undefined && display !== "none";
      if (!known) {
        this.compatibilityWarning(
          e.line,
          "fill() requires two existing plot handles or two existing hline handles; no fill was drawn"
        );
      } else if (!samePane) {
        this.compatibilityWarning(e.line, "fill() endpoints belong to different panes; no fill was drawn");
      } else if (!endpointsVisible) {
        this.compatibilityWarning(e.line, "fill() with a display.none endpoint is not rendered");
      }
      fill = {
        id,
        title: toStr(this.argVal(titleE, "")) || "Fill",
        firstId,
        secondId,
        forceOverlay: firstOnPrice,
        renderable,
        fillgaps,
        colors: [],
      };
      this.fills.set(id, fill);
      this.fillOrder.push(id);
    }
    if (this.inRange) fill.colors.push(fill.renderable && display !== "none" ? color : null);
    return NaN;
  }

  private doBackground(e: Extract<Expr, { k: "call" }>): PineValue {
    const [colorE, offsetE, , showLastE, titleE, displayE, forceOverlayE] = this.args(
      e, ["color", "offset", "editable", "show_last", "title", "display", "force_overlay"]
    );
    const color = pineColor(this.argVal(colorE));
    const offset = Math.trunc(this.num(this.argVal(offsetE, 0), e.line));
    if (!Number.isFinite(offset) || Math.abs(offset) > 500) {
      throw new PineRuntimeError("bgcolor offset must be between -500 and 500 bars", e.line);
    }
    if (showLastE !== undefined) {
      this.evalExpr(showLastE);
      this.compatibilityWarning(e.line, "bgcolor() show_last is not supported; the background was not rendered");
    }
    const display = toStr(this.argVal(displayE, "all"));
    const id = `bgcolor_${e.id}`;
    let background = this.backgrounds.get(id);
    if (!background) {
      background = {
        id,
        title: toStr(this.argVal(titleE, "")) || "Background",
        offset,
        forceOverlay: this.truthy(this.argVal(forceOverlayE, false)),
        colors: [],
      };
      this.backgrounds.set(id, background);
      this.backgroundOrder.push(id);
    }
    if (this.inRange) {
      background.colors.push(showLastE === undefined && display !== "none" ? color : null);
    }
    return NaN;
  }

  private doBarColor(e: Extract<Expr, { k: "call" }>): PineValue {
    const [colorE, offsetE, , showLastE, titleE, displayE] = this.args(
      e, ["color", "offset", "editable", "show_last", "title", "display"]
    );
    const color = pineColor(this.argVal(colorE));
    const offset = Math.trunc(this.num(this.argVal(offsetE, 0), e.line));
    if (!Number.isFinite(offset) || Math.abs(offset) > 500) {
      throw new PineRuntimeError("barcolor offset must be between -500 and 500 bars", e.line);
    }
    if (showLastE !== undefined) {
      this.evalExpr(showLastE);
      this.compatibilityWarning(e.line, "barcolor() show_last is not supported; the override was not rendered");
    }
    const display = toStr(this.argVal(displayE, "all"));
    const id = `barcolor_${e.id}`;
    let barColor = this.barColors.get(id);
    if (!barColor) {
      barColor = {
        id,
        title: toStr(this.argVal(titleE, "")) || "Bar color",
        offset,
        colors: [],
      };
      this.barColors.set(id, barColor);
      this.barColorOrder.push(id);
    }
    if (this.inRange) {
      barColor.colors.push(showLastE === undefined && display !== "none" ? color : null);
    }
    return NaN;
  }

  private doOhlcPlot(
    path: "plotcandle" | "plotbar",
    e: Extract<Expr, { k: "call" }>
  ): PineValue {
    const names = path === "plotcandle"
      ? [
          "open", "high", "low", "close", "title", "color", "wickcolor", "editable",
          "show_last", "bordercolor", "display", "format", "precision", "force_overlay",
        ]
      : [
          "open", "high", "low", "close", "title", "color", "editable", "show_last",
          "display", "format", "precision", "force_overlay",
        ];
    const resolved = this.args(e, names);
    const [openE, highE, lowE, closeE, titleE, colorE] = resolved;
    const wickE = path === "plotcandle" ? resolved[6] : undefined;
    const showLastE = path === "plotcandle" ? resolved[8] : resolved[7];
    const borderE = path === "plotcandle" ? resolved[9] : undefined;
    const displayE = path === "plotcandle" ? resolved[10] : resolved[8];
    const precisionE = path === "plotcandle" ? resolved[12] : resolved[10];
    const forceOverlayE = path === "plotcandle" ? resolved[13] : resolved[11];
    const open = this.num(this.argVal(openE), e.line);
    const high = this.num(this.argVal(highE), e.line);
    const low = this.num(this.argVal(lowE), e.line);
    const close = this.num(this.argVal(closeE), e.line);
    const rawColor = colorE ? this.argVal(colorE) : undefined;
    const rawWick = wickE ? this.argVal(wickE) : rawColor;
    const rawBorder = borderE ? this.argVal(borderE) : rawColor;
    const display = toStr(this.argVal(displayE, "all"));
    if (showLastE !== undefined) {
      this.evalExpr(showLastE);
      this.compatibilityWarning(
        e.line,
        `${path}() show_last is not supported; the custom OHLC series was not rendered`
      );
    }

    const id = `${path}_${e.id}`;
    let plot = this.ohlcPlots.get(id);
    if (!plot && this.plotOrder.length + this.ohlcPlotOrder.length >= LIMITS.plots) {
      throw new PineRuntimeError(`a script may declare at most ${LIMITS.plots} plots`, e.line);
    }
    if (!plot) {
      const fallback = DEFAULT_COLORS[
        (this.plotOrder.length + this.ohlcPlotOrder.length) % DEFAULT_COLORS.length
      ]!;
      const precision = this.num(this.argVal(precisionE), e.line);
      if (Number.isFinite(precision) && this.meta.precision === null) {
        this.meta.precision = Math.max(0, Math.min(16, Math.trunc(precision)));
      }
      plot = {
        id,
        title: toStr(this.argVal(titleE, "")) || `${path === "plotcandle" ? "Candles" : "Bars"} ${this.ohlcPlotOrder.length + 1}`,
        style: path === "plotcandle" ? "candles" : "bars",
        color: pineColor(rawColor) ?? fallback,
        forceOverlay: this.truthy(this.argVal(forceOverlayE, false)),
        renderable: display !== "none" && showLastE === undefined,
        data: [],
        colors: [],
        wickColors: [],
        borderColors: [],
      };
      this.ohlcPlots.set(id, plot);
      this.ohlcPlotOrder.push(id);
    }
    if (this.inRange) {
      const valid = plot.renderable && display !== "none" &&
        [open, high, low, close].every(Number.isFinite);
      plot.data.push(valid ? { open, high, low, close } : null);
      plot.colors.push(valid ? (pineColor(rawColor) ?? plot.color) : null);
      plot.wickColors.push(valid ? (pineColor(rawWick) ?? pineColor(rawColor) ?? plot.color) : null);
      plot.borderColors.push(valid ? (pineColor(rawBorder) ?? pineColor(rawColor) ?? plot.color) : null);
    }
    return NaN;
  }

  private doPlotShape(e: Extract<Expr, { k: "call" }>): PineValue {
    const [seriesE, titleE, styleE, locationE, colorE, , textE] = this.args(
      e, ["series", "title", "style", "location", "color", "textcolor", "text"]
    );
    void titleE;
    if (!this.inRange) return NaN;
    if (!this.truthy(this.argVal(seriesE))) return NaN;
    const loc = toStr(this.argVal(locationE, "abovebar"));
    this.shapes.push({
      time: this.bars.time[this.i]! / 1000,
      position: loc.includes("below") ? "below" : "above",
      color: toStr(this.argVal(colorE, "")) || "#787b86",
      text: toStr(this.argVal(textE, "")),
      shape: toStr(this.argVal(styleE, "circle")),
    });
    return NaN;
  }

  // ── coercions ────────────────────────────────────────────────────────────
  private num(v: PineValue, line: number): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const n = Number(v);
      if (!Number.isNaN(n) && v.trim() !== "") return n;
      return NaN;
    }
    if (Array.isArray(v)) throw new PineRuntimeError("expected a single value, got a tuple", line);
    return NaN;
  }

  private truthy(v: PineValue): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return !Number.isNaN(v) && v !== 0;
    if (typeof v === "string") return v.length > 0;
    // A live object/collection handle is truthy; `na` (null) is not.
    if (isRef(v)) return true;
    return false;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function memberPath(e: Expr): string | null {
  if (e.k === "ident") return e.name;
  if (e.k === "member") {
    const base = memberPath(e.obj);
    return base ? `${base}.${e.name}` : null;
  }
  return null;
}

/** UTC bucket used by timeframe.change; Binance candle sessions are UTC. */
function timeframeBucket(raw: string, chart: Interval, time: number): number {
  const tf = raw.toUpperCase();
  const calendar = /^(\d+)?([DWM])$/.exec(tf);
  if (calendar) {
    const n = Math.max(1, Number(calendar[1] ?? 1));
    if (calendar[2] === "D") return Math.floor(time / (n * 86_400_000));
    if (calendar[2] === "W") {
      // 1970-01-01 was Thursday; +3 makes bucket boundaries Monday 00:00 UTC.
      return Math.floor((Math.floor(time / 86_400_000) + 3) / (n * 7));
    }
    const d = new Date(time);
    return Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / n);
  }
  const interval = raw === chart ? chart : pineTfToInterval(raw, chart);
  return Math.floor(time / INTERVAL_MS[interval]);
}

const SESSION_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * Common Pine session membership for Binance feeds. Binance's exchange
 * timezone is UTC; explicit IANA zones use Intl so DST transitions come from
 * the host timezone database instead of a fixed-offset approximation.
 */
function sessionContains(time: number, spec: string, timezone: string): boolean {
  if (!Number.isFinite(time)) return false;
  if (spec.toLowerCase() === "24x7") return true;
  const zone = timezone === "" || timezone.toLowerCase() === "exchange" ? "UTC" : timezone;
  let formatter = SESSION_FORMATTERS.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      // Force timezone validation now; some runtimes defer it until format().
      formatter.format(0);
    } catch {
      throw new Error(`unsupported time() timezone '${timezone}'`);
    }
    SESSION_FORMATTERS.set(zone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(time)).map((part) => [part.type, part.value])
  );
  const weekdays: Record<string, number> = {
    Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7,
  };
  const day = weekdays[parts.weekday ?? ""];
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (day === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`could not evaluate time() timezone '${timezone}'`);
  }
  const localMinute = (hour === 24 ? 0 : hour) * 60 + minute;
  const previousDay = day === 1 ? 7 : day - 1;

  for (const period of spec.split(",")) {
    const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::([1-7]+))?$/.exec(period.trim());
    if (!match) throw new Error(`unsupported time() session '${spec}'`);
    const startHour = Number(match[1]);
    const startMinute = Number(match[2]);
    const endHour = Number(match[3]);
    const endMinute = Number(match[4]);
    if (startHour > 23 || startMinute > 59 || endHour > 24 || endMinute > 59 ||
        (endHour === 24 && endMinute !== 0)) {
      throw new Error(`unsupported time() session '${spec}'`);
    }
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    const days = match[5] ?? "1234567";
    const allowed = (pineDay: number): boolean => days.includes(String(pineDay));
    if (start === end || (start === 0 && end === 1440)) {
      if (allowed(day)) return true;
    } else if (start < end) {
      if (allowed(day) && localMinute >= start && localMinute < end) return true;
    } else if (
      (localMinute >= start && allowed(day)) ||
      (localMinute < end && allowed(previousDay))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Apply Pine transparency to a colour, as #rrggbbaa. `transp` is 0 (opaque)
 * to 100 (invisible); an already-8-digit colour has its alpha replaced.
 */
function withAlpha(color: string, transp: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  const rgb = hex.length >= 6 ? hex.slice(0, 6)
    : hex.length === 3 ? hex.split("").map((c) => c + c).join("")
      : "787b86";
  const clamped = Math.max(0, Math.min(100, transp));
  if (clamped === 0) return `#${rgb}`;
  // Computed in integer space: `1 - 90/100` is 0.0999… in binary floating
  // point, which rounds a 90%-transparent colour to the wrong alpha.
  const alpha = Math.round(((100 - clamped) * 255) / 100);
  return `#${rgb}${alpha.toString(16).padStart(2, "0")}`;
}

/** Blend two #rrggbb colours; `t` of 0 is all `a`, 1 is all `b`. */
function mixHex(a: string, b: string, t: number): string {
  const parse = (h: string): [number, number, number] => {
    const s = h.replace("#", "");
    const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
    return [
      parseInt(full.slice(0, 2), 16) || 0,
      parseInt(full.slice(2, 4), 16) || 0,
      parseInt(full.slice(4, 6), 16) || 0,
    ];
  };
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const ch = (x: number, y: number): string =>
    Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

function last(arr: number[]): number {
  const v = arr[arr.length - 1];
  return v === undefined ? NaN : v;
}

function toStr(v: PineValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : String(v);
  if (typeof v === "boolean") return String(v);
  return "";
}

/** A Pine `na` colour hides a point; never hand an invalid token to canvas. */
function pineColor(v: PineValue | undefined): string | null {
  const color = toStr(v as PineValue).trim();
  if (!color || color === "NaN" || color.toLowerCase() === "na") return null;
  return color;
}

function looseEq(a: PineValue, b: PineValue): boolean {
  // References compare by identity — two arrays with equal contents are still
  // two different arrays, as in Pine.
  if (isRef(a) || isRef(b)) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  return toStr(a) === toStr(b);
}

/** Value a `type` field takes when neither an argument nor a default gives one. */
function defaultFieldValue(type: string): PineValue {
  switch (type) {
    case "int": case "float": return NaN;
    case "bool": return false;
    case "string": return "";
    // Collections and drawing handles start as na, not as empty containers.
    default: return null;
  }
}

function inferKind(v: PineValue): PineInputDef["type"] {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "string";
  return Number.isInteger(v as number) ? "int" : "float";
}

function normaliseStyle(s: string): PinePlot["style"] {
  const v = s.toLowerCase();
  if (v.includes("histogram")) return "histogram";
  if (v.includes("column")) return "columns";
  if (v.includes("circle")) return "circles";
  if (v.includes("cross")) return "cross";
  if (v.includes("stepline")) return "stepline";
  if (v.includes("area")) return "area";
  return "line";
}
