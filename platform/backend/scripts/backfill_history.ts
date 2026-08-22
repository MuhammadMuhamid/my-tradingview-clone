/**
 * Deep-history backfill: 2 years of 15m/5m/1h/4h/1d and 90 days of 1m for
 * every active symbol. Idempotent — re-running only fetches what's missing.
 *
 *   npx tsx scripts/backfill_history.ts [SYMBOL ...]
 */
import { listSymbols } from "../src/repositories/symbols";
import { countCandles } from "../src/repositories/candles";
import { ensureCandles } from "../src/data/binanceRest";
import { closePool } from "../src/db/pool";
import type { Interval } from "../src/types/market";

const DAY = 86_400_000;
const PLAN: [Interval, number][] = [
  ["15m", 730 * DAY],
  ["5m", 730 * DAY],
  ["1h", 730 * DAY],
  ["4h", 730 * DAY],
  ["1d", 730 * DAY],
  ["1m", 300 * DAY],
];

async function main(): Promise<void> {
  const args = process.argv.slice(2).map((s) => s.toUpperCase());
  const symbols = args.length > 0 ? args : (await listSymbols(true)).map((s) => s.symbol);
  const now = Date.now();
  for (const symbol of symbols) {
    for (const [interval, span] of PLAN) {
      const t0 = Date.now();
      process.stdout.write(`${symbol} ${interval}: `);
      try {
        await ensureCandles(symbol, interval, now - span, now, (m) => process.stdout.write(m + " "));
        const n = await countCandles(symbol, interval);
        console.log(`ok — ${n.toLocaleString()} bars stored (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      } catch (err) {
        console.log(`FAILED: ${(err as Error).message}`);
      }
    }
  }
  await closePool();
  console.log("backfill complete");
}

main().catch((err) => { console.error(err); process.exit(1); });
