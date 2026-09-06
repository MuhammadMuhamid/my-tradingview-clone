import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../lib/types";
import type { Drawing } from "../lib/drawings";
import {
  REPLAY_SPEEDS, activeReplayQuote, drawingsAtReplayHorizon, liveActionsDisabled, reconcileReplay, replayCandles, replayDelayMs, replayTick, startReplay, stepReplay,
} from "../lib/replay";
import {
  invalidateReplayOutput,
  NO_DRAWINGS,
  pineRunRange,
  type AppliedIndicator,
} from "../lib/indicators";
import { currentMaValues } from "../lib/movingAverages";

const candles: Candle[] = [1, 2, 3, 4, 5].map((close, index) => ({
  symbol: "BTCUSDT",
  interval: "1m",
  openTime: index * 60_000,
  closeTime: (index + 1) * 60_000 - 1,
  open: close - 0.5,
  high: close + 0.25,
  low: close - 0.75,
  close,
  volume: close * 10,
}));

function atBar(index: number) {
  const session = startReplay(candles, candles[index]!.closeTime, 1_000_000);
  assert.ok(session);
  return session;
}

test("start at historical N isolates every future price and active-symbol value", () => {
  const replay = atBar(2);
  const visible = replayCandles(candles, replay);
  assert.deepEqual(
    visible.map((bar) => bar.close),
    [1, 2, 3],
  );
  assert.equal(visible.at(-1)?.closeTime, replay.horizonCloseTime);
  assert.deepEqual(activeReplayQuote(candles, replay), {
    last: 3,
    chg: 1,
    chgPct: 50,
  });
});

test("Next and Previous move exactly one actual bar and recompute derived values", () => {
  const initial = atBar(2);
  const next = stepReplay(initial, candles, 1);
  assert.equal(next.horizonCloseTime, candles[3]!.closeTime);
  const previous = stepReplay(next, candles, -1);
  assert.equal(previous.horizonCloseTime, initial.horizonCloseTime);

  const line = [{ type: "sma" as const, length: 2, visible: true }];
  assert.equal(
    currentMaValues(replayCandles(candles, next), line)["ma-sma-2"],
    3.5,
  );
  assert.equal(
    currentMaValues(replayCandles(candles, previous), line)["ma-sma-2"],
    2.5,
  );
});

test("Play advances only while playing, preserves order, and stops at history end", () => {
  let replay = { ...atBar(2), playing: false };
  assert.equal(replayTick(replay, candles), replay);
  replay = { ...replay, playing: true };
  replay = replayTick(replay, candles);
  assert.equal(replay.horizonCloseTime, candles[3]!.closeTime);
  assert.equal(replay.playing, true);
  replay = replayTick(replay, candles);
  assert.equal(replay.horizonCloseTime, candles[4]!.closeTime);
  assert.equal(replay.playing, false);
  assert.deepEqual(replayTick(replay, candles), replay);
});

test("Exit restores the unchanged full chart candle sequence", () => {
  assert.equal(replayCandles(candles, atBar(1)).length, 2);
  assert.deepEqual(replayCandles(candles, null), candles);
});

test("Pine range uses the authoritative replay close time without end-of-day widening", () => {
  const horizon = new Date(candles[2]!.closeTime).toISOString();
  assert.deepEqual(
    pineRunRange({
      startTime: new Date(candles[0]!.openTime).toISOString(),
      endTime: horizon,
    }),
    {
      startTime: new Date(candles[0]!.openTime).toISOString(),
      endTime: horizon,
    },
  );
});

test("rewind invalidation cannot retain a later-horizon Pine/indicator cache", () => {
  const indicator: AppliedIndicator = {
    key: "one",
    scriptId: null,
    name: "Future leak",
    kind: "indicator",
    shortTitle: "",
    overlay: true,
    precision: null,
    source: "plot(close)",
    inputs: [],
    params: {},
    visible: true,
    loading: false,
    error: "old",
    warnings: [],
    overlays: [
      {
        id: "future",
        title: "future",
        color: "#fff",
        data: [{ time: 5, value: 5 }],
      },
    ],
    decorations: [
      {
        kind: "background",
        id: "future-bg",
        paneId: "price",
        data: [{ time: 5, color: "#fff" }],
      },
    ],
    barColors: [{ time: 5, color: "#fff" }],
    markers: [
      {
        time: 5,
        position: "aboveBar",
        color: "#fff",
        text: "future",
        shape: "circle",
      },
    ],
    drawings: {
      ...NO_DRAWINGS,
      labels: [
        {
          x: 5,
          y: 5,
          text: "future",
          color: "#fff",
          textColor: "#000",
          style: "label",
          size: "small",
        },
      ],
    },
    trades: [
      {
        tradeNo: 1,
        direction: "long",
        entryTime: 5,
        entryPrice: 5,
        exitTime: null,
        exitPrice: null,
        qty: 1,
        pnl: null,
        pnlPct: null,
        exitReason: null,
        runUpPct: null,
        drawdownPct: null,
        cumProfit: null,
      },
    ],
  };
  const invalidated = invalidateReplayOutput(indicator);
  assert.equal(invalidated.loading, true);
  assert.equal(invalidated.error, null);
  assert.deepEqual(invalidated.overlays, []);
  assert.deepEqual(invalidated.decorations, []);
  assert.deepEqual(invalidated.barColors, []);
  assert.deepEqual(invalidated.markers, []);
  assert.deepEqual(invalidated.drawings, NO_DRAWINGS);
  assert.deepEqual(invalidated.trades, []);
});

test("symbol/timeframe navigation preserves T and resolves the last completed new bar", () => {
  const replay = atBar(3);
  const twoMinute = [
    { ...candles[0]!, interval: "5m" as const, closeTime: 119_999 },
    { ...candles[1]!, interval: "5m" as const, closeTime: 239_999 },
    { ...candles[2]!, interval: "5m" as const, closeTime: 359_999 },
  ];
  const resolved = reconcileReplay(replay, twoMinute);
  assert.equal(resolved.horizonCloseTime, 239_999);
  assert.equal(resolved.playing, false);
  assert.ok(resolved.horizonCloseTime <= replay.horizonCloseTime);
});

test("persisted drawings are isolated and replay-session drawings never become normal drawings", () => {
  const persisted: Drawing = {
    id: "saved-later",
    tool: "trend",
    points: [{ time: 1, price: 1 }],
    style: { color: "#fff", width: 1 },
  };
  const sessionOnly: Drawing = {
    id: "replay-only",
    tool: "hline",
    points: [{ time: 2, price: 2 }],
    style: { color: "#fff", width: 1 },
  };
  assert.deepEqual(
    drawingsAtReplayHorizon(atBar(2), [persisted], [sessionOnly]),
    [sessionOnly],
  );
  assert.deepEqual(drawingsAtReplayHorizon(null, [persisted], [sessionOnly]), [
    persisted,
  ]);
});

test("live trade, Bot, paper and alert actions share one Replay guard", () => {
  assert.equal(liveActionsDisabled(atBar(2)), true);
  assert.equal(liveActionsDisabled(null), false);
});

test("the speeds are a bounded ladder, and every one of them is a real delay", () => {
  // 10× exists because reviewing a session at 5× takes long enough that people
  // stop doing it. It is the ceiling rather than a step toward more: past ten
  // bars a second the chart is not being read.
  assert.deepEqual([...REPLAY_SPEEDS], [1, 2, 5, 10]);
  for (const speed of REPLAY_SPEEDS) {
    const delay = replayDelayMs(speed);
    assert.ok(Number.isFinite(delay) && delay > 0, `${speed}× has no usable delay`);
    // Bars per second means exactly that.
    assert.equal(delay, 1000 / speed);
  }
  // Strictly faster as the number rises — a ladder that was not monotonic
  // would make a "faster" button slower.
  const delays = REPLAY_SPEEDS.map(replayDelayMs);
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i]! < delays[i - 1]!, "each step must actually be faster");
  }
  // And a browser can keep up: 100 ms per frame is well inside a paint budget.
  assert.ok(Math.min(...delays) >= 100, "a speed no browser can render is not a speed");
});
