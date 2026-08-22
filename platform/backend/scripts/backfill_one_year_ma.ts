/**
 * Exact feed coverage for the two one-year MA + R:R optimizers.
 * Covers 2025-07-20 through now plus the fixed warmups used by evalWorker.
 * Re-running is safe: candle upserts are idempotent and tails are refreshed.
 */
import { ensureCandles, fetchKlines, syncExchangeFilters } from "../src/data/binanceRest";
import { query, closePool } from "../src/db/pool";
import * as candleRepo from "../src/repositories/candles";
import type { Interval } from "../src/types/market";
import { INTERVAL_MS } from "../src/types/market";

const COINS = [
  "SYNUSDT", "币安人生USDT", "ALLOUSDT", "DEXEUSDT", "RIFUSDT", "ZECUSDT",
  "JTOUSDT", "NEARUSDT", "INJUSDT", "MORPHOUSDT", "KAITOUSDT", "EIGENUSDT",
  "TAOUSDT", "TIAUSDT", "ALGOUSDT", "JUPUSDT", "JSTUSDT", "APEUSDT",
  "ENAUSDT", "PYTHUSDT", "PUMPUSDT", "ARBUSDT", "APTUSDT",
];

const DAY = 86_400_000;
const START = Date.parse("2025-07-20T00:00:00Z");
const PLAN: [Interval, number][] = [
  ["1m", 3 * DAY],
  ["5m", 10 * DAY],
  ["15m", 40 * DAY],
  ["1h", 90 * DAY],
  ["4h", 240 * DAY],
  ["1d", 730 * DAY],
];
const targetArg = process.argv.find((arg) => arg.startsWith("--targets="));
const TARGETS = targetArg
  ? new Set(targetArg.slice("--targets=".length).split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const TAIL_ONLY = process.argv.includes("--tail-only");

async function refreshTail(symbol: string, interval: Interval, now: number): Promise<void> {
  const { rows } = await query<{ last_ms: string | null }>(
    "SELECT (extract(epoch from max(open_time))*1000)::bigint::text AS last_ms FROM candles WHERE symbol=$1 AND interval=$2",
    [symbol, interval]
  );
  const last = rows[0]?.last_ms ? Number(rows[0].last_ms) : null;
  if (last === null || last + INTERVAL_MS[interval] > now) return;
  const candles = await fetchKlines(symbol, interval, last + INTERVAL_MS[interval], now);
  if (candles.length) await candleRepo.upsertCandles(candles);
}

async function main(): Promise<void> {
  const now = Date.now();
  await syncExchangeFilters(COINS);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < COINS.length) {
      const symbol = COINS[cursor++]!;
    for (const [interval, warmup] of PLAN) {
      if (TARGETS && !TARGETS.has(`${symbol}:${interval}`)) continue;
      const from = START - warmup;
      const t0 = Date.now();
      process.stdout.write(`${symbol} ${interval}: `);
      try {
        if (!TAIL_ONLY) {
          await ensureCandles(symbol, interval, from, now, (msg) => process.stdout.write(msg + " "));
        }
        await refreshTail(symbol, interval, now);
        const { rows } = await query<{ n: string; first: Date; last: Date }>(
          "SELECT count(*)::text n,min(open_time) first,max(open_time) last FROM candles WHERE symbol=$1 AND interval=$2 AND open_time BETWEEN $3 AND $4",
          [symbol, interval, new Date(from), new Date(now)]
        );
        const r = rows[0]!;
        console.log(`${r.n} bars ${r.first?.toISOString().slice(0, 10)} → ${r.last?.toISOString().slice(0, 16)} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
      } catch (err) {
        console.log(`FAILED ${(err as Error).message}`);
      }
    }
    }
  };
  // Two symbols keeps the public Binance request weight comfortably below its
  // limit while halving wall-clock time versus the original serial pass.
  await Promise.all([worker(), worker()]);
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
