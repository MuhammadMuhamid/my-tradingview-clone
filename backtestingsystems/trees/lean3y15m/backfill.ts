/**
 * Extend 15m + 5m history for the MTF Lean universe so the 3-year test has feeds.
 * Lean reads a 5m series (s4_tf) as well as the 15m chart, so both are needed.
 *
 * Two narrow windows per interval on purpose: ensureCandles treats >=98.5%
 * coverage of the requested range as complete, so one wide 2023->today request
 * would skip both the missing head and the missing tail.
 *
 *   npx tsx lean3y15m/backfill.ts
 */
import { ensureCandles } from "../../../platform/backend/src/data/binanceRest";
import { countCandles } from "../../../platform/backend/src/repositories/candles";
import { closePool } from "../../../platform/backend/src/db/pool";
import type { Interval } from "../../../platform/backend/src/types/market";

const HEAD: [number, number] = [Date.parse("2023-08-01T00:00:00Z"), Date.parse("2024-07-12T00:00:00Z")];
const TAIL: [number, number] = [Date.parse("2026-07-20T00:00:00Z"), Date.now()];

const COINS = ["DEXEUSDT", "SYNUSDT", "ZECUSDT", "RIFUSDT", "NEARUSDT", "KAITOUSDT", "JTOUSDT",
  "TAOUSDT", "PUMPUSDT", "EIGENUSDT", "MORPHOUSDT", "JSTUSDT", "ENAUSDT", "JUPUSDT",
  "INJUSDT", "PYTHUSDT", "TIAUSDT", "ALLOUSDT"];

async function main(): Promise<void> {
  for (const interval of ["15m", "5m"] as Interval[]) {
    console.log(`\n──── ${interval} ────`);
    for (const s of COINS) {
      const before = await countCandles(s, interval);
      for (const [from, to] of [HEAD, TAIL]) {
        try { await ensureCandles(s, interval, from, to, () => {}); }
        catch { /* coin did not exist in that range — expected for late listings */ }
      }
      const after = await countCandles(s, interval);
      console.log(`${s.padEnd(12)} ${before.toLocaleString().padStart(9)} -> ${after.toLocaleString().padStart(9)} (+${(after - before).toLocaleString()})`);
    }
  }
  await closePool();
}
main().catch((e) => { console.error(e); process.exit(1); });
