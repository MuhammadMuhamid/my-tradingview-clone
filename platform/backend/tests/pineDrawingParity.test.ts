/**
 * Pine drawings behave as TradingView draws them.
 *
 * Every case here was a script on the user's chart that drew differently, or
 * not at all: ChartPrime's "SR Breaks and Retests" built its boxes from
 * `chart.point`s, which this engine dropped, so the chart showed the labels
 * and none of the boxes; method-form setters (`b.set_right(x)`) were silent
 * no-ops; a `color.from_gradient` out of `color(na)` came back opaque black.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bars } from "../src/engine/mtf";
import { PineInterpreter } from "../src/pine/interpreter";

function makeBars(n: number, interval: Bars["interval"] = "15m", stepMs = 900_000): Bars {
  const time: number[] = [], open: number[] = [], high: number[] = [],
    low: number[] = [], close: number[] = [], volume: number[] = [], closeTime: number[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    px *= 1 + Math.sin(i / 7) * 0.01 + Math.cos(i / 13) * 0.006;
    time.push(1_700_000_000_000 + i * stepMs);
    closeTime.push(1_700_000_000_000 + (i + 1) * stepMs - 1);
    open.push(o); close.push(px);
    high.push(Math.max(o, px) * 1.002); low.push(Math.min(o, px) * 0.998);
    volume.push(1000 + i);
  }
  return { symbol: "TESTUSDT", interval, time, open, high, low, close, volume, closeTime, length: n };
}

const BARS = makeBars(300);
const run = (src: string, bars: Bars = BARS) =>
  new PineInterpreter(src).run({ bars, startIdx: 0, endIdx: bars.length - 1 });
const sec = (i: number, bars: Bars = BARS) => Math.round(bars.time[i]! / 1000);

test("method-form setters move the drawing, and delete removes it", () => {
  const out = run(`
//@version=6
indicator("m", overlay = true)
var box a = na
var box gone = na
if bar_index == 100
    a := box.new(bar_index - 5, high, bar_index, low, text = "a")
    gone := box.new(bar_index - 5, high, bar_index, low, text = "gone")
if bar_index > 100
    a.set_right(bar_index)
    a.set_bgcolor(color.red)
if bar_index == 150
    gone.delete()
`);
  const boxes = out.drawings.boxes;
  assert.deepEqual(boxes.map((b) => b.text), ["a"]);
  assert.equal(boxes[0]!.right, sec(BARS.length - 1));
  assert.equal(boxes[0]!.bgColor, "#f23645");
});

test("a box held in a user type is the same box: setters and delete reach it", () => {
  const out = run(`
//@version=6
indicator("u", overlay = true)
type zone
    box bx
var array<zone> zs = array.new<zone>()
if bar_index % 20 == 0
    zs.push(zone.new(box.new(bar_index - 2, high, bar_index, low)))
while zs.size() > 3
    zone z = zs.shift()
    z.bx.delete()
if zs.size() > 0
    for i = 0 to zs.size() - 1
        zone z = zs.get(i)
        z.bx.set_right(bar_index + 1)
`);
  assert.equal(out.drawings.boxes.length, 3);
  for (const b of out.drawings.boxes) assert.equal(b.right, sec(BARS.length - 1) + 900);
});

test("box.new / line.new / label.new take chart.point arguments", () => {
  const out = run(`
//@version=6
indicator("p", overlay = true)
if bar_index == 200
    tl = chart.point.from_index(bar_index - 20, 120.0)
    br = chart.point.from_index(bar_index, 110.0)
    box.new(top_left = tl, bottom_right = br, border_color = color.green, text = "named")
    box.new(chart.point.from_index(bar_index - 10, 130.0), chart.point.from_index(bar_index, 125.0), text = "positional")
    line.new(chart.point.from_time(time[5], 101.0), chart.point.now(102.0), color = color.blue)
    label.new(chart.point.from_index(bar_index, 105.0), "pt")
    label.new(bar_index, 104.0, text = "plain")
`);
  const byText = new Map(out.drawings.boxes.map((b) => [b.text, b]));
  const named = byText.get("named")!;
  assert.equal(named.left, sec(180));
  assert.equal(named.right, sec(200));
  assert.equal(named.top, 120);
  assert.equal(named.bottom, 110);
  assert.equal(byText.get("positional")!.top, 130);
  const line = out.drawings.lines[0]!;
  assert.equal(line.x1, sec(195));
  assert.equal(line.x2, sec(200));
  assert.equal(line.y2, 102);
  const labels = new Map(out.drawings.labels.map((l) => [l.text, l]));
  assert.equal(labels.get("pt")!.y, 105);
  assert.equal(labels.get("plain")!.y, 104, "a label named text= is not mistaken for the point form");
});

test("color.from_gradient keeps alpha, and an na end fades to transparent", () => {
  const out = run(`
//@version=6
indicator("g", overlay = true)
if bar_index == 10
    box.new(0, 1, 1, 0, bgcolor = color.from_gradient(0, 0, 10, color(na), color.new(color.green, 30)), text = "zero")
    box.new(0, 1, 1, 0, bgcolor = color.from_gradient(5, 0, 10, color(na), color.new(color.green, 30)), text = "half")
    box.new(0, 1, 1, 0, bgcolor = color.from_gradient(10, 0, 10, color(na), color.new(color.green, 30)), text = "top")
`);
  const bg = new Map(out.drawings.boxes.map((b) => [b.text, b.bgColor]));
  assert.equal(bg.get("zero"), "", "fully transparent is na — no fill");
  assert.equal(bg.get("top"), "#089981b3");
  assert.equal(bg.get("half"), "#0899815a");
});

test("box text keeps Pine's centred default and the script's alignment", () => {
  const out = run(`
//@version=6
indicator("t", overlay = true)
if bar_index == 10
    box.new(0, 1, 1, 0, text = "c")
    box.new(0, 1, 1, 0, text = "r", text_halign = text.align_right, text_size = size.small, extend = extend.both)
`);
  const [c, r] = out.drawings.boxes;
  assert.equal(c!.textHalign, "center");
  assert.equal(c!.textValign, "center");
  assert.equal(r!.textHalign, "align_right");
  assert.equal(r!.textSize, "small");
  assert.equal(r!.extend, "both");
});

test("plotchar draws its own character at the offset bar, against high or low", () => {
  const out = run(`
//@version=6
indicator("c", overlay = true)
plotchar(bar_index == 50, "hold", "◆", location = location.belowbar, color = #20ca26, size = size.tiny, offset = -1)
plotshape(bar_index == 60, "d", shape.diamond, location.abovebar, color.red)
plotshape(bar_index == 70, "u", shape.triangleup, location.belowbar, color.green)
`);
  const [hold, diamond, tri] = out.shapes;
  assert.equal(hold!.char, "◆");
  assert.equal(hold!.time, sec(49), "offset = -1 marks the bar before");
  assert.equal(hold!.price, BARS.low[49]);
  assert.equal(hold!.size, "tiny");
  assert.equal(diamond!.char, "◆");
  assert.equal(diamond!.price, BARS.high[60]);
  assert.equal(tri!.char, undefined, "a shape the chart's markers draw stays a marker");
});

test("yloc.abovebar / belowbar labels sit on the bar's high / low", () => {
  const out = run(`
//@version=6
indicator("y", overlay = true)
if bar_index == 80
    label.new(bar_index, 0, "a", yloc = yloc.abovebar)
    label.new(time, 0, "b", xloc = xloc.bar_time, yloc = yloc.belowbar)
`);
  const byText = new Map(out.drawings.labels.map((l) => [l.text, l]));
  assert.equal(byText.get("a")!.y, BARS.high[80]);
  assert.equal(byText.get("b")!.y, BARS.low[80]);
});

test("request.security on the chart's own timeframe spelled as Pine spells it", () => {
  const hourly = makeBars(200, "1h", 3_600_000);
  const out = new PineInterpreter(`
//@version=6
indicator("s")
plot(request.security(syminfo.tickerid, "60", close), "c")
`).run({ bars: hourly, startIdx: 0, endIdx: hourly.length - 1 });
  assert.deepEqual(out.plots[0]!.data.slice(-3), hourly.close.slice(-3));
});
