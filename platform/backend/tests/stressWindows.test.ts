/**
 * Stress-window discovery: deterministic, benchmark-only, and honest about
 * what kind of evidence it produces.
 *
 * The single property that makes this analysis worth running is that the
 * windows are chosen from MARKET DATA and never from strategy performance. If
 * a trade or an equity curve could reach the selector, the report would be
 * "here are the periods where the strategy did badly, and look, the strategy
 * did badly" — circular, and worse than not running it. The first test pins
 * that structurally rather than by inspection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barsForDuration, discoverStressWindows, StressDiscoveryError, stressProvenance,
  STRESS_EPISTEMIC_NOTE, type StressWindowConfig,
} from "../src/engine/stress";
import type { Candle, Interval } from "../src/types/market";

const HOUR = 3_600_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");

/** A benchmark series from a list of closes, one hour apart. */
function series(closes: number[], interval: Interval = "1h"): Candle[] {
  const step = interval === "1h" ? HOUR : HOUR;
  return closes.map((close, i) => {
    const previous = i === 0 ? close : closes[i - 1]!;
    return {
      symbol: "BTCUSDT", interval,
      openTime: T0 + i * step, closeTime: T0 + (i + 1) * step - 1,
      open: previous, close,
      high: Math.max(previous, close), low: Math.min(previous, close),
      volume: 1,
    };
  });
}

/** Flat, then a crash, then flat, then a milder fall. */
function twoEpisodes(): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < 20; i += 1) closes.push(100);          // 0..19  flat
  for (let i = 0; i < 10; i += 1) closes.push(100 - i * 5);  // 20..29 crash to 55
  for (let i = 0; i < 20; i += 1) closes.push(55);           // 30..49 flat
  for (let i = 0; i < 10; i += 1) closes.push(55 - i);       // 50..59 milder fall
  for (let i = 0; i < 20; i += 1) closes.push(46);           // 60..79 flat
  return series(closes);
}

const BASE: StressWindowConfig = { method: "worst_return", lengthBars: 10, topN: 2 };

// ── The invariant ───────────────────────────────────────────────────────────

test("discovery cannot see the strategy, and the signature is the guarantee", () => {
  /*
   * Not an inspection of intent — an inspection of reach. `discoverStressWindows`
   * takes exactly two arguments, and neither is or contains anything a run
   * produces. A third parameter, or a strategy-shaped field on the config, is
   * how this property would be lost, so both are asserted.
   */
  assert.equal(discoverStressWindows.length, 2,
    "discovery takes candles and a configuration, and nothing else");

  const configKeys = new Set([
    "method", "lengthBars", "topN", "minSeparationBars", "manualWindows",
  ]);
  const used: StressWindowConfig = {
    method: "worst_return", lengthBars: 4, topN: 1,
    minSeparationBars: 4, manualWindows: [],
  };
  for (const key of Object.keys(used)) {
    assert.ok(configKeys.has(key),
      `${key} is not a market-data input; stress windows must not be selectable by it`);
  }

  // And the same benchmark yields the same windows regardless of anything
  // else that may be happening — the report is a function of the series.
  const candles = twoEpisodes();
  assert.deepEqual(
    discoverStressWindows(candles, BASE),
    discoverStressWindows([...candles], BASE),
    "discovery must be a pure function of the benchmark series and the config",
  );
});

// ── Ranking ─────────────────────────────────────────────────────────────────

test("the worst window ranks first, and the ranking is by the named metric", () => {
  const windows = discoverStressWindows(twoEpisodes(), BASE);
  assert.equal(windows.length, 2);
  assert.equal(windows[0]!.rank, 1);
  assert.equal(windows[1]!.rank, 2);
  assert.ok(windows[0]!.benchmarkReturnPct < windows[1]!.benchmarkReturnPct,
    "rank 1 must be the more severe window, not merely the earlier one");
  // The crash is -45% over ten bars; the milder fall is about -16%.
  assert.ok(windows[0]!.benchmarkReturnPct < -40, `${windows[0]!.benchmarkReturnPct}`);
  assert.equal(windows[0]!.selectedBy.metric, "worst_return");
  assert.equal(windows[0]!.selectedBy.value, windows[0]!.benchmarkReturnPct,
    "the value ranked on must be the value reported, or the ranking is unauditable");
});

test("each method ranks on its own statistic", () => {
  const candles = twoEpisodes();
  const byDrawdown = discoverStressWindows(candles, { ...BASE, method: "deepest_drawdown" });
  assert.equal(byDrawdown[0]!.selectedBy.metric, "deepest_drawdown");
  assert.equal(byDrawdown[0]!.selectedBy.value, byDrawdown[0]!.benchmarkDrawdownPct);
  assert.ok(byDrawdown[0]!.benchmarkDrawdownPct >= byDrawdown[1]!.benchmarkDrawdownPct);

  const byVol = discoverStressWindows(candles, { ...BASE, method: "highest_volatility" });
  assert.equal(byVol[0]!.selectedBy.metric, "highest_volatility");
  assert.ok(byVol[0]!.benchmarkVolatilityPct >= byVol[1]!.benchmarkVolatilityPct);

  // Every window reports all three statistics whichever one it was ranked on,
  // so a reader can see what "worst" meant here rather than taking it on trust.
  for (const w of [...byDrawdown, ...byVol]) {
    assert.ok(Number.isFinite(w.benchmarkReturnPct));
    assert.ok(Number.isFinite(w.benchmarkDrawdownPct));
    assert.ok(Number.isFinite(w.benchmarkVolatilityPct));
  }
});

test("ties are broken by the earlier window, so the report is stable", () => {
  // A perfectly flat benchmark: every window scores identically. Without a
  // total order the top N would depend on array order, and the same inputs
  // would produce different reports on different days.
  const flat = series(new Array(40).fill(100));
  const a = discoverStressWindows(flat, { method: "worst_return", lengthBars: 5, topN: 3 });
  const b = discoverStressWindows(flat, { method: "worst_return", lengthBars: 5, topN: 3 });
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((w) => w.startMs), [...a.map((w) => w.startMs)].sort((x, y) => x - y),
    "equal severity must resolve to the earlier window");
});

// ── Overlap and separation ──────────────────────────────────────────────────

test("the top N is N distinct episodes, not N shifts of one crash", () => {
  /*
   * A rolling window one bar to the left of the worst window is the
   * second-worst window, so an unseparated top 5 is the same crash five times.
   * Separation defaults to the window length, which is exactly non-overlap.
   */
  const windows = discoverStressWindows(twoEpisodes(), { ...BASE, topN: 5 });
  for (let i = 1; i < windows.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const overlaps = windows[i]!.startMs < windows[j]!.endMs
        && windows[j]!.startMs < windows[i]!.endMs;
      assert.ok(!overlaps,
        `windows ${j} and ${i} overlap: the top N is reporting one episode repeatedly`);
    }
  }
});

test("a smaller separation permits deliberate overlap, and is honoured exactly", () => {
  const tight = discoverStressWindows(twoEpisodes(),
    { ...BASE, topN: 3, minSeparationBars: 2 });
  assert.equal(tight.length, 3);
  const starts = tight.map((w) => w.startMs).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i]! - starts[i - 1]! >= 2 * HOUR,
      "selected windows must respect the separation that was asked for");
  }
});

test("topN is a ceiling, not a promise", () => {
  // A short benchmark simply cannot hold five separated ten-bar windows, and
  // padding the list to five would mean inventing episodes.
  const windows = discoverStressWindows(series(new Array(25).fill(0).map((_, i) => 100 - i)),
    { ...BASE, topN: 5 });
  assert.ok(windows.length >= 1 && windows.length <= 5);
  assert.deepEqual(windows.map((w) => w.rank), windows.map((_, i) => i + 1),
    "ranks must remain contiguous from 1 however many windows were found");
});

// ── Refusals ────────────────────────────────────────────────────────────────

test("insufficient history is refused, with the arithmetic that refused it", () => {
  assert.throws(
    () => discoverStressWindows(series(new Array(5).fill(100)), { ...BASE, lengthBars: 10 }),
    (error: unknown) => error instanceof StressDiscoveryError
      && /5 bars/.test((error as Error).message)
      && /10-bar window/.test((error as Error).message),
    "a benchmark too short for the window must say both numbers",
  );
});

test("an empty benchmark is refused rather than reported as no stress", () => {
  // "No windows" and "no data" are different answers and must not collapse:
  // an empty report reads as "this market was never stressed".
  assert.throws(() => discoverStressWindows([], BASE), StressDiscoveryError);
  assert.throws(() => discoverStressWindows([], { ...BASE, method: "manual", manualWindows: [
    { startMs: T0, endMs: T0 + HOUR },
  ] }), StressDiscoveryError);
});

test("invalid configuration is refused at the door", () => {
  const candles = twoEpisodes();
  for (const lengthBars of [0, 1, -5, 2.5]) {
    assert.throws(() => discoverStressWindows(candles, { ...BASE, lengthBars }),
      StressDiscoveryError, `lengthBars ${lengthBars} must be refused`);
  }
  for (const topN of [0, -1, 1.5]) {
    assert.throws(() => discoverStressWindows(candles, { ...BASE, topN }),
      StressDiscoveryError, `topN ${topN} must be refused`);
  }
  for (const minSeparationBars of [0, -1, 2.5]) {
    assert.throws(() => discoverStressWindows(candles, { ...BASE, minSeparationBars }),
      StressDiscoveryError, `minSeparationBars ${minSeparationBars} must be refused`);
  }
  assert.throws(() => discoverStressWindows(candles, { ...BASE, method: "manual" }),
    /needs at least one window/, "the manual method with no windows is a configuration error");
});

// ── Manual windows ──────────────────────────────────────────────────────────

test("manual windows snap to benchmark bars and rank by date", () => {
  const candles = twoEpisodes();
  const windows = discoverStressWindows(candles, {
    method: "manual", lengthBars: 10, topN: 10,
    manualWindows: [
      // Given out of order, and starting mid-bar on purpose.
      { startMs: T0 + 50 * HOUR + 12 * 60_000, endMs: T0 + 60 * HOUR, label: "second fall" },
      { startMs: T0 + 20 * HOUR + 30 * 60_000, endMs: T0 + 30 * HOUR, label: "the crash" },
    ],
  });

  assert.equal(windows.length, 2);
  assert.equal(windows[0]!.label, "the crash", "manual windows rank by date, not by input order");
  assert.equal(windows[1]!.label, "second fall");
  for (const w of windows) {
    assert.ok(candles.some((bar) => bar.openTime === w.startMs),
      "a window must begin on a benchmark bar, or its statistics describe a different period");
    assert.ok(candles.some((bar) => bar.closeTime === w.endMs),
      "a window must end on a benchmark bar");
    assert.equal(w.selectedBy.metric, "manual");
  }
});

test("a PARTLY covered manual window is refused too — clipping was the whole bug", () => {
  /*
   * Only a window lying wholly outside raised. One straddling an edge was
   * silently clipped to whatever the benchmark had, and reported as the window
   * that was asked for — with its return, drawdown and volatility computed over
   * a period the user never named. The docstring, `docs/STRESS-ANALYSIS.md` and
   * the very next test's NAME all said it was refused.
   */
  const candles = twoEpisodes();
  const firstOpen = candles[0]!.openTime;
  assert.throws(
    () => discoverStressWindows(candles, {
      method: "manual", lengthBars: 10, topN: 1,
      // Starts five days before the benchmark does, ends inside it.
      manualWindows: [{ startMs: firstOpen - 5 * 24 * HOUR, endMs: firstOpen + 10 * HOUR }],
    }),
    /partly covered window is refused rather than clipped/,
    "a window the benchmark only partly covers must be refused",
  );

  // Snapping to a bar boundary is expected and is NOT clipping: a window asked
  // for mid-bar still resolves, because the bar it lands in is the bar it meant.
  const snapped = discoverStressWindows(candles, {
    method: "manual", lengthBars: 10, topN: 1,
    manualWindows: [{
      startMs: candles[20]!.openTime + 12 * 60_000,
      endMs: candles[30]!.closeTime - 12 * 60_000,
    }],
  });
  assert.equal(snapped.length, 1);
  assert.equal(snapped[0]!.startMs, candles[20]!.openTime);
});

test("a manual window outside the benchmark's coverage is refused, not clipped", () => {
  assert.throws(
    () => discoverStressWindows(twoEpisodes(), {
      method: "manual", lengthBars: 10, topN: 1,
      manualWindows: [{ startMs: T0 - 500 * HOUR, endMs: T0 - 400 * HOUR }],
    }),
    /no bars between/,
    "silently clipping would report statistics for a period the user did not ask about",
  );
  assert.throws(
    () => discoverStressWindows(twoEpisodes(), {
      method: "manual", lengthBars: 10, topN: 1,
      manualWindows: [{ startMs: T0 + 10 * HOUR, endMs: T0 + 10 * HOUR }],
    }),
    /must end after it starts/,
  );
});

// ── Alignment, reproducibility, and the epistemic note ──────────────────────

test("a window's boundaries are benchmark bar boundaries", () => {
  const candles = twoEpisodes();
  for (const w of discoverStressWindows(candles, { ...BASE, topN: 3 })) {
    const i = candles.findIndex((bar) => bar.openTime === w.startMs);
    assert.ok(i >= 0, "the start must be an exact bar open");
    assert.equal(candles[i + w.bars - 1]!.closeTime, w.endMs,
      "the end must be the close of the last bar in the window");
    assert.equal(w.bars, BASE.lengthBars);
  }
});

test("bar counts come from the interval, so a duration means the same everywhere", () => {
  assert.equal(barsForDuration(30 * 24 * HOUR, "1h"), 720);
  assert.equal(barsForDuration(30 * 24 * HOUR, "1d"), 30);
  assert.equal(barsForDuration(0, "1h"), 2, "a window is never shorter than two bars");
});

test("provenance records enough to regenerate the same windows", () => {
  const candles = twoEpisodes();
  const config: StressWindowConfig = { ...BASE, topN: 3, minSeparationBars: 7 };
  const p = stressProvenance({
    symbol: "BTCUSDT",
    canonicalInstrument: "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot",
    interval: "1h", providerId: "binance-spot", feedId: "binance-public-klines",
  }, candles, config);

  assert.equal(p.schemaVersion, "stress-discovery.v1");
  // "BTC's worst week" is a different week on a different venue's series, so
  // the benchmark's identity is part of the result, not context around it.
  assert.equal(p.benchmark.symbol, "BTCUSDT");
  assert.equal(p.benchmark.providerId, "binance-spot");
  assert.equal(p.benchmark.interval, "1h");
  // The period SEARCHED, which is not the periods returned.
  assert.equal(p.searched.startMs, candles[0]!.openTime);
  assert.equal(p.searched.endMs, candles[candles.length - 1]!.closeTime);
  assert.equal(p.searched.bars, candles.length);
  assert.deepEqual(p.config, {
    method: "worst_return", lengthBars: 10, topN: 3,
    minSeparationBars: 7, manualWindows: undefined,
  });

  // Replaying the stored configuration must reproduce the stored windows.
  assert.deepEqual(
    discoverStressWindows(candles, {
      method: p.config.method, lengthBars: p.config.lengthBars,
      topN: p.config.topN, minSeparationBars: p.config.minSeparationBars,
    }),
    discoverStressWindows(candles, config),
  );
});

test("the epistemic note is carried on the record, not left to the caller", () => {
  const p = stressProvenance({
    symbol: "BTCUSDT", canonicalInstrument: null, interval: "1h",
    providerId: "binance-spot", feedId: "binance-public-klines",
  }, twoEpisodes(), BASE);
  assert.equal(p.epistemicNote, STRESS_EPISTEMIC_NOTE);
  assert.match(STRESS_EPISTEMIC_NOTE, /hindsight/);
  assert.match(STRESS_EPISTEMIC_NOTE, /not out-of-sample evidence/);
  assert.match(STRESS_EPISTEMIC_NOTE, /does not support a claim about future performance/);
});

test("the benchmark is named independently of the traded instrument", () => {
  /*
   * "How does my SOL strategy behave when BTC falls apart" is the question
   * this feature exists for, so nothing in discovery may assume the benchmark
   * IS the traded symbol. The series is simply whatever was passed.
   */
  const btc = discoverStressWindows(twoEpisodes(), BASE);
  const sol = discoverStressWindows(
    twoEpisodes().map((bar) => ({ ...bar, symbol: "SOLUSDT" })), BASE);
  assert.deepEqual(btc.map((w) => [w.startMs, w.endMs]), sol.map((w) => [w.startMs, w.endMs]),
    "discovery reads the series it is given and nothing about which symbol it is");
});
