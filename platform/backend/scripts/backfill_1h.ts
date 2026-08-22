/**
 * Targeted 1-hour backfill for the optimizer1h coin set. Idempotent — pulls
 * only the missing recent bars up to now, bringing the 1h history current so
 * the 1h optimizer backtests Nov 1 2025 → today.
 */
import { ensureCandles } from "../src/data/binanceRest";
import { query } from "../src/db/pool";

const COINS = [
  "DEXEUSDT", "MORPHOUSDT", "INJUSDT", "NEARUSDT", "JTOUSDT", "ZECUSDT",
  "ALGOUSDT", "TAOUSDT", "JUPUSDT", "TIAUSDT", "SYNUSDT", "RIFUSDT",
  "ALLOUSDT", "APEUSDT", "KAITOUSDT", "EIGENUSDT", "JSTUSDT", "币安人生USDT",
];

const HOUR = 3_600_000;

async function main(): Promise<void> {
  const now = Date.now();
  for (const symbol of COINS) {
    process.stdout.write(`${symbol} 1h: `);
    try {
      // Anchor the fetch at the last stored bar. ensureCandles treats a coin
      // as "covered" at >=98.5% of a 2y range, so a small recent tail gap is
      // otherwise skipped; a window starting at the last bar forces the fetch.
      const { rows } = await query<{ last: Date | null }>(
        "SELECT max(open_time) AS last FROM candles WHERE symbol=$1 AND interval='1h'",
        [symbol]
      );
      const last = rows[0]?.last;
      const start = last ? last.getTime() - HOUR : now - 730 * 86_400_000;
      await ensureCandles(symbol, "1h", start, now, (m) => process.stdout.write(m + " "));
      const { rows: after } = await query<{ n: string; last: Date }>(
        "SELECT count(*)::text AS n, max(open_time) AS last FROM candles WHERE symbol=$1 AND interval='1h'",
        [symbol]
      );
      console.log(`ok — ${after[0]!.n} bars, last ${after[0]!.last.toISOString().slice(0, 16)}`);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }
  process.exit(0);
}

main();
