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
  barsForDuration, discoverStressWindows, MAX_STRESS_LENGTH_BARS, MAX_STRESS_SCAN_CELLS,
  MAX_STRESS_TOP_N, StressDiscoveryError, stressProvenance, STRESS_EPISTEMIC_NOTE,
  validateStressConfig, type StressWindowConfig,
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

// ── Bounded work, and the same answers as before ────────────────────────────

/**
 * The discovery this module shipped with, kept verbatim as the oracle.
 *
 * It scored every position by computing all three statistics over every bar
 * of the window, then sorted every position. The current implementation
 * computes only the ranked statistic and selects without sorting; a stored
 * run's windows must replay from its provenance byte for byte, so the two
 * must agree EXACTLY — `deepStrictEqual`, not a tolerance.
 */
function referenceDiscover(candles: readonly Candle[], config: StressWindowConfig) {
  const { method, lengthBars, topN } = config;
  const minSeparationBars = config.minSeparationBars ?? lengthBars;
  const changePct = (from: number, to: number) => (from > 0 ? ((to - from) / from) * 100 : 0);
  const describe = (i: number, j: number) => {
    const first = candles[i]!;
    const last = candles[j]!;
    let peak = first.close;
    let worst = 0;
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let k = i; k <= j; k += 1) {
      const bar = candles[k]!;
      if (bar.close > peak) peak = bar.close;
      if (peak > 0) {
        const fall = ((peak - bar.low) / peak) * 100;
        if (fall > worst) worst = fall;
      }
      if (k > i) {
        const previous = candles[k - 1]!.close;
        if (previous > 0) {
          const r = ((bar.close - previous) / previous) * 100;
          sum += r; sumSq += r * r; n += 1;
        }
      }
    }
    const mean = n > 0 ? sum / n : 0;
    const variance = n > 1 ? Math.max(0, sumSq / n - mean * mean) : 0;
    return {
      returnPct: changePct(first.close, last.close),
      drawdownPct: worst,
      volatilityPct: Math.sqrt(variance),
    };
  };
  const scored: { index: number; severity: number; value: number }[] = [];
  for (let i = 0; i + lengthBars <= candles.length; i += 1) {
    const stats = describe(i, i + lengthBars - 1);
    const value = method === "worst_return" ? stats.returnPct
      : method === "deepest_drawdown" ? stats.drawdownPct
        : stats.volatilityPct;
    const severity = method === "worst_return" ? -stats.returnPct : value;
    scored.push({ index: i, severity, value });
  }
  scored.sort((a, b) => b.severity - a.severity || a.index - b.index);
  const chosen: typeof scored = [];
  for (const candidate of scored) {
    if (chosen.length >= topN) break;
    if (chosen.some((taken) => Math.abs(taken.index - candidate.index) < minSeparationBars)) continue;
    chosen.push(candidate);
  }
  return chosen.map((entry, i) => {
    const j = entry.index + lengthBars - 1;
    const stats = describe(entry.index, j);
    return {
      rank: i + 1,
      startMs: candles[entry.index]!.openTime,
      endMs: candles[j]!.closeTime,
      bars: lengthBars,
      benchmarkReturnPct: stats.returnPct,
      benchmarkDrawdownPct: stats.drawdownPct,
      benchmarkVolatilityPct: stats.volatilityPct,
      selectedBy: { metric: method, value: entry.value },
    };
  });
}

/** A seeded random walk with real intrabar range, so lows differ from closes. */
function randomWalk(n: number, seed: number, step = 0.02): Candle[] {
  let state = seed;
  const next = (): number => { state = (state * 16807) % 2147483647; return state / 2147483647; };
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    price = Math.max(0.01, price * (1 + (next() - 0.5) * step));
    candles.push({
      symbol: "BTCUSDT", interval: "1h",
      openTime: T0 + i * HOUR, closeTime: T0 + (i + 1) * HOUR - 1,
      open, close: price,
      high: Math.max(open, price) * (1 + next() * step / 4),
      low: Math.min(open, price) * (1 - next() * step / 4),
      volume: 1,
    });
  }
  return candles;
}

test("the bounded discovery returns exactly what the exhaustive one did", () => {
  /*
   * Fixtures chosen for where a faster implementation goes wrong: exact ties
   * (flat, and a sawtooth that repeats the same window many times), zero
   * prices (`changePct` refuses them), real intrabar range (drawdown reads
   * lows, not closes), and plain noise.
   */
  const sawtooth = series(new Array(120).fill(0).map((_, i) => 100 - (i % 12) * 2));
  const withZeros = series([100, 90, 0, 0, 50, 60, 0, 70, 65, 40, 45, 30, 35, 100, 20, 25]);
  const fixtures: [string, Candle[]][] = [
    ["two episodes", twoEpisodes()],
    ["flat", series(new Array(60).fill(100))],
    ["sawtooth ties", sawtooth],
    ["zero prices", withZeros],
    ["random walk A", randomWalk(400, 7)],
    ["random walk B", randomWalk(1500, 12345, 0.05)],
  ];
  const methods = ["worst_return", "deepest_drawdown", "highest_volatility"] as const;
  let compared = 0;
  for (const [name, candles] of fixtures) {
    for (const method of methods) {
      for (const lengthBars of [2, 3, 5, 10, 24]) {
        if (lengthBars > candles.length) continue;
        for (const topN of [1, 3, 10]) {
          for (const minSeparationBars of [undefined, 1, 4]) {
            const config: StressWindowConfig = {
              method, lengthBars, topN,
              ...(minSeparationBars === undefined ? {} : { minSeparationBars }),
            };
            assert.deepStrictEqual(
              discoverStressWindows(candles, config), referenceDiscover(candles, config),
              `${name} · ${method} · L=${lengthBars} · top ${topN} · sep ${minSeparationBars}`);
            compared += 1;
          }
        }
      }
    }
  }
  assert.ok(compared > 200, `only ${compared} configurations were compared`);
});

test("worst return is linear in the series, so a long minute-bar search does not stall", () => {
  /*
   * 540 days of 1-minute bars with a one-day window was measured holding the
   * event loop for 8.2 seconds (29 s on a slower machine), because every
   * position re-read all 1,440 bars of its window. Ranking on return needs
   * two closes per position. The ceiling is generous, so a loaded machine
   * does not fail it and the quadratic version cannot pass it.
   */
  const candles = randomWalk(400_000, 99, 0.004);
  const started = performance.now();
  const windows = discoverStressWindows(candles, { method: "worst_return", lengthBars: 1440, topN: 10 });
  const elapsed = performance.now() - started;
  assert.equal(windows.length, 10);
  assert.ok(elapsed < 3000, `discovery took ${Math.round(elapsed)} ms`);
});

test("the expensive rankings are bounded, and the refusal says what to change", () => {
  const candles = randomWalk(30_000, 3, 0.01);
  for (const method of ["deepest_drawdown", "highest_volatility"] as const) {
    assert.throws(
      () => discoverStressWindows(candles, { method, lengthBars: 1000, topN: 3 }),
      (error: unknown) => error instanceof StressDiscoveryError
        && (error as Error).message.includes(
          `more than one search may read (${MAX_STRESS_SCAN_CELLS.toLocaleString("en-US")})`)
        && /rank by worst return/.test((error as Error).message),
      `${method} over 29,001 positions × 1,000 bars must be refused`,
    );
  }
  // The same request ranked on return is not bounded by it.
  assert.equal(
    discoverStressWindows(candles, { method: "worst_return", lengthBars: 1000, topN: 3 }).length, 3);
  // And the route can refuse on an ESTIMATE, before it reads a candle.
  assert.throws(
    () => validateStressConfig({ method: "highest_volatility", lengthBars: 1440, topN: 3 }, 777_600),
    StressDiscoveryError);
  assert.doesNotThrow(
    () => validateStressConfig({ method: "worst_return", lengthBars: 1440, topN: 3 }, 777_600));
});

test("topN, window length and manual windows have ceilings", () => {
  const candles = twoEpisodes();
  assert.throws(
    () => discoverStressWindows(candles, { ...BASE, topN: MAX_STRESS_TOP_N + 1 }),
    /at most 10 windows can be kept/);
  assert.doesNotThrow(() => discoverStressWindows(candles, { ...BASE, topN: MAX_STRESS_TOP_N }));
  assert.throws(
    () => validateStressConfig({ ...BASE, lengthBars: MAX_STRESS_LENGTH_BARS + 1 }),
    /at most 20,000 benchmark bars/);
  const many = new Array(MAX_STRESS_TOP_N + 1).fill(0).map((_, i) => ({
    startMs: T0 + i * HOUR, endMs: T0 + (i + 2) * HOUR,
  }));
  assert.throws(
    () => discoverStressWindows(candles, {
      method: "manual", lengthBars: 2, topN: 1, manualWindows: many,
    }),
    /at most 10 manual windows/);
});
