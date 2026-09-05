/**
 * A live tick may never touch bars that are not its own.
 *
 * The mechanism this pins: after a symbol change the previous window stays on
 * screen while the next one loads; the new symbol's feed is subscribed at
 * once; its first frame arrives before the history. Drawn onto the old bars
 * it lands at the same open time as the old forming bar, so the chart shows
 * SOL's price as BTC's last candle and the autoscale spans both regimes.
 *
 * The second half pins the boundary repaint: at every bar close on a full
 * window the state is trimmed on the left, and the planners used to see that
 * as "everything changed" and repaint 10,000 points per pane per series.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { datasetKey, LiveTickGate } from "../lib/liveDataset";
import { heldWindow, mergeLiveBarsInto } from "../lib/useCandleHistory";
import {
  planCandleMutation, planColoredCandleMutation, planOhlcMutation, planSeriesMutation,
} from "../lib/chartSeries";
import type { KlineTick } from "../lib/marketFeed";
import type { Candle, Interval } from "../lib/types";

const candle = (symbol: string, openTime: number, close: number, interval: Interval = "1m"): Candle => ({
  symbol, interval, openTime, closeTime: openTime + 59_999,
  open: close, high: close, low: close, close, volume: 1,
});

const tick = (symbol: string, openTime: number, close: number, interval: Interval = "1m"): KlineTick => ({
  symbol, interval, openTime, closeTime: openTime + 59_999,
  open: close, high: close, low: close, close, volume: 1, closed: false,
});

/** Records what a chart would have done, in order. */
function chartRecorder() {
  const ops: string[] = [];
  const gate = new LiveTickGate<KlineTick>();
  let held: Candle[] = [];
  const applyTick = (t: KlineTick): void => {
    const idx = held.findIndex((c) => c.openTime === t.openTime);
    if (idx >= 0) held[idx] = candle(t.symbol, t.openTime, t.close, t.interval);
    else held.push(candle(t.symbol, t.openTime, t.close, t.interval));
    ops.push(`update ${t.symbol} ${t.openTime} ${t.close}`);
  };
  return {
    ops,
    /** The feed's tick path. */
    onTick(t: KlineTick) {
      if (gate.decide(t) === "hold") { ops.push(`hold ${t.symbol} ${t.openTime}`); return; }
      applyTick(t);
    },
    /** The data effect: a window has landed. */
    setData(candles: Candle[]) {
      held = [...candles];
      const first = candles[0]!;
      ops.push(`setData ${first.symbol} ×${candles.length}`);
      const pending = gate.adopt({ symbol: first.symbol, interval: first.interval },
        candles.length ? candles[candles.length - 1]!.openTime : null);
      if (pending) applyTick(pending);
    },
    held: () => held,
    gate,
  };
}

test("OLD DATASET → NEW REQUEST → NEW TICK BEFORE HISTORY → HISTORY LANDS: no cross-dataset write", () => {
  const chart = chartRecorder();
  const btc = [candle("BTCUSDT", 60_000, 79_000), candle("BTCUSDT", 120_000, 79_100)];
  chart.setData(btc);

  // Live on BTC: the forming bar is updated in place.
  chart.onTick(tick("BTCUSDT", 120_000, 79_150));
  assert.deepEqual(chart.ops, ["setData BTCUSDT ×2", "update BTCUSDT 120000 79150"]);

  // The pane switches to SOL. The feed is on SOL at once; SOL's forming bar
  // shares BTC's open time. This tick used to be drawn onto BTC's bars.
  chart.onTick(tick("SOLUSDT", 120_000, 77.4));
  assert.equal(chart.ops.at(-1), "hold SOLUSDT 120000");
  assert.equal(chart.held()[1]!.close, 79_150, "SOL's price was written onto BTC's last bar");
  assert.equal(chart.held()[1]!.symbol, "BTCUSDT");
  assert.equal(chart.gate.heldTicks, 1);

  // A newer SOL tick replaces the held one; still nothing is drawn.
  chart.onTick(tick("SOLUSDT", 120_000, 77.5));
  assert.equal(chart.held()[1]!.close, 79_150);

  // SOL history lands: replaced wholesale, then the held tick is applied —
  // once, and only the newest — so the forming bar is not a tick behind.
  chart.setData([candle("SOLUSDT", 60_000, 77.0), candle("SOLUSDT", 120_000, 77.2)]);
  assert.deepEqual(chart.ops.slice(-2), ["setData SOLUSDT ×2", "update SOLUSDT 120000 77.5"]);
  assert.equal(chart.held()[1]!.close, 77.5);
  assert.ok(chart.ops.every((op, i) => !(op.startsWith("update SOLUSDT") && i < chart.ops.indexOf("setData SOLUSDT ×2"))),
    "a SOL update happened before SOL's history was on screen");
});

test("a held tick older than the landed history is dropped, and a foreign one stays held", () => {
  const gate = new LiveTickGate<KlineTick>();
  gate.adopt({ symbol: "BTCUSDT", interval: "1m" }, 120_000);
  assert.equal(gate.decide(tick("SOLUSDT", 60_000, 1)), "hold");
  // History arrived with a newer bar than the held tick: the tick is stale.
  assert.equal(gate.adopt({ symbol: "SOLUSDT", interval: "1m" }, 120_000), null);

  assert.equal(gate.decide(tick("ETHUSDT", 180_000, 1)), "hold");
  // The wrong dataset landed: ETH's tick is not handed to SOL.
  assert.equal(gate.adopt({ symbol: "SOLUSDT", interval: "1m" }, 120_000), null);
  // And an interval change is a dataset change too.
  gate.adopt({ symbol: "SOLUSDT", interval: "1m" }, null);
  assert.equal(gate.decide(tick("SOLUSDT", 0, 1, "5m")), "hold");
  assert.equal(gate.decide(tick("solusdt", 0, 1, "1m")), "apply", "symbol case is not part of identity");
});

test("the history hook refuses to merge a bar from another dataset, and trims to the window", () => {
  const held = heldWindow(
    [candle("BTCUSDT", 60_000, 1), candle("BTCUSDT", 120_000, 2)],
    { symbol: "BTCUSDT", interval: "1m" as Interval, bars: 2 },
  );
  const foreign = mergeLiveBarsInto(held, null, candle("SOLUSDT", 120_000, 77));
  assert.equal(foreign, held, "a SOL bar was merged into BTC's window");
  const wrongInterval = mergeLiveBarsInto(held, null, candle("BTCUSDT", 120_000, 77, "5m"));
  assert.equal(wrongInterval, held);

  const rolled = mergeLiveBarsInto(held, candle("BTCUSDT", 120_000, 2.5), candle("BTCUSDT", 180_000, 3));
  assert.deepEqual(rolled.candles.map((c) => [c.openTime, c.close]), [[120_000, 2.5], [180_000, 3]]);
  assert.equal(rolled.dataset, held.dataset);
  assert.equal(datasetKey(rolled.dataset), "BTCUSDT|1m");
});

// ── Boundary repaint ────────────────────────────────────────────────────────

const N = 10_000;
const window_ = (offset = 0): Candle[] =>
  Array.from({ length: N }, (_, i) => candle("BTCUSDT", (i + offset + 1) * 60_000, i + offset));

test("same forming-bar tick → update; new bar without trim → update; new dataset → replace", () => {
  const before = window_();
  const sameBar = [...before.slice(0, -1), candle("BTCUSDT", N * 60_000, 123)];
  assert.equal(planCandleMutation(before, sameBar), "update");
  const appended = [...before, candle("BTCUSDT", (N + 1) * 60_000, 1)];
  assert.equal(planCandleMutation(before, appended), "update");
  assert.equal(planCandleMutation(before, before), "none");
  assert.equal(planCandleMutation(before, window_(5_000)), "replace", "a different window is a repaint");
  assert.equal(planCandleMutation(before, [candle("BTCUSDT", 60_000, 9), ...before.slice(1)]), "replace",
    "a historical bar that changed is a repaint");
});

test("A FULL-WINDOW LEFT TRIM AT A BAR CLOSE IS INCREMENTAL, NOT A 10,000-POINT REPAINT", () => {
  // What the chart holds after the tick path pushed the new bar (N+1 bars)…
  const afterTick = [...window_(), candle("BTCUSDT", (N + 1) * 60_000, 1)];
  // …and what React state holds after `mergeLiveBars` trimmed it to N.
  const trimmed = afterTick.slice(1);
  assert.equal(trimmed.length, N);
  assert.equal(planCandleMutation(afterTick, trimmed), "none",
    "the trimmed window is what is already drawn; nothing to do");

  // The next tick on the new bar, compared against the trimmed state.
  const nextTick = [...trimmed.slice(0, -1), candle("BTCUSDT", (N + 1) * 60_000, 2)];
  assert.equal(planCandleMutation(trimmed, nextTick), "update");

  // Trim-and-append in one step (state caught up two boundaries at once).
  const rolledTwice = [...window_().slice(1), candle("BTCUSDT", (N + 1) * 60_000, 1)];
  assert.equal(planCandleMutation(window_(), rolledTwice), "update");

  // Bar colours ride along by time, so the coloured planner agrees.
  const colours = new Map<number, string>([[60, "#0f0"]]);
  assert.equal(planColoredCandleMutation(afterTick, trimmed, colours, colours), "none");

  // Overlays (every moving average) see the same shifted prefix.
  const points = Array.from({ length: N }, (_, i) => ({ time: i + 1, value: i }));
  const shifted = [...points.slice(1), { time: N + 1, value: 7 }];
  assert.equal(planSeriesMutation(points, shifted), "update");
  assert.equal(planSeriesMutation(points, [...points.slice(1), { time: N, value: 7 }]), "update",
    "a rewrite of the last point after a trim is still one update");
  assert.equal(planSeriesMutation(points, [{ time: 1, value: -1 }, ...points.slice(1)]), "replace");

  // Transformed bars (Heikin Ashi) the same.
  const bars = window_().map(({ openTime, open, high, low, close }) => ({ openTime, open, high, low, close }));
  const rolled = [...bars.slice(1), { openTime: (N + 1) * 60_000, open: 1, high: 1, low: 1, close: 1 }];
  assert.equal(planOhlcMutation(bars, rolled), "update");
});

test("a trim the planner cannot honour is still a repaint", () => {
  const before = window_();
  // The middle of the window changed under a trim: replace.
  const tampered = before.slice(1).map((c, i) => i === 500 ? { ...c, close: -1 } : c);
  assert.equal(planCandleMutation(before, [...tampered, candle("BTCUSDT", (N + 1) * 60_000, 1)]), "replace");
  // `next` ends before `previous` does: update() cannot remove a bar.
  assert.equal(planCandleMutation(before, before.slice(1, -1)), "replace");
  // A trim deeper than a live boundary produces is a new window.
  assert.equal(planCandleMutation(before, before.slice(50)), "replace");
});
