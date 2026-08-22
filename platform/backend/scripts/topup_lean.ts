/**
 * Top up the candle feeds the MTF Lean optimizers actually consume (5m + 15m,
 * optimizer coin universe only) up to now. Idempotent — ensureCandles fetches
 * only what is missing, so re-running is cheap.
 *
 *   npx tsx scripts/topup_lean.ts [SYMBOL ...]
 */
import fs from "node:fs";
import path from "node:path";
import { ensureCandles } from "../src/data/binanceRest";
import { closePool } from "../src/db/pool";
import * as candleRepo from "../src/repositories/candles";
import type { Interval } from "../src/types/market";

const DAY = 86_400_000;
const INTERVALS: Interval[] = ["5m", "15m"];

function universe(): string[] {
  const f = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, " ")), "..", "optimizer1y5m", "coins.txt");
  return fs.readFileSync(f, "utf8").split("\n").map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbols = args.length > 0 ? args : universe();
  const now = Date.now();
  let ok = 0, failed: string[] = [];
  for (const symbol of symbols) {
    for (const interval of INTERVALS) {
      const existing = await candleRepo.getCandles(symbol, interval, { from: now - 400 * DAY, to: now });
      const last = existing.length ? existing[existing.length - 1]!.openTime : now - 400 * DAY;
      const staleDays = (now - last) / DAY;
      if (staleDays < 0.05) { console.log(`${symbol} ${interval}: current`); ok++; continue; }
      // Re-request from a little before the last stored bar so any partial tail is repaired.
      const from = last - 2 * DAY;
      process.stdout.write(`${symbol} ${interval}: ${staleDays.toFixed(1)}d behind -> `);
      try {
        await ensureCandles(symbol, interval, from, now);
        const after = await candleRepo.getCandles(symbol, interval, { from: now - 3 * DAY, to: now });
        const newest = after.length ? new Date(after[after.length - 1]!.openTime).toISOString().slice(0, 16) : "none";
        console.log(`ok, newest ${newest}`);
        ok++;
      } catch (err) {
        console.log(`FAILED: ${(err as Error).message}`);
        failed.push(`${symbol} ${interval}`);
      }
    }
  }
  await closePool();
  console.log(`\ndone: ${ok} feed(s) current${failed.length ? `, FAILED: ${failed.join(", ")}` : ""}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
