/**
 * Synthetic/replay integration through the REAL MaAlertRunner IO shell.
 *
 * Local fakes replace only persistence and Web Push transport. Condition and
 * indicator computation, cadence decisions, state transitions, payload
 * formatting, event writes, and runner ordering are production code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import { MaAlertRunner } from "../src/engine/maAlertRunner";
import type { Candle } from "../src/types/market";
import type { AlertFrequency } from "../src/alerts/alertFrequency";
import type { MaAlertRow } from "../src/types/maAlerts";
import type { PushMessage, PushResult } from "../src/alerts/webPush";

type EvaluationWrite = Parameters<
  (typeof import("../src/repositories/maAlerts"))["recordEvaluation"]
>[0];
type EventWrite = Parameters<
  (typeof import("../src/repositories/maAlerts"))["createEvent"]
>[0];

const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as FastifyBaseLogger;

const T0 = Date.UTC(2026, 7, 31, 12, 0, 0);
const STEP = 60_000;

function history(): Candle[] {
  const bars = Array.from({ length: 400 }, (_, index) => {
    const close = index < 300
      ? 100 + Math.sin(index / 7) * 10
      : 100 + (index - 300);
    return {
      symbol: "BTCUSDT", interval: "1m" as const,
      openTime: T0 + index * STEP, closeTime: T0 + (index + 1) * STEP - 1,
      open: close - 0.2, high: close + 1, low: close - 1, close, volume: 10,
    };
  });
  const last = bars[bars.length - 1]!;
  // One broad-range closing candle touches every price reference while the
  // rising tail leaves fast MA, RSI, and MACD above their cross references.
  bars[bars.length - 1] = { ...last, open: 190, high: 250, low: 0, close: 200 };
  return bars;
}

function row(id: string, over: Partial<MaAlertRow>): MaAlertRow {
  return {
    id, symbol: "BTCUSDT", timeframe: "1m", conditionKind: "price",
    maType: null, maLength: null, mode: null,
    ma2Type: null, ma2Length: null, targetPrice: 150, priceDirection: "cross_up",
    srSide: null, srPivotLength: null, srInvalidation: null,
    pivotType: null, pivotLevelName: null, pivotAnchor: null,
    rsiLength: null, rsiLevel: null, rsiMaLength: null,
    macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: null,
    stPeriod: null, stMultiplier: null, stAtrMethod: null,
    // The three families Wave B added. Spelled out rather than left to
    // `Partial`, because `MaAlertRow` requires every column: a fixture that
    // omits one is a fixture that stops compiling the day the row grows,
    // which is what happened here.
    bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
    stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
    adxDiLength: null, adxSmoothing: null, adxLevel: null,
    filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
    filterMaType: null, filterMaLength: null, filterMaSide: null,
    filterStPeriod: null, filterStMultiplier: null,
    filterStAtrMethod: null, filterStSide: null,
    nearMinPct: 0.2, nearMaxPct: 0.5,
    enabled: true, frequency: "once_per_bar_close", cooldownMin: 0, note: null,
    lastSide: "below", lastFiredAt: null, lastFiredBarTime: null,
    lastBarTime: null, completedAt: null,
    createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    ...over,
  };
}

function localRunner(initialRows: MaAlertRow[], transport?: (message: PushMessage) => Promise<PushResult>) {
  const rows = initialRows.map((item) => ({ ...item }));
  const evaluations: EvaluationWrite[] = [];
  const events: EventWrite[] = [];
  const pushes: PushMessage[] = [];
  const trace: string[] = [];
  let now = T0;

  const runner = new MaAlertRunner(log, {
    listAlerts: async (opts = {}) => rows.filter((item) =>
      (!opts.symbol || item.symbol === opts.symbol) &&
      (!opts.timeframe || item.timeframe === opts.timeframe) &&
      (!opts.activeOnly || (item.enabled && item.completedAt === null))
    ),
    recordEvaluation: async (input) => {
      trace.push(`persist:${input.id}`);
      evaluations.push({ ...input });
      const item = rows.find((candidate) => candidate.id === input.id)!;
      item.lastSide = input.side;
      item.lastBarTime = new Date(input.barTime).toISOString();
      if (input.fired) {
        item.lastFiredAt = new Date(now).toISOString();
        item.lastFiredBarTime = new Date(input.barTime).toISOString();
      }
      if (input.complete) item.completedAt = new Date(now).toISOString();
    },
    createEvent: async (input) => {
      trace.push(`event:${input.alertId}`);
      events.push({ ...input });
    },
    sendPush: async (message) => {
      trace.push(`push:${message.tag?.replace(/^ma-/, "")}`);
      pushes.push({ ...message });
      return transport ? transport(message) : { sent: 1, failed: 0, pruned: 0 };
    },
    now: () => now,
  });

  return {
    runner, rows, evaluations, events, pushes, trace,
    setNow(value: number) { now = value; },
  };
}

test("all eight families run bar → condition → cadence → event → payload → fake push", async () => {
  const frequencies: AlertFrequency[] = [
    "once_only", "once_per_bar", "once_per_bar_close", "once_per_minute",
    "once_per_bar_close", "once_per_bar", "once_per_bar_close", "once_per_bar_close",
  ];
  const alerts = [
    row("price", { frequency: frequencies[0] }),
    row("ma", {
      conditionKind: "ma", maType: "sma", maLength: 20, mode: "touch",
      targetPrice: null, priceDirection: null, frequency: frequencies[1],
    }),
    row("ma-vs-ma", {
      conditionKind: "ma_vs_ma", maType: "ema", maLength: 10,
      ma2Type: "sma", ma2Length: 50, mode: "cross_up",
      targetPrice: null, priceDirection: null, frequency: frequencies[2],
    }),
    row("sr", {
      conditionKind: "sr_zone", srSide: "support", srPivotLength: 5,
      srInvalidation: "close", mode: "touch", targetPrice: null,
      priceDirection: null, frequency: frequencies[3],
    }),
    row("pivot", {
      conditionKind: "pivot_level", pivotType: "Fibonacci", pivotLevelName: "P",
      pivotAnchor: "1d", mode: "touch", targetPrice: null,
      priceDirection: null, frequency: frequencies[4],
    }),
    row("rsi", {
      conditionKind: "rsi", rsiLength: 14, rsiLevel: 50, rsiMaLength: 14,
      indicatorTarget: "level", mode: "cross_up", targetPrice: null,
      priceDirection: null, frequency: frequencies[5],
    }),
    row("macd", {
      conditionKind: "macd", macdFast: 12, macdSlow: 26, macdSignal: 9,
      indicatorTarget: "zero", mode: "cross_up", targetPrice: null,
      priceDirection: null, frequency: frequencies[6],
    }),
    // The rising tail leaves the Supertrend in its uptrend, so a row whose
    // stored side is still "below" detects the flip on this bar.
    row("supertrend", {
      conditionKind: "supertrend", stPeriod: 10, stMultiplier: 3,
      stAtrMethod: "rma", mode: "cross_up", targetPrice: null,
      priceDirection: null, frequency: frequencies[7],
    }),
  ];
  const fake = localRunner(alerts, async (message) =>
    message.title.includes("MACD")
      ? { sent: 1, failed: 2, pruned: 1 }
      : { sent: 1, failed: 0, pruned: 0 }
  );
  const bars = history();
  const sampleBar = bars[bars.length - 1]!;
  const now = sampleBar.closeTime + 1;
  fake.setNow(now);
  await fake.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars, sampleBar, isClosedBar: true, now,
    anchorPeriods: { "1d": { open: 90, high: 110, low: 80, close: 100 } },
  });

  assert.equal(fake.pushes.length, 8, "every family must reach the fake transport");
  assert.equal(fake.events.length, 8, "every delivery attempt must create an event");
  assert.equal(fake.evaluations.length, 8, "every family must persist its transition");
  assert.deepEqual(new Set(fake.events.map((event) => event.alertId)),
    new Set(["price", "ma", "ma-vs-ma", "sr", "pivot", "rsi", "macd", "supertrend"]));
  assert.ok(fake.pushes.every((message) => message.tag?.startsWith("ma-")));
  assert.ok(fake.pushes.every((message) => message.url === "/chart?symbol=BTCUSDT&interval=1m"));
  for (const alert of alerts) {
    const push = fake.trace.indexOf(`push:${alert.id}`);
    const event = fake.trace.indexOf(`event:${alert.id}`);
    const persist = fake.trace.indexOf(`persist:${alert.id}`);
    assert.ok(push >= 0 && push < event && event < persist, `${alert.id}: ${fake.trace.join(", ")}`);
  }
  assert.equal(fake.rows.find((item) => item.id === "price")!.completedAt !== null, true,
    "delivered once_only must persist retirement");

  const partial = fake.events.find((event) => event.alertId === "macd")!;
  assert.deepEqual(
    [partial.deliveryStatus, partial.pushedTo, partial.pushFailed, partial.pushPruned],
    ["partial_failure", 1, 2, 1]
  );
});

test("real runner preserves forming/closed boundaries and all four frequency transitions", async () => {
  const alerts = ([
    "once_only", "once_per_bar", "once_per_bar_close", "once_per_minute",
  ] as AlertFrequency[]).map((frequency) => row(frequency, {
    frequency, priceDirection: "either", targetPrice: 150,
  }));
  const fake = localRunner(alerts);
  const bars = history();
  const sampleBar = bars[bars.length - 1]!;
  const frame = { symbol: "BTCUSDT", interval: "1m" as const, bars, sampleBar };

  fake.setNow(T0);
  await fake.runner.replay({ ...frame, isClosedBar: false, now: T0 });
  assert.deepEqual(fake.events.map((event) => event.frequency).sort(),
    ["once_only", "once_per_bar", "once_per_minute"].sort(),
    "bar-close mode must not see a forming sample");

  fake.setNow(T0 + 30_000);
  await fake.runner.replay({ ...frame, isClosedBar: false, now: T0 + 30_000 });
  assert.equal(fake.events.length, 3, "same-bar and within-minute replays are suppressed");

  fake.setNow(T0 + 45_000);
  await fake.runner.replay({ ...frame, isClosedBar: true, now: T0 + 45_000 });
  assert.equal(fake.events.filter((event) => event.frequency === "once_per_bar_close").length, 1);

  fake.setNow(T0 + 60_000);
  await fake.runner.replay({ ...frame, isClosedBar: false, now: T0 + 60_000 });
  assert.equal(fake.events.filter((event) => event.frequency === "once_per_minute").length, 2);

  const nextBar = { ...sampleBar, openTime: sampleBar.openTime + STEP, closeTime: sampleBar.closeTime + STEP };
  fake.setNow(T0 + 61_000);
  await fake.runner.replay({
    ...frame, bars: [...bars, nextBar], sampleBar: nextBar,
    isClosedBar: false, now: T0 + 61_000,
  });
  assert.equal(fake.events.filter((event) => event.frequency === "once_per_bar").length, 2);
  assert.equal(fake.events.filter((event) => event.frequency === "once_only").length, 1);
});

test("a transport exception persists a secret-free failed outcome and keeps once-only armed", async () => {
  const fake = localRunner([
    row("failure", { frequency: "once_only", priceDirection: "either" }),
  ], async () => { throw new Error("endpoint secret-token-value"); });
  const bars = history();
  const sampleBar = bars[bars.length - 1]!;
  await fake.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars, sampleBar,
    isClosedBar: true, now: T0,
  });
  assert.equal(fake.events[0]!.deliveryStatus, "failed");
  assert.equal(fake.events[0]!.pushFailed, 1);
  assert.doesNotMatch(JSON.stringify(fake.events[0]), /secret-token-value/);
  assert.equal(fake.rows[0]!.completedAt, null, "failed once-only notification stays armed");
});
