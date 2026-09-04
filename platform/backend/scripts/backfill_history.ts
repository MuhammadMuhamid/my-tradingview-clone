/**
 * The supported Binance Spot history acquisition entry point.
 *
 * Two modes, one script:
 *
 *   Bounded — an explicit window, which is what a research run needs:
 *     npx tsx scripts/backfill_history.ts \
 *       --targets=NEARUSDT:1m,NEARUSDT:5m,NEARUSDT:15m,NEARUSDT:1h \
 *       --start=2023-05-03 --end=2026-08-13
 *
 *   Rolling — the historical default, relative to now, for every active symbol:
 *     npx tsx scripts/backfill_history.ts [SYMBOL ...]
 *
 * Windows are the caller's to choose. This script hardcodes no research
 * methodology and reads no research configuration: whichever tree needs three
 * years of 1m bars passes those dates in.
 *
 * Both modes are idempotent — candles upsert on (symbol, interval, open_time),
 * so a rerun over an overlapping range overwrites rather than duplicates, and
 * an interrupted bounded run has already persisted every row it reported.
 */
import { listSymbols } from "../src/repositories/symbols";
import { coverage, countCandles } from "../src/repositories/candles";
import { backfillRange, ensureCandles, ensureSymbolMetadata } from "../src/data/binanceRest";
import { closePool } from "../src/db/pool";
import { INTERVALS, isInterval, type Interval } from "../src/types/market";

const DAY = 86_400_000;

/** Rolling-mode spans, unchanged: what a symbol keeps on hand without being asked. */
const ROLLING_PLAN: [Interval, number][] = [
  ["15m", 730 * DAY],
  ["5m", 730 * DAY],
  ["1h", 730 * DAY],
  ["4h", 730 * DAY],
  ["1d", 730 * DAY],
  ["1m", 300 * DAY],
];

interface Target { symbol: string; interval: Interval }

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function csv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Accept an ISO date/datetime or epoch milliseconds; reject anything else loudly. */
function parseInstant(raw: string, label: string): number {
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`--${label} is not a date or epoch-ms value: ${JSON.stringify(raw)}`);
  }
  return ms;
}

function parseInterval(raw: string): Interval {
  if (!isInterval(raw)) {
    throw new Error(`unknown interval ${JSON.stringify(raw)} — expected one of ${INTERVALS.join(", ")}`);
  }
  return raw;
}

async function resolveTargets(intervals: Interval[]): Promise<Target[]> {
  const explicit = csv(flag("targets"));
  if (explicit.length > 0) {
    return explicit.map((entry) => {
      const [symbol, interval] = entry.split(":");
      if (!symbol || !interval) {
        throw new Error(`--targets entries look like SYMBOL:INTERVAL, got ${JSON.stringify(entry)}`);
      }
      return { symbol: symbol.toUpperCase(), interval: parseInterval(interval) };
    });
  }
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const named = csv(flag("symbols"));
  const symbols = [...positional, ...named].map((s) => s.toUpperCase());
  // No symbol selection at all is the only case that touches the whole universe.
  const resolved = symbols.length > 0 ? symbols : (await listSymbols(true)).map((s) => s.symbol);
  return resolved.flatMap((symbol) => intervals.map((interval) => ({ symbol, interval })));
}

function iso(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toISOString().slice(0, 16);
}

async function runBounded(targets: Target[], start: number, end: number): Promise<void> {
  const pageLimit = flag("page-limit") ? Number(flag("page-limit")) : undefined;
  const flushSize = flag("flush") ? Number(flag("flush")) : undefined;
  console.log(`bounded backfill ${iso(start)} → ${iso(end)} for ${targets.length} target(s)`);
  for (const { symbol, interval } of targets) {
    const t0 = Date.now();
    process.stdout.write(`${symbol} ${interval}: `);
    try {
      const report = await backfillRange(symbol, interval, start, end, { pageLimit, flushSize });
      const stored = await coverage(symbol, interval, start, end);
      const issues = Object.entries(report.issues).map(([c, n]) => `${c}=${n}`).join(" ");
      console.log(
        `${report.rows.toLocaleString()} rows upserted over ${report.pages} page(s); ` +
        `stored ${stored.rows.toLocaleString()} in range ${iso(stored.firstOpenTime)} → ${iso(stored.lastOpenTime)}; ` +
        `integrity ${report.integrity}${issues ? ` (${issues})` : ""} ` +
        `(${((Date.now() - t0) / 1000).toFixed(0)}s)`
      );
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}

async function runRolling(targets: Target[]): Promise<void> {
  const span = new Map(ROLLING_PLAN);
  const now = Date.now();
  for (const { symbol, interval } of targets) {
    const window = span.get(interval);
    if (window === undefined) {
      console.log(`${symbol} ${interval}: skipped — no rolling span; pass --start/--end for this interval`);
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(`${symbol} ${interval}: `);
    try {
      await ensureCandles(symbol, interval, now - window, now, (m) => process.stdout.write(m + " "));
      const n = await countCandles(symbol, interval);
      console.log(`ok — ${n.toLocaleString()} bars stored (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}

async function main(): Promise<void> {
  const startRaw = flag("start");
  const endRaw = flag("end");
  const intervals = csv(flag("intervals")).map(parseInterval);
  const targets = await resolveTargets(
    intervals.length > 0 ? intervals : ROLLING_PLAN.map(([i]) => i)
  );
  if (targets.length === 0) throw new Error("no targets selected");

  // Registers the pair and refreshes price_tick / qty_step / min_notional and
  // base/quote/active from the public exchangeInfo endpoint, so a freshly
  // backfilled symbol is usable by production freezing without a second step.
  if (!process.argv.includes("--skip-symbol-metadata")) {
    const symbols = [...new Set(targets.map((t) => t.symbol))];
    try {
      for (const meta of await ensureSymbolMetadata(symbols)) {
        console.log(
          `${meta.symbol}: ${meta.baseAsset}/${meta.quoteAsset} ${meta.status} ` +
          `tick=${meta.priceTick} step=${meta.qtyStep} minNotional=${meta.minNotional}`
        );
      }
    } catch (err) {
      console.log(`symbol metadata FAILED: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }

  if (startRaw) {
    const start = parseInstant(startRaw, "start");
    const end = endRaw ? parseInstant(endRaw, "end") : Date.now();
    if (start >= end) throw new Error("--start must be before --end");
    await runBounded(targets, start, end);
  } else {
    if (endRaw) throw new Error("--end requires --start");
    await runRolling(targets);
  }

  await closePool();
  console.log("backfill complete");
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
