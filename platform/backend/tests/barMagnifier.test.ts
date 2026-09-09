/**
 * The bar magnifier.
 *
 * When a bar's range contains both a stop and a target, which filled first is
 * unknowable from OHLC alone. The broker resolves it with TradingView's
 * heuristic — a green bar walked open → low → high, a red bar open → high → low
 * — and on a partial-take-profit configuration that guess decides whether the
 * trade booked +2R or −1R.
 *
 * Phase 8 admits this feature "only after its execution semantics are explicit,
 * deterministic and tested". These tests are that bar: what the semantics ARE,
 * that they are deterministic, that the default path is unchanged bit for bit,
 * and that the magnifier changes the answer exactly where the heuristic was
 * guessing and nowhere else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker, type SubBar } from "../src/engine/broker";
import { subBarsFor, type Bars } from "../src/engine/mtf";
import { feedsFor, FIXTURE_SYMBOL, minuteSeries } from "./support/marketFixture";
import { noCorrections, allCorrections } from "../src/engine/corrections";

const T0 = Date.UTC(2026, 7, 24, 0, 0, 0);
const HOUR = 3_600_000;

/** Two bars: an entry bar, then one whose range contains both exits. */
function bars(second: { open: number; high: number; low: number; close: number }): Bars {
  return {
    symbol: "TESTUSDT", interval: "1h", length: 2,
    time: [T0, T0 + HOUR],
    closeTime: [T0 + HOUR - 1, T0 + 2 * HOUR - 1],
    open: [100, second.open],
    high: [100.5, second.high],
    low: [99.5, second.low],
    close: [100, second.close],
    volume: [1000, 1000],
  };
}

const OPTS = {
  initialCapital: 10_000, commissionPct: 0.1, slippageTicks: 0,
  tickSize: 0.01, qtyCash: 1000, qtyPctEquity: 0,
};

/**
 * Enter at bar 0's close, place a stop at 95 and a target at 105, then walk
 * bar 1 — whose range touches both.
 */
function runBoth(
  b: Bars,
  opts: { magnifier?: (bars: Bars, i: number) => readonly SubBar[] | null; on: boolean }
): string[] {
  const broker = new Broker({
    ...OPTS,
    fillOnBarClose: true,
    corrections: opts.on ? allCorrections() : noCorrections(),
    ...(opts.magnifier ? { magnifier: opts.magnifier } : {}),
  });
  broker.queueEntry("entry");
  broker.processClose(b, 0);
  broker.setExitLeg("RR1", null, 105, 95, 0);
  broker.processIntrabar(b, 1, { tp: { RR1: "TP" }, sl: "SL" });
  return broker.closed.map((t) => t.exitReason ?? "");
}

const GREEN = bars({ open: 100, high: 106, low: 94, close: 103 });
const RED = bars({ open: 100, high: 106, low: 94, close: 97 });

// ── The semantics, stated ───────────────────────────────────────────────────

test("DEFAULT: a green bar is walked open → low → high, so the STOP wins", () => {
  assert.deepEqual(runBoth(GREEN, { on: false }), ["SL"]);
});

test("DEFAULT: a red bar is walked open → high → low, so the TARGET wins", () => {
  assert.deepEqual(runBoth(RED, { on: false }), ["TP"]);
});

test("the heuristic is a GUESS: the same range gives opposite answers by close", () => {
  // Identical high and low; only the close differs. That is the whole basis on
  // which the outcome is decided without a finer feed.
  assert.equal(GREEN.high[1], RED.high[1]);
  assert.equal(GREEN.low[1], RED.low[1]);
  assert.notDeepEqual(runBoth(GREEN, { on: false }), runBoth(RED, { on: false }));
});

// ── With the magnifier ──────────────────────────────────────────────────────

/** The price went UP to 106 first, then down to 94. */
const upFirst: SubBar[] = [
  { open: 100, high: 106, low: 100, close: 106 },
  { open: 106, high: 106, low: 94, close: 103 },
];
/** The price went DOWN to 94 first, then up to 106. */
const downFirst: SubBar[] = [
  { open: 100, high: 100, low: 94, close: 94 },
  { open: 94, high: 106, low: 94, close: 103 },
];

test("ON: a green bar whose price rose FIRST books the target, not the stop", () => {
  // The heuristic says SL for this bar. The actual path says TP.
  assert.deepEqual(runBoth(GREEN, { on: false }), ["SL"]);
  assert.deepEqual(runBoth(GREEN, { on: true, magnifier: () => upFirst }), ["TP"]);
});

test("ON: a red bar whose price fell FIRST books the stop, not the target", () => {
  assert.deepEqual(runBoth(RED, { on: false }), ["TP"]);
  assert.deepEqual(runBoth(RED, { on: true, magnifier: () => downFirst }), ["SL"]);
});

test("ON: where the finer path agrees with the heuristic, the answer is the same", () => {
  assert.deepEqual(runBoth(GREEN, { on: true, magnifier: () => downFirst }), ["SL"]);
  assert.deepEqual(runBoth(RED, { on: true, magnifier: () => upFirst }), ["TP"]);
});

// ── The guarantees Phase 8 requires ─────────────────────────────────────────

test("DETERMINISTIC: the same bar and the same sub-bars give the same fills, always", () => {
  const once = runBoth(GREEN, { on: true, magnifier: () => upFirst });
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(runBoth(GREEN, { on: true, magnifier: () => upFirst }), once);
  }
});

test("OFF BY DEFAULT: with the correction off, a magnifier is not consulted at all", () => {
  let consulted = 0;
  const result = runBoth(GREEN, {
    on: false,
    magnifier: () => { consulted += 1; return upFirst; },
  });
  assert.equal(consulted, 0, "an off correction must not change behaviour, or cost anything");
  assert.deepEqual(result, ["SL"]);
});

test("WITH NO FINER FEED the behaviour is the old one, bit for bit", () => {
  for (const b of [GREEN, RED]) {
    assert.deepEqual(runBoth(b, { on: true, magnifier: () => null }), runBoth(b, { on: false }));
    assert.deepEqual(runBoth(b, { on: true, magnifier: () => [] }), runBoth(b, { on: false }));
    assert.deepEqual(runBoth(b, { on: true }), runBoth(b, { on: false }));
  }
});

test("a sub-bar that touches neither level fills nothing", () => {
  const quiet: SubBar[] = [{ open: 100, high: 101, low: 99, close: 100 }];
  assert.deepEqual(runBoth(GREEN, { on: true, magnifier: () => quiet }), []);
});

test("ambiguity WITHIN one sub-bar falls back to the same heuristic, over a shorter span", () => {
  // One sub-bar containing both levels: the magnifier cannot resolve it either,
  // and it says so by behaving exactly as the whole-bar heuristic would.
  const both: SubBar[] = [{ open: 100, high: 106, low: 94, close: 103 }];
  assert.deepEqual(runBoth(GREEN, { on: true, magnifier: () => both }), ["SL"]);
  const bothRed: SubBar[] = [{ open: 100, high: 106, low: 94, close: 97 }];
  assert.deepEqual(runBoth(GREEN, { on: true, magnifier: () => bothRed }), ["TP"]);
});

test("the magnifier is asked for the bar being walked, not some other bar", () => {
  const seen: number[] = [];
  runBoth(GREEN, {
    on: true,
    magnifier: (_bars, i) => { seen.push(i); return upFirst; },
  });
  assert.deepEqual(seen, [1]);
});

test("a gap keeps legacy open-fill identity but corrected execution waits for the completed close", () => {
  // The gap branch runs before any intrabar walk. Legacy reproduction fills
  // at that open; corrected executable semantics can only decide from the
  // completed candle and therefore fill at its close while retaining 95 as
  // the intended stop trigger.
  const gapped = bars({ open: 90, high: 106, low: 89, close: 103 });
  for (const on of [false, true]) {
    const broker = new Broker({
      ...OPTS, fillOnBarClose: true,
      corrections: on ? allCorrections() : noCorrections(),
      magnifier: () => upFirst,
    });
    broker.queueEntry("entry");
    broker.processClose(gapped, 0);
    broker.setExitLeg("RR1", null, 105, 95, 0);
    broker.processIntrabar(gapped, 1, { tp: { RR1: "TP" }, sl: "SL" });
    assert.equal(broker.closed[0]?.exitReason, "SL", `on=${on}`);
    assert.equal(broker.closed[0]?.exitPrice, on ? 103 : 90, `on=${on}`);
    assert.equal(broker.closed[0]?.intendedTriggerPrice, on ? 95 : null, `on=${on}`);
    assert.equal(broker.closed[0]?.exitTime, on ? gapped.closeTime[1]! + 1 : gapped.time[1]!, `on=${on}`);
  }
});

// ── Slicing a finer feed ────────────────────────────────────────────────────

test("subBarsFor returns exactly the finer bars inside one chart bar", () => {
  const base = minuteSeries(60 * 3, 42);
  const store = feedsFor(base, ["1m", "15m"]);
  const chart = store.get(FIXTURE_SYMBOL, "15m");
  const finer = store.get(FIXTURE_SYMBOL, "1m");

  const subs = subBarsFor(chart, finer, 0)!;
  assert.equal(subs.length, 15, "a 15-minute bar contains fifteen 1-minute bars");
  assert.equal(subs[0]!.open, finer.open[0]);
  assert.equal(subs[14]!.close, finer.close[14]);
  // The slice reconstructs the chart bar it came from.
  assert.equal(Math.max(...subs.map((s) => s.high)), chart.high[0]);
  assert.equal(Math.min(...subs.map((s) => s.low)), chart.low[0]);
  assert.equal(subs[0]!.open, chart.open[0]);
  assert.equal(subs[14]!.close, chart.close[0]);
});

test("subBarsFor is null past the end of the finer feed", () => {
  const base = minuteSeries(30, 42);
  const store = feedsFor(base, ["1m", "15m"]);
  const chart = store.get(FIXTURE_SYMBOL, "15m");
  const finer = store.get(FIXTURE_SYMBOL, "1m");
  assert.notEqual(subBarsFor(chart, finer, 0), null);
  assert.equal(subBarsFor(chart, finer, 99), null, "a bar index past the chart is null");
});

test("subBarsFor never returns a finer bar that runs past the chart bar's close", () => {
  const base = minuteSeries(60 * 2, 7);
  const store = feedsFor(base, ["5m", "15m"]);
  const chart = store.get(FIXTURE_SYMBOL, "15m");
  const finer = store.get(FIXTURE_SYMBOL, "5m");
  for (let i = 0; i < 4; i += 1) {
    const subs = subBarsFor(chart, finer, i);
    if (!subs) continue;
    assert.equal(subs.length, 3, `chart bar ${i}`);
  }
});
