/**
 * One-shot setup for the moving-average alert workspace.
 *
 * For every coin in COINS this:
 *   1. registers the Binance symbol (so candles can be fetched),
 *   2. puts it in a single server-side watchlist,
 *   3. saves a 1h chart layout named after the coin, carrying all ten MA
 *      lines (SMA + EMA of 200/100/50/21/15),
 *   4. arms the two approach alerts on 1h: price 0.2–0.5% ABOVE the 15 SMA,
 *      and 0.2–0.5% ABOVE the 21 SMA.
 *
 * Idempotent — every write is an upsert keyed by name or by
 * (symbol, timeframe, MA, mode), so re-running repairs rather than duplicates.
 *
 * Lives under src/ so it is compiled into dist/ and can be run inside the
 * production container, which ships no TypeScript toolchain:
 *   local  : cd backend && npx tsx src/scripts/seedMaWatchlist.ts [--dry]
 *   deployed: docker exec <backend> node dist/scripts/seedMaWatchlist.js
 */
import * as symbolRepo from "../repositories/symbols";
import * as watchlistRepo from "../repositories/watchlists";
import * as layoutRepo from "../repositories/layouts";
import * as maAlertRepo from "../repositories/maAlerts";
import { closePool } from "../db/pool";
import type { LayoutMaLine } from "../repositories/layouts";

const WATCHLIST_NAME = "Main Watchlist";
const TIMEFRAME = "1h" as const;
const MA_LENGTHS = [200, 100, 50, 21, 15];

const COINS = [
  "BTCUSDT", "ETHUSDT", "ALGOUSDT", "SOLUSDT", "BNBUSDT", "ZECUSDT", "SUIUSDT",
  "LINKUSDT", "NEARUSDT", "AVAXUSDT", "AAVEUSDT", "ENAUSDT", "TAOUSDT",
  "PEPEUSDT", "ONDOUSDT", "INJUSDT", "FETUSDT", "PUMPUSDT", "DEXEUSDT",
  "ALLOUSDT", "HBARUSDT", "ARBUSDT", "RENDERUSDT", "APTUSDT", "KAITOUSDT",
  "LDOUSDT", "JSTUSDT", "SYNUSDT", "JTOUSDT", "APEUSDT", "JUPUSDT", "TIAUSDT",
  "SEIUSDT", "PYTHUSDT", "EIGENUSDT", "RIFUSDT", "PORTALUSDT", "MANTAUSDT",
  "USUALUSDT",
];

/** The full set of lines every coin layout draws. */
const ALL_MA_LINES: LayoutMaLine[] = MA_LENGTHS.flatMap((length) => [
  { type: "sma" as const, length, visible: true },
  { type: "ema" as const, length, visible: true },
]);

/**
 * The approach alerts the user asked for by name. Only the 15 and 21 SMA get
 * one: these are the lines price pulls back to, and arming the slow averages
 * the same way would notify constantly.
 */
const APPROACH_ALERTS = [
  { maType: "sma" as const, maLength: 15 },
  { maType: "sma" as const, maLength: 21 },
];

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  if (dry) console.log("DRY RUN — nothing will be written\n");

  console.log(`${COINS.length} coins → watchlist, ${TIMEFRAME} layouts, approach alerts\n`);

  for (const symbol of COINS) {
    const base = symbol.replace(/USDT$/, "");
    if (!dry) {
      await symbolRepo.addSymbol(symbol, base, "USDT");
      await layoutRepo.upsertLayoutByName(symbol, {
        symbol,
        timeframe: TIMEFRAME,
        bars: 10000,
        strategyKey: "ma_rr_v9",
        params: {},
        properties: layoutRepo.defaultSyncedProperties(null),
        movingAverages: ALL_MA_LINES,
      });
      for (const line of APPROACH_ALERTS) {
        await maAlertRepo.upsertAlert({
          symbol,
          timeframe: TIMEFRAME,
          maType: line.maType,
          maLength: line.maLength,
          mode: "near_above",
          nearMinPct: 0.2,
          nearMaxPct: 0.5,
          cooldownMin: 60,
          enabled: true,
          note: `Approaching the ${line.maLength} SMA from above`,
        });
      }
    }
    console.log(
      `  ${symbol.padEnd(12)} layout ${TIMEFRAME} · ${ALL_MA_LINES.length} MA lines · ` +
      `${APPROACH_ALERTS.length} approach alerts`
    );
  }

  if (!dry) {
    await watchlistRepo.upsertByName(WATCHLIST_NAME, COINS, 0);
  }
  console.log(`\n  watchlist "${WATCHLIST_NAME}" → ${COINS.length} symbols`);

  if (!dry) {
    const alerts = await maAlertRepo.listAlerts({ enabledOnly: true });
    const layouts = await layoutRepo.listLayouts();
    console.log(
      `\ndone — ${layouts.length} layouts, ${alerts.length} enabled MA alerts in the database`
    );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
