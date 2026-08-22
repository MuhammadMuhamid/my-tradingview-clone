/** Verify each required feed is internally dense and current before optimizers start. */
import { query, closePool } from "../src/db/pool";
import type { Interval } from "../src/types/market";
import { INTERVAL_MS } from "../src/types/market";

const COINS = [
  "SYNUSDT", "币安人生USDT", "ALLOUSDT", "DEXEUSDT", "RIFUSDT", "ZECUSDT",
  "JTOUSDT", "NEARUSDT", "INJUSDT", "MORPHOUSDT", "KAITOUSDT", "EIGENUSDT",
  "TAOUSDT", "TIAUSDT", "ALGOUSDT", "JUPUSDT", "JSTUSDT", "APEUSDT",
  "ENAUSDT", "PYTHUSDT", "PUMPUSDT", "ARBUSDT", "APTUSDT",
];
// These are the complete feed intervals reachable from the optimizer's fixed
// timeframe profile. Daily candles are not requested by this search space.
const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h"];
const DAY = 86_400_000;
const START = Date.parse("2025-07-20T00:00:00Z");
const WARMUP: Record<Interval, number> = {
  "1m": 3 * DAY, "3m": 0, "5m": 10 * DAY, "15m": 40 * DAY, "30m": 0,
  "1h": 90 * DAY, "2h": 0, "4h": 240 * DAY, "6h": 0, "12h": 0, "1d": 730 * DAY,
};
// Earliest Binance spot candle dates for symbols listed after some requested
// warmup windows. All unlisted entries predate every relevant requested start.
const LISTED_AT: Record<string, number> = {
  "币安人生USDT": Date.parse("2026-01-07T00:00:00Z"),
  ALLOUSDT: Date.parse("2025-11-11T00:00:00Z"),
  MORPHOUSDT: Date.parse("2025-10-03T00:00:00Z"),
  KAITOUSDT: Date.parse("2025-02-20T00:00:00Z"),
  EIGENUSDT: Date.parse("2024-10-01T00:00:00Z"),
  TAOUSDT: Date.parse("2024-04-11T00:00:00Z"),
  TIAUSDT: Date.parse("2023-10-31T00:00:00Z"),
  JUPUSDT: Date.parse("2024-01-31T00:00:00Z"),
  JTOUSDT: Date.parse("2023-12-07T00:00:00Z"),
  ENAUSDT: Date.parse("2024-04-02T00:00:00Z"),
  PYTHUSDT: Date.parse("2024-02-02T00:00:00Z"),
  PUMPUSDT: Date.parse("2025-09-11T00:00:00Z"),
  // Binance's currently exposed ARBUSDT one-minute series begins here.
  ARBUSDT: Date.parse("2025-09-13T00:00:00Z"),
};

interface CoverageRow {
  symbol: string;
  interval: Interval;
  bars: string;
  first_ms: string;
  last_ms: string;
}

async function main(): Promise<void> {
  const { rows } = await query<CoverageRow>(`
    SELECT symbol, interval, count(*)::text bars,
      (extract(epoch FROM min(open_time))*1000)::bigint::text first_ms,
      (extract(epoch FROM max(open_time))*1000)::bigint::text last_ms
    FROM candles
    WHERE symbol = ANY($1) AND interval = ANY($2)
    GROUP BY symbol, interval
  `, [COINS, INTERVALS]);
  const byKey = new Map(rows.map((r) => [`${r.symbol}|${r.interval}`, r]));
  const now = Date.now();
  const failures: string[] = [];
  for (const symbol of COINS) {
    for (const interval of INTERVALS) {
      const r = byKey.get(`${symbol}|${interval}`);
      if (!r) {
        failures.push(`${symbol} ${interval}: missing`);
        continue;
      }
      const step = INTERVAL_MS[interval];
      const bars = Number(r.bars), first = Number(r.first_ms), last = Number(r.last_ms);
      const expectedSinceFirst = Math.floor((last - first) / step) + 1;
      const density = expectedSinceFirst > 0 ? bars / expectedSinceFirst : 0;
      const tailBars = Math.floor((now - last) / step);
      const requestedFirst = START - WARMUP[interval];
      const expectedFirst = Math.max(requestedFirst, LISTED_AT[symbol] ?? 0);
      // Newly listed symbols commonly begin several hours into their UTC
      // listing day. Treat that day as complete coverage for validation.
      const listingDayGrace = LISTED_AT[symbol] ? DAY : step * 2;
      const missingStart = first > expectedFirst + listingDayGrace;
      // A running one-minute feed may be two complete bars plus the current
      // partially formed bar behind Date.now(), which floors to three here.
      if (density < 0.985 || tailBars > 3 || missingStart) {
        failures.push(
          `${symbol} ${interval}: first=${new Date(first).toISOString().slice(0, 10)} ` +
          `expected<=${new Date(expectedFirst).toISOString().slice(0, 10)} ` +
          `density=${(density * 100).toFixed(2)}% tail=${tailBars} bars`
        );
      }
    }
  }
  if (failures.length) {
    console.error(`FEED VALIDATION FAILED (${failures.length})`);
    failures.forEach((f) => console.error(`  ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`FEED VALIDATION PASSED: ${COINS.length} symbols × ${INTERVALS.length} intervals`);
  }
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
