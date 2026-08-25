/**
 * Deterministic candle-pipeline benchmark.
 *
 * ── What this measures, and what it does NOT ─────────────────────────────
 *
 * MEASURED, because it is pure computation over a fixture:
 *   * row → `Candle` mapping, the shape `repositories/candles.ts` produces
 *   * JSON serialisation and the wire size that produces
 *   * JSON parse, which is what the browser pays before it can draw anything
 *   * the chart's candle → series transformation
 *   * moving-average computation, the dominant per-update cost on the chart
 *   * the contiguity check the live path now runs before evaluating
 *
 * NOT MEASURED, and not estimated:
 *   * PostgreSQL query time — no database is available in this workspace
 *   * browser paint, layout, long tasks and memory growth — no browser
 *   * real network latency, Binance backfill time, websocket delivery
 *
 * Numbers for the second group would be invented, so this prints them as
 * `unmeasured` rather than guessing. `docs/CANDLE-PERFORMANCE.md` records the
 * same distinction.
 *
 * Run:
 *   npm run bench:candles            # every supported timeframe
 *   npm run bench:candles -- 15m     # one
 *
 * Output is a JSON blob so two runs can be diffed. Timings vary between
 * machines; the RATIO between before and after on the same machine is the
 * meaningful figure, and the header records the environment.
 */
import os from "node:os";
import { checkSeries } from "../src/data/candleSeries";
import { fromCompact, toCompact } from "../src/data/candleWire";
import { sma, ema } from "../src/engine/ta";
import { INTERVALS, INTERVAL_MS, type Candle, type Interval } from "../src/types/market";

/** The bar counts the chart's own selector offers. */
const BAR_COUNTS = [500, 2000, 10_000, 50_000];

/** The MA set every coin chart draws: SMA and EMA at five lengths. */
const MA_LENGTHS = [200, 100, 50, 21, 15];

/**
 * A deterministic price series. Seeded arithmetic rather than `Math.random`,
 * so two runs on the same machine measure the same work.
 */
function fixture(interval: Interval, count: number): Candle[] {
  const step = INTERVAL_MS[interval];
  const out: Candle[] = new Array(count);
  let price = 100;
  for (let i = 0; i < count; i++) {
    // A cheap deterministic walk with a repeating period, so the series has
    // realistic structure without a PRNG.
    price += Math.sin(i / 37) * 0.4 + Math.cos(i / 11) * 0.15;
    const openTime = i * step;
    const open = price;
    const close = price + Math.sin(i / 5) * 0.2;
    out[i] = {
      symbol: "BENCHUSDT",
      interval,
      openTime,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 1000 + (i % 97),
      quoteVolume: (1000 + (i % 97)) * price,
      tradeCount: 50 + (i % 13),
      closeTime: openTime + step - 1,
    };
  }
  return out;
}

/** The database row shape, so the mapping cost is measured honestly. */
interface Row {
  symbol: string; interval: Interval; open_time: Date;
  open: number; high: number; low: number; close: number; volume: number;
  quote_volume: number | null; trade_count: number | null; close_time: Date;
}

const toRows = (candles: Candle[]): Row[] =>
  candles.map((c) => ({
    symbol: c.symbol, interval: c.interval, open_time: new Date(c.openTime),
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    quote_volume: c.quoteVolume ?? null, trade_count: c.tradeCount ?? null,
    close_time: new Date(c.closeTime),
  }));

/** Exactly `repositories/candles.ts:toCandle`. */
const toCandle = (r: Row): Candle => ({
  symbol: r.symbol,
  interval: r.interval,
  openTime: r.open_time.getTime(),
  open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  quoteVolume: r.quote_volume ?? undefined,
  tradeCount: r.trade_count ?? undefined,
  closeTime: r.close_time.getTime(),
});

/** Exactly the chart's candle → series transformation. */
const toSeries = (candles: Candle[]): { time: number; open: number; high: number; low: number; close: number }[] =>
  candles.map((c) => ({
    time: Math.floor(c.openTime / 1000),
    open: c.open, high: c.high, low: c.low, close: c.close,
  }));

/** Every MA overlay the chart draws, as `buildMaOverlays` does. */
function buildAllMas(candles: Candle[]): number {
  const closes = candles.map((c) => c.close);
  let points = 0;
  for (const length of MA_LENGTHS) {
    points += sma(closes, length).length;
    points += ema(closes, length).length;
  }
  return points;
}

/** Median of `runs` timings, in milliseconds. Median, not mean: one GC pause
 *  in a five-run sample moves a mean and does not move a median. */
function timeIt(runs: number, fn: () => unknown): number {
  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

interface Measurement {
  interval: Interval;
  bars: number;
  rowToCandleMs: number;
  serialiseMs: number;
  parseMs: number;
  payloadBytes: number;
  payloadBytesPerBar: number;
  toSeriesMs: number;
  movingAveragesMs: number;
  contiguityCheckMs: number;
  /** Everything the browser pays between the response arriving and a first paint. */
  clientCriticalPathMs: number;

  // ── The compact wire format, measured against the same fixture ──
  compactSerialiseMs: number;
  compactParseMs: number;
  compactExpandMs: number;
  compactPayloadBytes: number;
  compactPayloadBytesPerBar: number;
  compactClientCriticalPathMs: number;
  /** Payload reduction, as a percentage. */
  payloadReductionPct: number;
  /** Client critical path speed-up, as a multiple. */
  clientSpeedup: number;
}

function measure(interval: Interval, bars: number, runs: number): Measurement {
  const candles = fixture(interval, bars);
  const rows = toRows(candles);

  const rowToCandleMs = timeIt(runs, () => rows.map(toCandle));
  const json = JSON.stringify(candles);
  const serialiseMs = timeIt(runs, () => JSON.stringify(candles));
  const parseMs = timeIt(runs, () => JSON.parse(json) as Candle[]);
  const toSeriesMs = timeIt(runs, () => toSeries(candles));
  const movingAveragesMs = timeIt(runs, () => buildAllMas(candles));
  const contiguityCheckMs = timeIt(runs, () => checkSeries(candles, interval));

  // The compact path, on the same fixture.
  const compactPayload = toCompact(candles, "BENCHUSDT", interval);
  const compactJson = JSON.stringify(compactPayload);
  const compactSerialiseMs = timeIt(runs, () => JSON.stringify(toCompact(candles, "BENCHUSDT", interval)));
  const compactParseMs = timeIt(runs, () => JSON.parse(compactJson));
  const compactExpandMs = timeIt(runs, () => fromCompact(JSON.parse(compactJson)));

  const verboseBytes = Buffer.byteLength(json, "utf8");
  const compactBytes = Buffer.byteLength(compactJson, "utf8");
  const clientPath = parseMs + toSeriesMs + movingAveragesMs;
  // The compact path pays an expansion step the verbose one does not, so it is
  // included — otherwise the comparison would flatter the new code.
  const compactClientPath = compactParseMs + compactExpandMs + toSeriesMs + movingAveragesMs;

  return {
    interval,
    bars,
    rowToCandleMs,
    serialiseMs,
    parseMs,
    payloadBytes: verboseBytes,
    payloadBytesPerBar: Math.round(verboseBytes / bars),
    toSeriesMs,
    movingAveragesMs,
    contiguityCheckMs,
    // What a user waits through after the bytes land: parse, transform, MAs.
    clientCriticalPathMs: clientPath,

    compactSerialiseMs,
    compactParseMs,
    compactExpandMs,
    compactPayloadBytes: compactBytes,
    compactPayloadBytesPerBar: Math.round(compactBytes / bars),
    compactClientCriticalPathMs: compactClientPath,
    payloadReductionPct: Number((100 - (100 * compactBytes) / verboseBytes).toFixed(1)),
    clientSpeedup: Number((clientPath / compactClientPath).toFixed(2)),
  };
}

function main(): void {
  const arg = process.argv[2];
  const intervals: readonly Interval[] = arg
    ? [arg as Interval]
    : INTERVALS;
  for (const i of intervals) {
    if (!(INTERVALS as readonly string[]).includes(i)) {
      throw new Error(`unknown interval ${i}; expected one of ${INTERVALS.join(", ")}`);
    }
  }

  const runs = Number(process.env.BENCH_RUNS ?? 5);
  const measurements: Measurement[] = [];
  for (const interval of intervals) {
    for (const bars of BAR_COUNTS) {
      measurements.push(measure(interval, bars, runs));
    }
  }

  console.log(JSON.stringify({
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      runsPerMeasurement: runs,
    },
    unmeasured: [
      "PostgreSQL query time — no database is available in this workspace",
      "browser paint, layout, long tasks, memory growth — no browser harness",
      "network latency, Binance backfill duration, websocket delivery",
    ],
    barCounts: BAR_COUNTS,
    maSeriesPerChart: MA_LENGTHS.length * 2,
    measurements,
  }, null, 2));
}

main();
