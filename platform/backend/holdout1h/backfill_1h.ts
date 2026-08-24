/**
 * Extend 1h history back to 2023-08-01 for the opt1hyear-results universe.
 *
 * Reuses src/data/binanceRest.ensureCandles (idempotent — only fetches gaps),
 * so this adds bars and never rewrites or deletes existing ones. 1h only:
 * the holdout test needs no other interval and pulling them would take hours.
 *
 *   npx tsx holdout1h/backfill_1h.ts [SYMBOL ...]
 */
import { ensureCandles } from "../src/data/binanceRest";
import { countCandles } from "../src/repositories/candles";
import { closePool } from "../src/db/pool";

const FROM = Date.parse("2023-08-01T00:00:00Z");
const TO = Date.parse("2025-07-20T00:00:00Z");

const COINS = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map((s) => s.toUpperCase())
  : ["ZECUSDT", "JSTUSDT", "NEARUSDT", "INJUSDT", "RIFUSDT", "DEXEUSDT", "SYNUSDT",
     "JTOUSDT", "JUPUSDT", "ENAUSDT", "TAOUSDT", "EIGENUSDT", "KAITOUSDT"];

async function main(): Promise<void> {
  for (const symbol of COINS) {
    const before = await countCandles(symbol, "1h");
    const t0 = Date.now();
    process.stdout.write(`${symbol} 1h: `);
    try {
      await ensureCandles(symbol, "1h", FROM, TO, (m) => process.stdout.write(m + " "));
      const after = await countCandles(symbol, "1h");
      console.log(`ok — ${before.toLocaleString()} -> ${after.toLocaleString()} bars (+${(after - before).toLocaleString()}) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`);
    }
  }
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
