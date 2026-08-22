/** Dump entry gates at given bar times for a spec. Usage:
 *    npx tsx scripts/probe_gates.ts <spec.json> <isoTime> [isoTime ...]
 */
import fs from "node:fs";
import { closePool } from "../src/db/pool";
import * as candleRepo from "../src/repositories/candles";
import { FeedStore, toBars } from "../src/engine/mtf";
import { maRrV9Module } from "../src/engine/strategies/ma_rr_v9";
import { computeSignals, DEBUG_TIMES } from "../src/engine/strategies/ma_rr_v9/signals";
import type { Interval } from "../src/types/market";

async function main(): Promise<void> {
  const [file, ...times] = process.argv.slice(2);
  const spec = JSON.parse(fs.readFileSync(file!, "utf8"));
  for (const t of times) DEBUG_TIMES.add(Date.parse(t));
  const p = maRrV9Module.resolveParams(spec.params);
  const startMs = Date.parse(spec.startTime);
  const endMs = Date.parse(spec.endTime);
  const feeds = new FeedStore();
  for (const need of maRrV9Module.requiredFeeds(p, spec.timeframe as Interval)) {
    const symbol = need.symbol ?? spec.symbol;
    const from = startMs - maRrV9Module.warmupMs(need);
    const candles = await candleRepo.getCandles(symbol, need.interval, { from, to: endMs });
    feeds.set(toBars(candles));
  }
  computeSignals(feeds, spec.symbol, spec.timeframe, p);
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
