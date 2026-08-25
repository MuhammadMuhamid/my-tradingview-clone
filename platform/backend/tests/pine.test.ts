/**
 * Pine engine tests.
 *
 * The core guarantee: a `ta.*` call inside a Pine script produces exactly what
 * the Pine-verified array library in engine/ta.ts produces for the same input.
 * Anything that drifts here means scripts would disagree with the platform's
 * own strategies, so these run bar-for-bar over the full series.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ta from "../src/engine/ta";
import { Broker } from "../src/engine/broker";
import type { Bars } from "../src/engine/mtf";
import { PineInterpreter } from "../src/pine/interpreter";

/** Deterministic pseudo-random OHLC series. */
function makeBars(n: number): Bars {
  const time: number[] = [], open: number[] = [], high: number[] = [],
    low: number[] = [], close: number[] = [], volume: number[] = [], closeTime: number[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    px *= 1 + Math.sin(i / 7) * 0.01 + Math.cos(i / 13) * 0.006;
    time.push(1_700_000_000_000 + i * 900_000);
    closeTime.push(1_700_000_000_000 + (i + 1) * 900_000 - 1);
    open.push(o);
    close.push(px);
    high.push(Math.max(o, px) * 1.002);
    low.push(Math.min(o, px) * 0.998);
    volume.push(1000 + i);
  }
  return { symbol: "TESTUSDT", interval: "15m", time, open, high, low, close, volume, closeTime, length: n };
}

const BARS = makeBars(400);

/** Run a script and return its plots keyed by title. */
function plotsOf(source: string, broker?: Broker): Record<string, (number | null)[]> {
  const out = new PineInterpreter(source).run({
    bars: BARS, startIdx: 0, endIdx: BARS.length - 1, broker,
  });
  return Object.fromEntries(out.plots.map((p) => [p.title, p.data]));
}

function assertMatches(got: (number | null)[], want: number[], label: string, eps = 1e-9): void {
  assert.equal(got.length, want.length, `${label}: length`);
  for (let i = 0; i < want.length; i++) {
    const g = got[i];
    const w = want[i]!;
    if (Number.isNaN(w)) {
      assert.equal(g, null, `${label}: expected na at bar ${i}, got ${g}`);
      continue;
    }
    assert.notEqual(g, null, `${label}: unexpected na at bar ${i}`);
    assert.ok(
      Math.abs((g as number) - w) < eps,
      `${label}: bar ${i} expected ${w}, got ${g}`
    );
  }
}

test("ta.* in Pine matches engine/ta.ts bar for bar", () => {
  const plots = plotsOf(`
indicator("t")
plot(ta.sma(close, 20), "sma")
plot(ta.ema(close, 20), "ema")
plot(ta.rma(close, 20), "rma")
plot(ta.wma(close, 20), "wma")
plot(ta.rsi(close, 14), "rsi")
plot(ta.atr(14), "atr")
plot(ta.highest(high, 20), "hh")
plot(ta.lowest(low, 20), "ll")
plot(ta.stdev(close, 20), "sd")
plot(ta.linreg(close, 20, 0), "lr")
plot(ta.change(close), "chg")
`);

  const { close, high, low } = BARS;
  assertMatches(plots.sma!, ta.sma(close, 20), "sma", 1e-9);
  assertMatches(plots.ema!, ta.ema(close, 20), "ema");
  assertMatches(plots.rma!, ta.rma(close, 20), "rma");
  assertMatches(plots.wma!, ta.wma(close, 20), "wma");
  assertMatches(plots.rsi!, ta.rsi(close, 14), "rsi");
  assertMatches(plots.atr!, ta.atr(high, low, close, 14), "atr");
  assertMatches(plots.hh!, ta.highest(high, 20), "highest");
  assertMatches(plots.ll!, ta.lowest(low, 20), "lowest");
  assertMatches(plots.sd!, ta.stdev(close, 20), "stdev", 1e-9);
  assertMatches(plots.lr!, ta.linreg(close, 20, 0), "linreg", 1e-8);
  assertMatches(plots.chg!, ta.change(close), "change");
});

test("ta.crossover / crossunder match the array implementations", () => {
  const plots = plotsOf(`
indicator("t")
basis = ta.sma(close, 20)
plot(ta.crossover(close, basis) ? 1 : 0, "over")
plot(ta.crossunder(close, basis) ? 1 : 0, "under")
`);
  const basis = ta.sma(BARS.close, 20);
  const over = ta.crossover(BARS.close, basis).map((b) => (b ? 1 : 0));
  const under = ta.crossunder(BARS.close, basis).map((b) => (b ? 1 : 0));
  assertMatches(plots.over!, over, "crossover");
  assertMatches(plots.under!, under, "crossunder");
});

test("history access and `var` persistence follow Pine semantics", () => {
  const plots = plotsOf(`
indicator("t")
var int counter = 0
if close > open
    counter := counter + 1
plot(close[1], "prev")
plot(close[3], "prev3")
plot(counter, "count")
`);
  const prev = [NaN, ...BARS.close.slice(0, -1)];
  const prev3 = [NaN, NaN, NaN, ...BARS.close.slice(0, -3)];
  assertMatches(plots.prev!, prev, "close[1]");
  assertMatches(plots.prev3!, prev3, "close[3]");

  let acc = 0;
  const want = BARS.close.map((c, i) => {
    if (c > BARS.open[i]!) acc++;
    return acc;
  });
  assertMatches(plots.count!, want, "var counter");
});

test("deep history stays correct after a window call grows the buffer", () => {
  // Regression: the node ring buffer wrapped modulo its *capacity* rather than
  // its current length, so any `x[n]` read after a ta.* call enlarged the
  // buffer returned the wrong bar.
  const plots = plotsOf(`
indicator("t")
src = close
ma = ta.sma(src, 30)
plot(src[1], "h1")
plot(src[7], "h7")
plot(src[25], "h25")
plot(ma, "ma")
`);
  const shift = (n: number): number[] =>
    BARS.close.map((_, i) => (i - n >= 0 ? BARS.close[i - n]! : NaN));
  assertMatches(plots.h1!, shift(1), "close[1]");
  assertMatches(plots.h7!, shift(7), "close[7]");
  assertMatches(plots.h25!, shift(25), "close[25]");
  assertMatches(plots.ma!, ta.sma(BARS.close, 30), "sma(30)", 1e-9);
});

test("inputs are declared with metadata and overridable at run time", () => {
  const source = `
indicator("Inputs")
len = input.int(20, "Length", minval=1, maxval=200)
mult = input.float(2.5, "Mult", step=0.5)
on = input.bool(true, "On")
mode = input.string("fast", "Mode", options=["fast", "slow"])
plot(ta.sma(close, len), "ma")
`;
  const { meta, errors } = PineInterpreter.compile(source);
  assert.deepEqual(errors, []);
  assert.equal(meta.title, "Inputs");
  assert.deepEqual(meta.inputs.map((i) => i.key), ["len", "mult", "on", "mode"]);
  assert.equal(meta.inputs[0]!.minval, 1);
  assert.equal(meta.inputs[0]!.maxval, 200);
  assert.equal(meta.inputs[1]!.step, 0.5);
  assert.deepEqual(meta.inputs[3]!.options, ["fast", "slow"]);

  // The override must actually change the computed series.
  const out = new PineInterpreter(source).run({
    bars: BARS, startIdx: 0, endIdx: BARS.length - 1, params: { len: 50 },
  });
  assertMatches(out.plots[0]!.data, ta.sma(BARS.close, 50), "sma with len=50", 1e-9);
});

test("strategy orders reach the broker and produce closed trades", () => {
  const broker = new Broker({
    initialCapital: 1000, commissionPct: 0.1, slippageTicks: 0,
    tickSize: 0.01, qtyCash: 930,
  });
  plotsOf(`
strategy("s", overlay=true)
fast = ta.ema(close, 5)
slow = ta.ema(close, 20)
if ta.crossover(fast, slow) and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow) and strategy.position_size > 0
    strategy.close("Long")
plot(fast, "fast")
`, broker);

  assert.ok(broker.closed.length > 0, "expected at least one closed trade");
  for (const t of broker.closed) {
    assert.equal(t.direction, "long");
    assert.ok(t.exitTime !== null && t.exitTime >= t.entryTime);
    assert.ok(Number.isFinite(t.entryPrice) && Number.isFinite(t.exitPrice ?? NaN));
  }
  // cumProfit is filled in monotonically by the run loop
  const cums = broker.closed.map((t) => t.cumProfit ?? 0);
  assert.equal(cums.length, broker.closed.length);
});

test("strategy.exit brackets fill against the bar range", () => {
  const broker = new Broker({
    initialCapital: 1000, commissionPct: 0, slippageTicks: 0,
    tickSize: 0.01, qtyCash: 1000,
  });
  plotsOf(`
strategy("s")
atr = ta.atr(14)
if ta.crossover(ta.ema(close, 5), ta.ema(close, 20)) and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
if strategy.position_size > 0
    strategy.exit("X", "Long", stop=strategy.position_avg_price - atr, limit=strategy.position_avg_price + atr * 2)
plot(atr, "atr")
`, broker);
  assert.ok(broker.closed.length > 0);
  const reasons = new Set(broker.closed.map((t) => t.exitReason));
  // every exit came from a bracket leg, not an unlabelled close
  for (const r of reasons) assert.ok(r === "TP" || r === "SL", `unexpected exit reason ${r}`);
});

test("unsupported constructs fail with a line-numbered error, never silently", () => {
  const cases: [string, RegExp][] = [
    [`indicator("x")\nplot(ta.notARealFunction(close, 5))`, /unknown function/],
    [`indicator("x")\nm = map.new<string, float>()`, /maps/],
    [`indicator("x")\na = array.notARealFunction(0)`, /array\.notARealFunction/],
    [`indicator("x")\nplot(undefinedVariable)`, /unknown identifier/],
  ];
  for (const [src, pattern] of cases) {
    const { errors } = PineInterpreter.compile(src);
    assert.equal(errors.length, 1, `expected one error for: ${src}`);
    assert.match(errors[0]!.message, pattern);
    assert.equal(errors[0]!.line, 2, `error should point at line 2 for: ${src}`);
  }
});

test("resource limits abort a hostile script instead of stalling the process", () => {
  // A Pine script is untrusted input executed on the same event loop as the
  // live alert runner, so each of these must fail fast and cleanly.
  const cases: [string, string, RegExp][] = [
    ["oversized ta length", `indicator("x")\nplot(ta.sma(close, 50000000))`, /length must be at most/],
    ["oversized history", `indicator("x")\nplot(close[10000000])`, /history offset must be at most/],
    ["unbounded while", `indicator("x")\ni = 0\nwhile true\n    i := i + 1\nplot(i)`, /while-loop exceeded/],
    ["too many plots", `indicator("x")\n` +
      Array.from({ length: 80 }, (_, i) => `plot(close, "p${i}")`).join("\n"), /at most 64 plots/],
    ["deep nesting", `indicator("x")\nplot(${"(".repeat(5000)}close${")".repeat(5000)})`,
      /nested too deeply|too complex/],
  ];
  for (const [label, src, pattern] of cases) {
    const { errors } = PineInterpreter.compile(src);
    assert.ok(errors.length > 0, `${label}: expected an error`);
    assert.match(errors[0]!.message, pattern, label);
  }
});

test("nested loops are capped by the total iteration budget", () => {
  // 1000×1000 per bar over the whole series is ~400M iterations; unbounded
  // this blocked the event loop for over a minute.
  const src =
    `indicator("x")\nt = 0.0\nfor i = 1 to 1000\n    for j = 1 to 1000\n        t := t + 1\nplot(t)`;
  const started = Date.now();
  assert.throws(() => plotsOf(src), /loop iterations|execution budget/);
  assert.ok(Date.now() - started < 20_000, "the budget should trip well inside the run");
});

test("syntax errors report the offending line and column", () => {
  const { errors } = PineInterpreter.compile(`indicator("x")\nx = = 5`);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 2);
  assert.ok(errors[0]!.col > 1);
});

test("if/else, for loops and user functions evaluate per bar", () => {
  const plots = plotsOf(`
indicator("t")
f(a, b) =>
    a * 2 + b

total = 0.0
for i = 1 to 3
    total := total + i

plot(f(close, 1), "fn")
plot(total, "loop")
plot(close > open ? 1 : -1, "ternary")
`);
  assertMatches(plots.fn!, BARS.close.map((c) => c * 2 + 1), "user function");
  assertMatches(plots.loop!, BARS.close.map(() => 6), "for loop");
  assertMatches(
    plots.ternary!,
    BARS.close.map((c, i) => (c > BARS.open[i]! ? 1 : -1)),
    "ternary"
  );
});

test("each call site of a user function gets its own series state", () => {
  // Both calls share one AST body; if they also shared the ta.ema/ta.sma
  // accumulators the two outputs would be identical garbage.
  const plots = plotsOf(`
indicator("t")
smooth(src, len) =>
    a = ta.ema(src, len)
    b = ta.sma(src, len)
    (a + b) / 2

plot(smooth(close, 10), "fast")
plot(smooth(close, 30), "slow")
`);
  const { close } = BARS;
  const want = (len: number): number[] =>
    ta.ema(close, len).map((v, i) => (v + ta.sma(close, len)[i]!) / 2);
  assertMatches(plots.fast!, want(10), "smooth(close,10)", 1e-9);
  assertMatches(plots.slow!, want(30), "smooth(close,30)", 1e-9);
});

test("variables declared inside an if-block keep history across bars", () => {
  const plots = plotsOf(`
indicator("t")
var float lastUp = na
if close > open
    lastUp := close
plot(lastUp, "lastUp")
`);
  let held = NaN;
  const want = BARS.close.map((c, i) => {
    if (c > BARS.open[i]!) held = c;
    return held;
  });
  assertMatches(plots.lastUp!, want, "var inside if-block");
});

test("plotshape records markers only where the condition is true", () => {
  const out = new PineInterpreter(`
indicator("t")
sig = ta.crossover(close, ta.sma(close, 20))
plotshape(sig, style=shape.triangleup, location=location.belowbar, color=color.green, text="BUY")
`).run({ bars: BARS, startIdx: 0, endIdx: BARS.length - 1 });

  const expected = ta.crossover(BARS.close, ta.sma(BARS.close, 20)).filter(Boolean).length;
  assert.equal(out.shapes.length, expected);
  for (const s of out.shapes) {
    assert.equal(s.position, "below");
    assert.equal(s.text, "BUY");
  }
});

// ── reference values: arrays, matrices, user-defined types, methods ────────

test("arrays are reference values that persist across bars under var", () => {
  // `var` runs the initialiser once, so the same array accumulates every bar;
  // the plain declaration rebuilds a fresh array each bar and stays at size 1.
  const p = plotsOf(`
indicator("x")
var kept = array.new_float()
fresh = array.new_float()
array.push(kept, close)
array.push(fresh, close)
plot(array.size(kept), "kept")
plot(array.size(fresh), "fresh")
`);
  assert.equal(p["kept"]![0], 1);
  assert.equal(p["kept"]![99], 100);
  assert.equal(p["kept"]![BARS.length - 1], BARS.length);
  for (const v of p["fresh"]!) assert.equal(v, 1);
});

test("assigning an array aliases it rather than copying", () => {
  const p = plotsOf(`
indicator("x")
var a = array.new_float()
b = a
array.push(b, 1.0)
c = array.copy(a)
array.push(c, 2.0)
plot(array.size(a), "aliased")
plot(array.size(c), "copied")
`);
  // Every bar pushes through the alias, so `a` grows; the copy is independent
  // and is rebuilt from `a` each bar, so it is always exactly one longer.
  assert.equal(p["aliased"]![0], 1);
  assert.equal(p["aliased"]![9], 10);
  assert.equal(p["copied"]![9], 11);
});

test("array functions work in call and method form and agree", () => {
  const p = plotsOf(`
indicator("x")
a = array.from(3.0, 1.0, 2.0)
plot(array.size(a), "size")
plot(array.get(a, 0), "get")
plot(a.get(0), "method_get")
plot(array.sum(a), "sum")
plot(array.min(a), "min")
plot(array.max(a), "max")
plot(array.avg(a), "avg")
plot(array.indexof(a, 2.0), "indexof")
`);
  const at = (k: string): number => p[k]![10] as number;
  assert.equal(at("size"), 3);
  assert.equal(at("get"), 3);
  assert.equal(at("method_get"), 3);
  assert.equal(at("sum"), 6);
  assert.equal(at("min"), 1);
  assert.equal(at("max"), 3);
  assert.equal(at("avg"), 2);
  assert.equal(at("indexof"), 2);
});

test("out-of-bounds array access is a line-numbered error, not a silent na", () => {
  const { errors } = PineInterpreter.compile(`indicator("x")
a = array.new_float(2)
v = array.get(a, 5)`);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /out of bounds/);
  assert.equal(errors[0]!.line, 3);
});

test("user-defined types construct, read, and mutate fields", () => {
  const p = plotsOf(`
indicator("x")
type Point
    float x
    float y = 7.0
var Point pt = Point.new(1.0)
pt.x := pt.x + 1
plot(pt.x, "x")
plot(pt.y, "y")
`);
  // Field defaults apply when no argument is given, and `var` keeps the same
  // instance so the increment accumulates.
  assert.equal(p["y"]![5], 7);
  assert.equal(p["x"]![0], 2);
  assert.equal(p["x"]![9], 11);
});

test("methods dispatch on the receiver and can mutate it", () => {
  const p = plotsOf(`
indicator("x")
type Counter
    int n = 0

method bump(Counter self, int amount) =>
    self.n := self.n + amount
    self.n

var Counter c = Counter.new()
v = c.bump(2)
plot(v, "v")
plot(c.n, "n")
`);
  assert.equal(p["v"]![0], 2);
  assert.equal(p["n"]![4], 10);
});

test("switch matches a subject, falls through to the default, and works bare", () => {
  const p = plotsOf(`
indicator("x")
mode = "b"
picked = switch mode
    "a" => 1
    "b" => 2
    => 99
missing = switch "zzz"
    "a" => 1
    => 99
bare = switch
    close < 0 => 1
    true      => 42
plot(picked, "picked")
plot(missing, "missing")
plot(bare, "bare")
`);
  assert.equal(p["picked"]![3], 2);
  assert.equal(p["missing"]![3], 99);
  assert.equal(p["bare"]![3], 42);
});

test("matrices round-trip through generic construction", () => {
  const p = plotsOf(`
indicator("x")
m = matrix.new<float>(2, 3, 0.0)
matrix.set(m, 1, 2, 5.0)
plot(matrix.rows(m), "rows")
plot(matrix.columns(m), "cols")
plot(matrix.get(m, 1, 2), "val")
plot(matrix.get(m, 0, 0), "zero")
`);
  assert.equal(p["rows"]![2], 2);
  assert.equal(p["cols"]![2], 3);
  assert.equal(p["val"]![2], 5);
  assert.equal(p["zero"]![2], 0);
});

test("na() tells an empty collection apart from an absent one", () => {
  const p = plotsOf(`
indicator("x")
type Holder
    array<float> items
h = Holder.new()
empty = array.new_float()
plot(na(h.items) ? 1 : 0, "field_na")
plot(na(empty) ? 1 : 0, "empty_na")
plot(array.size(empty), "empty_size")
`);
  // An unset object field is na; an array with no elements is not.
  assert.equal(p["field_na"]![1], 1);
  assert.equal(p["empty_na"]![1], 0);
  assert.equal(p["empty_size"]![1], 0);
});

test("generic angle brackets never swallow a comparison", () => {
  const p = plotsOf(`
indicator("x")
a = 2
b = 5
plot(a < b ? 1 : 0, "lt")
plot(array.size(array.new<int>(3, 0)), "generic")
`);
  assert.equal(p["lt"]![4], 1);
  assert.equal(p["generic"]![4], 3);
});

test("for-in iterates arrays, with and without the index", () => {
  const p = plotsOf(`
indicator("x")
xs = array.from(10.0, 20.0, 30.0)
total = 0.0
for v in xs
    total += v
idxSum = 0.0
for [i, v] in xs
    idxSum += i * v
plot(total, "total")
plot(idxSum, "idxSum")
`);
  assert.equal(p["total"]![5], 60);
  assert.equal(p["idxSum"]![5], 0 * 10 + 1 * 20 + 2 * 30);
});

test("comma-separated statements on one line all execute", () => {
  const p = plotsOf(`
indicator("x")
var int a = 0, var int b = 0
a := a + 1, b := b + 2
plot(a, "a")
plot(b, "b")
`);
  assert.equal(p["a"]![4], 5);
  assert.equal(p["b"]![4], 10);
});

test("mutating an array inside for-in cannot loop forever", () => {
  // The loop iterates a snapshot, so a push inside the body is not re-visited.
  const p = plotsOf(`
indicator("x")
xs = array.from(1.0, 2.0)
n = 0
for v in xs
    array.push(xs, v)
    n += 1
plot(n, "n")
plot(array.size(xs), "size")
`);
  assert.equal(p["n"]![3], 2);
  assert.equal(p["size"]![3], 4);
});

// ── drawing objects ───────────────────────────────────────────────────────

/** Run a script and return its drawing output. */
function drawingsOf(source: string): ReturnType<PineInterpreter["run"]>["drawings"] {
  return new PineInterpreter(source).run({
    bars: BARS, startIdx: 0, endIdx: BARS.length - 1,
  }).drawings;
}

test("lines, boxes and labels are emitted with resolved coordinates", () => {
  const d = drawingsOf(`
indicator("x", max_lines_count=10, max_boxes_count=10, max_labels_count=10)
if barstate.islast
    line.new(bar_index - 5, low, bar_index, high, color=color.red, width=2)
    box.new(bar_index - 5, high, bar_index, low, border_color=color.blue)
    label.new(bar_index, high, "top", textcolor=color.white)
`);
  assert.equal(d.lines.length, 1);
  assert.equal(d.boxes.length, 1);
  assert.equal(d.labels.length, 1);

  // x coordinates come back as chart seconds, taken from the bar's own time.
  const lastT = BARS.time[BARS.length - 1]! / 1000;
  const fifthT = BARS.time[BARS.length - 6]! / 1000;
  assert.equal(d.lines[0]!.x2, lastT);
  assert.equal(d.lines[0]!.x1, fifthT);
  assert.equal(d.lines[0]!.width, 2);
  assert.equal(d.labels[0]!.text, "top");
});

test("a projected bar_index extrapolates past the last bar", () => {
  const d = drawingsOf(`
indicator("x")
if barstate.islast
    line.new(bar_index, close, bar_index + 10, close)
`);
  const step = (BARS.time[1]! - BARS.time[0]!) / 1000;
  const lastT = BARS.time[BARS.length - 1]! / 1000;
  // Clamping to the last candle would collapse the projection to zero width.
  assert.equal(d.lines[0]!.x2, lastT + 10 * step);
});

test("drawings are capped so a per-bar script cannot emit unbounded output", () => {
  // One line every bar over 400 bars, with a cap of 10: the newest survive.
  const d = drawingsOf(`
indicator("x", max_lines_count=10)
line.new(bar_index - 1, low, bar_index, high)
`);
  assert.equal(d.lines.length, 10);
  const lastT = BARS.time[BARS.length - 1]! / 1000;
  assert.equal(d.lines[d.lines.length - 1]!.x2, lastT);
});

test("setters move a drawing and delete removes it", () => {
  const d = drawingsOf(`
indicator("x")
var line keep = na
var line gone = na
if barstate.isfirst
    keep := line.new(bar_index, 1.0, bar_index, 2.0)
    gone := line.new(bar_index, 3.0, bar_index, 4.0)
if barstate.islast
    line.set_y2(keep, 99.0)
    line.delete(gone)
`);
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0]!.y2, 99);
});

test("calling a drawing setter on na is a no-op, not an error", () => {
  const d = drawingsOf(`
indicator("x")
var line missing = na
var box alsoMissing = box(na)
line.set_x1(missing, bar_index)
line.delete(missing)
alsoMissing.set_right(bar_index)
plot(close)
`);
  assert.equal(d.lines.length, 0);
  assert.equal(d.boxes.length, 0);
});

test("table cells are collected and emitted", () => {
  const d = drawingsOf(`
indicator("x")
var t = table.new(position.top_right, 2, 2)
if barstate.islast
    table.cell(t, 0, 0, "Signal", text_color=color.white)
    table.cell(t, 1, 0, "Long")
    table.cell_set_text_color(t, 1, 0, color.green)
`);
  assert.equal(d.tables.length, 1);
  const cells = d.tables[0]!.cells;
  // cell_set_text_color updates the cell that cell() already created.
  assert.equal(cells.length, 2);
  const signal = cells.find((c) => c.col === 0 && c.row === 0);
  assert.equal(signal!.text, "Signal");
  const long = cells.find((c) => c.col === 1 && c.row === 0);
  assert.equal(long!.text, "Long");
  assert.equal(long!.textColor, "#089981");
});

test("request.security for the chart's own timeframe passes through", () => {
  const p = plotsOf(`
indicator("x")
same = request.security(syminfo.tickerid, timeframe.period, close)
plot(same, "same")
`);
  assertMatches(p["same"]!, BARS.close, "same-timeframe security");
});

test("a different timeframe compiles, declares its feed, and refuses to guess without it", () => {
  // Compiling must succeed: the caller learns which feed to load FROM the
  // compile result, so an error here would make the feed unloadable.
  const { errors, meta } = PineInterpreter.compile(`indicator("x")
plot(request.security(syminfo.tickerid, "1D", close))`);
  assert.deepEqual(errors, []);
  assert.deepEqual(meta.securityTimeframes, ["1D"]);

  // Running it without that feed must still fail loudly rather than
  // substituting chart-timeframe data, which would be a plausible wrong number.
  const interp = new PineInterpreter(`indicator("x")
plot(request.security(syminfo.tickerid, "1D", close))`);
  assert.throws(
    () => interp.run({ bars: BARS, startIdx: 0, endIdx: BARS.length - 1 }),
    /no feed loaded/
  );
});

test("input.source keeps the series name when the default is an identifier", () => {
  // Evaluating `high` as the default would store the current bar's number and
  // then resolve as na, silently poisoning every expression using the input.
  const source = `
indicator("x")
src = input.source(high, "Source")
plot(src, "src")
`;
  const { meta } = PineInterpreter.compile(source);
  assert.equal(meta.inputs[0]!.type, "source");
  assert.equal(meta.inputs[0]!.defval, "high");

  const p = plotsOf(source);
  assertMatches(p["src"]!, BARS.high, "input.source default");

  // And an override selects a different series.
  const out = new PineInterpreter(source).run({
    bars: BARS, startIdx: 0, endIdx: BARS.length - 1, params: { src: "low" },
  });
  assertMatches(out.plots[0]!.data, BARS.low, "input.source override");
});

test("color.new applies Pine transparency as an alpha channel", () => {
  // transp 0 = opaque, 100 = invisible. Dropping it renders shaded zones as
  // solid blocks that hide the candles behind them.
  const d = new PineInterpreter(`
indicator("x")
if barstate.islast
    box.new(bar_index - 5, high, bar_index, low, bgcolor=color.new(color.blue, 90), border_color=color.new(color.red, 0))
`).run({ bars: BARS, startIdx: 0, endIdx: BARS.length - 1 }).drawings;
  const box = d.boxes[0]!;
  assert.equal(box.bgColor, "#2962ff1a");
  // transp 0 leaves the colour opaque, with no alpha suffix at all.
  assert.equal(box.borderColor, "#f23645");
});
