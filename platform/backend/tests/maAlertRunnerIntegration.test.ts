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
import {
  autoFib, autoFibLevelPrice, ema, enteredZone, liquiditySwings, marketStructure, rsi, sma,
} from "../src/engine/ta";
import fs from "node:fs";
import path from "node:path";

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
    id, userId: "00000000-0000-4000-8000-000000000001",
    symbol: "BTCUSDT", timeframe: "1m", conditionKind: "price",
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
    filters: null,
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

function localRunner(
  initialRows: MaAlertRow[],
  transport?: (message: PushMessage) => Promise<PushResult>,
  outbox?: { failCompletionOnce?: boolean },
) {
  const rows = initialRows.map((item) => ({ ...item }));
  const evaluations: EvaluationWrite[] = [];
  const events: EventWrite[] = [];
  const pushes: PushMessage[] = [];
  const trace: string[] = [];
  let now = T0;
  const claims = new Set<string>();
  let failCompletion = outbox?.failCompletionOnce === true;

  const runner = new MaAlertRunner(log, {
    listAlerts: async (opts) => rows.filter((item) =>
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
    claimDelivery: async (input: {
      occurrenceKey: string; id: string; side: "above" | "below" | null; barTime: number;
    }) => {
      trace.push(`claim:${input.id}`);
      if (claims.has(input.occurrenceKey)) return false;
      claims.add(input.occurrenceKey);
      const item = rows.find((candidate) => candidate.id === input.id)!;
      item.lastSide = input.side;
      item.lastBarTime = new Date(input.barTime).toISOString();
      item.lastFiredAt = new Date(now).toISOString();
      item.lastFiredBarTime = new Date(input.barTime).toISOString();
      return true;
    },
    completeDelivery: async (_key: string, input: EventWrite) => {
      trace.push(`complete:${input.alertId}`);
      if (failCompletion) {
        failCompletion = false;
        throw new Error("injected completion failure after provider submission");
      }
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

test("FC1-H1 crash after push cannot resubmit an occurrence after restart", async () => {
  const fake = localRunner([
    row("crash", { frequency: "once_per_bar_close", lastSide: "below" }),
  ], undefined, { failCompletionOnce: true });
  const bars = history();
  await assert.rejects(
    () => fake.runner.replay({
      symbol: "BTCUSDT", interval: "1m", bars,
      sampleBar: bars.at(-1)!, isClosedBar: true, now: T0,
    }),
    /injected completion failure/
  );
  assert.equal(fake.pushes.length, 1, "the provider was submitted once before the crash");

  // A restarted worker re-reads the durable fired identity. The provider does
  // not expose an idempotency API, so dispatching/unknown is never retried.
  await fake.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars,
    sampleBar: bars.at(-1)!, isClosedBar: true, now: T0 + 1,
  });
  assert.equal(fake.pushes.length, 1, "restart must not duplicate the external submission");
});

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
    const claim = fake.trace.indexOf(`claim:${alert.id}`);
    const push = fake.trace.indexOf(`push:${alert.id}`);
    const complete = fake.trace.indexOf(`complete:${alert.id}`);
    const persist = fake.trace.indexOf(`persist:${alert.id}`);
    assert.ok(
      claim >= 0 && claim < push && push < complete && complete < persist,
      `${alert.id}: ${fake.trace.join(", ")}`
    );
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

/**
 * An RSI alert's EMA target is the EMA OF THE RSI — measured through the real
 * runner, not a stand-in.
 *
 * The candles are chosen so that on the last bar the RSI sits BETWEEN its
 * EMA 14 and its SMA 14: above one, below the other. An EMA alert and an SMA
 * alert must therefore disagree about which side they are on, so wiring the
 * EMA target to the SMA (or the reverse) cannot pass. The expected sides are
 * recomputed here from the same candles rather than written in.
 */
test("an RSI alert can cross its own EMA, and it is not its SMA", async () => {
  const bars: Candle[] = Array.from({ length: 300 }, (_, index) => {
    const close = 100 + Math.sin((index + 15) / 6) * 10;
    return {
      symbol: "BTCUSDT", interval: "1m" as const,
      openTime: T0 + index * STEP, closeTime: T0 + (index + 1) * STEP - 1,
      open: close, high: close + 0.5, low: close - 0.5, close, volume: 10,
    };
  });
  const closes = bars.map((b) => b.close);
  const series = rsi(closes, 14);
  const value = series.at(-1)!;
  const viaEma = value > ema(series, 14).at(-1)! ? "above" : "below";
  const viaSma = value > sma(series, 14).at(-1)! ? "above" : "below";
  assert.notEqual(viaEma, viaSma, "fixture must separate the two averages, or this proves nothing");

  const rsiRow = (id: string, target: "sma" | "ema") => row(id, {
    conditionKind: "rsi", rsiLength: 14, rsiLevel: null, rsiMaLength: 14,
    indicatorTarget: target, mode: "cross_up", targetPrice: null, priceDirection: null,
    lastSide: null,
  });
  const fake = localRunner([rsiRow("vs-ema", "ema"), rsiRow("vs-sma", "sma")]);
  await fake.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars,
    sampleBar: bars.at(-1)!, isClosedBar: true, now: T0,
  });

  const sideOf = (id: string) => fake.evaluations.find((e) => e.id === id)?.side;
  assert.equal(sideOf("vs-ema"), viaEma, "the EMA alert is measured against the EMA of the RSI");
  assert.equal(sideOf("vs-sma"), viaSma, "and the SMA alert, unchanged, against its SMA");
});

/**
 * A fib-level alert fires through the real runner when price touches the
 * level the chart's Auto Fib draws — on real, unmodified candles.
 *
 * The alert is armed at the exact ratio where the last of 1000 real NEARUSDT
 * 1h bars closed, so that level lies inside the bar by construction and a
 * touch alert must fire. A second alert at a ratio far outside the bar's range
 * must not. Nothing is reshaped, so nothing can have moved the swing.
 */
test("a fib-level alert fires when price touches the Auto Fib level, and not elsewhere", async () => {
  const fx = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures", "autoFibGolden.json"), "utf8")) as {
    high: number[]; low: number[]; close: number[];
  };
  const bars: Candle[] = fx.close.map((close, i) => ({
    symbol: "BTCUSDT", interval: "1m" as const,
    openTime: T0 + i * STEP, closeTime: T0 + (i + 1) * STEP - 1,
    open: close, high: fx.high[i]!, low: fx.low[i]!, close, volume: 10,
  }));
  const last = bars[bars.length - 1]!;
  const fib = autoFib(fx.high, fx.low, fx.close, 3, 30)!;
  assert.ok(fib, "the fixture has a swing");

  const atClose = (last.close - fib.startPrice) / fib.height;
  assert.ok(Math.abs(autoFibLevelPrice(fib, atClose) - last.close) < 1e-9);
  // A ratio whose price is well outside this bar, on the far side of 0 or 1.
  const far = atClose > 0.5 ? -3 : 4;
  const farPrice = autoFibLevelPrice(fib, far);
  assert.ok(farPrice > last.high * 1.01 || farPrice < last.low * 0.99, "the far level is off the bar");

  const fibRow = (id: string, level: number) => row(id, {
    conditionKind: "fib_level", targetPrice: null, priceDirection: null,
    fibDeviation: 3, fibDepth: 30, fibReverse: false, fibLevel: level,
    mode: "touch", lastSide: null,
  });
  const fake = localRunner([fibRow("at-close", atClose), fibRow("far", far)]);
  await fake.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars, sampleBar: last, isClosedBar: true, now: T0,
  });

  const fired = (id: string) => fake.evaluations.find((e) => e.id === id)?.fired;
  assert.equal(fired("at-close"), true, "price is ON this level — the alert must fire");
  assert.equal(fired("far"), false, "that level is nowhere near this bar");
  assert.equal(fake.pushes.length, 1);
  assert.match(fake.pushes[0]!.title, /fib /);
});

/**
 * The MSB-OB and Liquidity Swings families fire through the real runner on
 * the bar the chart's studies show the event — on real, unmodified NEARUSDT
 * 1h candles, replayed up to that bar.
 */
function nearBars(): Candle[] {
  const fx = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures", "nearusdt-1h.json"), "utf8")) as { bars: number[][] };
  return fx.bars.map(([, o, h, l, c, v], i) => ({
    symbol: "BTCUSDT", interval: "1m" as const,
    openTime: T0 + i * STEP, closeTime: T0 + (i + 1) * STEP - 1,
    open: o!, high: h!, low: l!, close: c!, volume: v!,
  }));
}
const series = (bars: Candle[]) => ({
  o: bars.map((b) => b.open), h: bars.map((b) => b.high), l: bars.map((b) => b.low),
  c: bars.map((b) => b.close), v: bars.map((b) => b.volume),
});

test("an MSB alert fires on the bar the structure breaks, in its own direction only", async () => {
  const all = nearBars();
  const s = series(all);
  const ms = marketStructure(s.o, s.h, s.l, s.c, 9, 0.33);
  const brk = ms.breaks.at(-1)!;
  const bars = all.slice(0, brk.index + 1);
  const msbRow = (id: string, mode: "cross_up" | "cross_down" | "touch") => row(id, {
    conditionKind: "msb", targetPrice: null, priceDirection: null,
    msbZigzagLength: 9, msbFibFactor: 0.33, mode, lastSide: null,
  });
  const fake = localRunner([
    msbRow("same", brk.direction === 1 ? "cross_up" : "cross_down"),
    msbRow("opposite", brk.direction === 1 ? "cross_down" : "cross_up"),
    msbRow("either", "touch"),
  ]);
  await fake.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars, sampleBar: bars.at(-1)!, isClosedBar: true, now: T0,
  });
  const fired = (id: string) => fake.evaluations.find((e) => e.id === id)?.fired;
  assert.equal(fired("same"), true);
  assert.equal(fired("either"), true);
  assert.equal(fired("opposite"), false);
  assert.match(fake.pushes[0]!.title, /MSB/);

  // The bar before the break is not a break.
  const quiet = localRunner([msbRow("before", "touch")]);
  const before = all.slice(0, brk.index);
  await quiet.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars: before, sampleBar: before.at(-1)!, isClosedBar: true, now: T0,
  });
  assert.equal(quiet.evaluations.find((e) => e.id === "before")?.fired, false);
});

test("an order-block alert fires when price enters a zone, not while it stays inside", async () => {
  const all = nearBars();
  const s = series(all);
  const ms = marketStructure(s.o, s.h, s.l, s.c, 9, 0.33);
  const entries = all.map((_, i) => enteredZone(ms, i, "any")).map((h, i) => (h ? i : -1)).filter((i) => i > 0);
  assert.ok(entries.length > 0, "the fixture has a zone entry");
  const e = entries.at(-1)!;
  const hit = enteredZone(ms, e, "any")!;
  const inside = ms.hits.some((h) => h.index === e + 1 && h.zoneId === hit.zoneId)
    && !enteredZone(ms, e + 1, hit.kind) ? e + 1 : -1;

  const obRow = (id: string, zone: string) => row(id, {
    conditionKind: "order_block", targetPrice: null, priceDirection: null,
    msbZigzagLength: 9, msbFibFactor: 0.33, obZone: zone, mode: "touch", lastSide: null,
  });
  const other = hit.kind.startsWith("bu") ? "bearish" : "bullish";
  const fake = localRunner([obRow("kind", hit.kind), obRow("any", "any"), obRow("other", other)]);
  const bars = all.slice(0, e + 1);
  await fake.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars, sampleBar: bars.at(-1)!, isClosedBar: true, now: T0,
  });
  const fired = (id: string) => fake.evaluations.find((x) => x.id === id)?.fired;
  assert.equal(fired("kind"), true);
  assert.equal(fired("any"), true);
  assert.equal(fired("other"), enteredZone(ms, e, other as "bullish" | "bearish") !== null);

  if (inside > 0) {
    const later = localRunner([obRow("still-inside", hit.kind)]);
    const more = all.slice(0, inside + 1);
    await later.runner.replay({
      symbol: "BTCUSDT", interval: "1m", bars: more, sampleBar: more.at(-1)!, isClosedBar: true, now: T0,
    });
    assert.equal(later.evaluations.find((x) => x.id === "still-inside")?.fired, false,
      "a second bar inside the same zone is not a new entry");
  }
});

test("a liquidity-swing alert fires when price touches the live swing level", async () => {
  const all = nearBars();
  const s = series(all);
  const ls = liquiditySwings(s.o, s.h, s.l, s.c, s.v, 20, "full");
  const j = all.findIndex((b, i) => i > 50 && Number.isFinite(ls.liveHigh[i]!)
    && b.low <= ls.liveHigh[i]! && b.high >= ls.liveHigh[i]!);
  assert.ok(j > 0, "the fixture has a bar touching a live swing high");
  const lsRow = (id: string, side: string) => row(id, {
    conditionKind: "liquidity_swing", targetPrice: null, priceDirection: null,
    lsLength: 20, lsArea: "full", lsSide: side, mode: "touch", lastSide: null,
  });
  const fake = localRunner([lsRow("high", "high")]);
  const bars = all.slice(0, j + 1);
  await fake.runner.replay({
    symbol: "BTCUSDT", interval: "1m", bars, sampleBar: bars.at(-1)!, isClosedBar: true, now: T0,
  });
  assert.equal(fake.evaluations.find((x) => x.id === "high")?.fired, true);
  assert.match(fake.pushes[0]!.title, /liquidity high/);
});
