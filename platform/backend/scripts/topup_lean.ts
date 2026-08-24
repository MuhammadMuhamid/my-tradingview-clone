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
import { checkSeries } from "../src/data/candleSeries";
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
  let ok = 0;
  const failed: string[] = [];
  for (const symbol of symbols) {
    for (const interval of INTERVALS) {
      const existing = await candleRepo.getCandles(symbol, interval, { from: now - 400 * DAY, to: now });
      const last = existing.length ? existing[existing.length - 1]!.openTime : now - 400 * DAY;
      const staleDays = (now - last) / DAY;

      /*
       * OPT-12: this checked ONLY the newest bar, so a feed with a hole in the
       * middle reported "current" forever — and every rolling indicator
       * computed over a silently compressed timeline (the same defect as
       * BE-14, on the research side).
       *
       * The interior is checked too now, and a gap is repaired even when the
       * tail is up to date.
       */
      const check = checkSeries(existing, interval);
      const missing = check.gaps.reduce((n, g) => n + g.missingBars, 0);
      if (staleDays < 0.05 && missing === 0) {
        console.log(`${symbol} ${interval}: current, contiguous`);
        ok++;
        continue;
      }
      if (missing > 0) {
        const worst = check.gaps.reduce((a, b) => (b.missingBars > a.missingBars ? b : a));
        console.log(
          `${symbol} ${interval}: ${missing} bar(s) MISSING from the interior ` +
          `(largest gap ${worst.missingBars} after ` +
          `${new Date(worst.afterOpenTime).toISOString()}) — repairing`
        );
        // Re-request the whole window: a targeted refetch of each gap would be
        // many small paged calls, and `upsertCandles` is idempotent.
        try {
          await ensureCandles(symbol, interval, now - 400 * DAY, now);
          const after = await candleRepo.getCandles(symbol, interval, { from: now - 400 * DAY, to: now });
          const still = checkSeries(after, interval).gaps.reduce((n, g) => n + g.missingBars, 0);
          if (still > 0) {
            console.log(`${symbol} ${interval}: ${still} bar(s) still missing after refetch`);
            failed.push(`${symbol} ${interval} (gaps)`);
          } else {
            console.log(`${symbol} ${interval}: interior repaired`);
            ok++;
          }
        } catch (err) {
          console.log(`${symbol} ${interval}: gap repair FAILED: ${(err as Error).message}`);
          failed.push(`${symbol} ${interval} (gaps)`);
        }
        if (staleDays < 0.05) continue;
      }
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
