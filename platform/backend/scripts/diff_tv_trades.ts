/**
 * TradingView parity diff — compares a local backtest's trade list against
 * TradingView's Strategy Tester "List of Trades".
 *
 * Usage:
 *   npx tsx scripts/diff_tv_trades.ts <backtestId> <tv_trades.(csv|json)> [--tolerance-pct 0.05]
 *
 * Accepts either:
 *   - the CSV exported from TV's Strategy Tester → List of Trades (Export data)
 *   - a JSON array from the TradingView MCP data_get_trades tool
 *
 * Matching: trades are aligned by entry time (bar open, ±1 bar tolerance) and
 * compared on entry price, exit time, exit price and PnL sign. Reports exact
 * matches, near-misses (within tolerance), and one-sided trades.
 */
import fs from "node:fs";
import { getBacktest, getBacktestTrades } from "../src/repositories/backtests";
import { closePool } from "../src/db/pool";
import { INTERVAL_MS } from "../src/types/market";
import type { TradeRecord } from "../src/types/backtest";

interface TvTrade {
  entryTime: number;
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  qty: number | null;
  profit: number | null;
  signal: string;
}

function parseCsv(text: string): TvTrade[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const header = parseLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (...names: string[]): number =>
    header.findIndex((h) => names.some((nm) => h.includes(nm)));
  const cTradeNo = col("trade #", "trade number", "trade");
  const cType = col("type");
  const cTime = col("date", "time");
  const cPrice = col("price");
  const cQty = col("contracts", "quantity", "qty");
  const cProfit = col("profit");
  const cSignal = col("signal");

  interface Row { tradeNo: string; type: string; time: number; price: number; qty: number | null; profit: number | null; signal: string }
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseLine(line);
    const t = Date.parse(cells[cTime] ?? "");
    if (!Number.isFinite(t)) continue;
    rows.push({
      tradeNo: cells[cTradeNo] ?? "",
      type: (cells[cType] ?? "").toLowerCase(),
      time: t,
      price: parseFloat((cells[cPrice] ?? "").replace(/[,\s]/g, "")),
      qty: cQty >= 0 ? parseFloat((cells[cQty] ?? "").replace(/[,\s]/g, "")) : null,
      profit: cProfit >= 0 ? parseFloat((cells[cProfit] ?? "").replace(/[,$\s]/g, "")) : null,
      signal: cells[cSignal] ?? "",
    });
  }
  // Pair entry/exit rows by trade number.
  const byNo = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byNo.get(r.tradeNo) ?? [];
    list.push(r);
    byNo.set(r.tradeNo, list);
  }
  const trades: TvTrade[] = [];
  for (const list of byNo.values()) {
    const entry = list.find((r) => r.type.includes("entry"));
    const exit = list.find((r) => r.type.includes("exit"));
    if (!entry) continue;
    trades.push({
      entryTime: entry.time,
      entryPrice: entry.price,
      exitTime: exit?.time ?? null,
      exitPrice: exit?.price ?? null,
      qty: entry.qty,
      profit: exit?.profit ?? null,
      signal: exit?.signal ?? entry.signal,
    });
  }
  return trades.sort((a, b) => a.entryTime - b.entryTime);
}

function parseJson(text: string): TvTrade[] {
  const data = JSON.parse(text) as Record<string, unknown>[] | { trades: Record<string, unknown>[] };
  const arr = Array.isArray(data) ? data : data.trades;
  return (arr ?? []).map((t) => ({
    entryTime: Date.parse(String(t.entry_time ?? t.entryTime ?? "")),
    entryPrice: Number(t.entry_price ?? t.entryPrice ?? NaN),
    exitTime: t.exit_time || t.exitTime ? Date.parse(String(t.exit_time ?? t.exitTime)) : null,
    exitPrice: t.exit_price || t.exitPrice ? Number(t.exit_price ?? t.exitPrice) : null,
    qty: t.contracts !== undefined ? Number(t.contracts) : null,
    profit: t.profit !== undefined ? Number(t.profit) : null,
    signal: String(t.signal ?? ""),
  })).filter((t) => Number.isFinite(t.entryTime))
    .sort((a, b) => a.entryTime - b.entryTime);
}

async function main(): Promise<void> {
  const [backtestId, tvFile] = process.argv.slice(2);
  const tolArg = process.argv.indexOf("--tolerance-pct");
  const tolPct = tolArg >= 0 ? parseFloat(process.argv[tolArg + 1] ?? "0.05") : 0.05;
  if (!backtestId || !tvFile) {
    console.error("usage: npx tsx scripts/diff_tv_trades.ts <backtestId> <tv_trades.csv|json>");
    process.exit(1);
  }
  const bt = await getBacktest(backtestId);
  if (!bt) throw new Error(`backtest ${backtestId} not found`);
  const local: TradeRecord[] = await getBacktestTrades(backtestId);
  const text = fs.readFileSync(tvFile, "utf8");
  const tv = tvFile.endsWith(".json") ? parseJson(text) : parseCsv(text);
  const barMs = INTERVAL_MS[bt.timeframe];

  // Only compare within the overlapping window (TV runs over all loaded bars).
  const lo = Math.max(new Date(bt.startTime).getTime(), tv[0]?.entryTime ?? 0);
  const hi = Math.min(new Date(bt.endTime).getTime(), tv[tv.length - 1]?.entryTime ?? Infinity);
  const localW = local.filter((t) => t.entryTime >= lo && t.entryTime <= hi);
  const tvW = tv.filter((t) => t.entryTime >= lo && t.entryTime <= hi);

  const used = new Set<number>();
  let exact = 0, near = 0;
  const mismatches: string[] = [];
  for (const lt of localW) {
    let match = -1;
    for (let k = 0; k < tvW.length; k++) {
      if (used.has(k)) continue;
      if (Math.abs(tvW[k]!.entryTime - lt.entryTime) <= barMs) { match = k; break; }
    }
    if (match < 0) {
      mismatches.push(`LOCAL-ONLY entry ${new Date(lt.entryTime).toISOString()} @ ${lt.entryPrice}`);
      continue;
    }
    used.add(match);
    const tvT = tvW[match]!;
    const priceDiffPct = Math.abs(tvT.entryPrice - lt.entryPrice) / tvT.entryPrice * 100;
    const exitDiffPct = tvT.exitPrice && lt.exitPrice
      ? Math.abs(tvT.exitPrice - lt.exitPrice) / tvT.exitPrice * 100 : 0;
    const exitTimeOk = !tvT.exitTime || !lt.exitTime || Math.abs(tvT.exitTime - lt.exitTime) <= barMs;
    if (priceDiffPct < 1e-6 && exitDiffPct < 1e-6 && exitTimeOk) exact++;
    else if (priceDiffPct <= tolPct && exitDiffPct <= tolPct && exitTimeOk) near++;
    else mismatches.push(
      `DIVERGED entry ${new Date(lt.entryTime).toISOString()}: ` +
      `entry ${lt.entryPrice} vs TV ${tvT.entryPrice} (${priceDiffPct.toFixed(4)}%), ` +
      `exit ${lt.exitPrice} vs TV ${tvT.exitPrice} (${exitDiffPct.toFixed(4)}%)` +
      (exitTimeOk ? "" : " [exit time differs]")
    );
  }
  for (let k = 0; k < tvW.length; k++) {
    if (!used.has(k)) {
      mismatches.push(`TV-ONLY entry ${new Date(tvW[k]!.entryTime).toISOString()} @ ${tvW[k]!.entryPrice} (${tvW[k]!.signal})`);
    }
  }

  console.log(`window: ${new Date(lo).toISOString()} → ${new Date(hi).toISOString()}`);
  console.log(`local trades: ${localW.length} | TV trades: ${tvW.length}`);
  console.log(`exact: ${exact} | within ${tolPct}%: ${near} | mismatched: ${mismatches.length}`);
  const matchedPct = localW.length > 0 ? ((exact + near) / Math.max(localW.length, tvW.length)) * 100 : 0;
  console.log(`parity: ${matchedPct.toFixed(1)}%`);
  if (mismatches.length > 0) {
    console.log("\nmismatches:");
    for (const m of mismatches.slice(0, 40)) console.log("  " + m);
    if (mismatches.length > 40) console.log(`  … and ${mismatches.length - 40} more`);
  }
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
