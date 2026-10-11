/**
 * HVBO-3: a result's trades as a CSV, and the engine-correction names the
 * result page shows (C-01) kept in step with the engine's own list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRADE_CSV_COLUMNS, tradeFees, tradesCsv, tradesCsvName } from "../lib/tradeExport";
import { CORRECTION_LABELS } from "../lib/backtestFigures";
import type { Trade } from "../lib/types";

const T = Date.parse("2026-09-01T10:00:00Z");

function trade(over: Partial<Trade> = {}): Trade {
  return {
    tradeNo: 1, direction: "long", entryTime: T, entryPrice: 100, exitTime: T + 3_600_000, exitPrice: 102,
    qty: 9.3, pnl: 16.5, pnlPct: 2, exitReason: "TP", runUpPct: null, drawdownPct: null, cumProfit: null,
    ...over,
  };
}

test("the CSV has a header and one row per trade, with the columns a reader checks", () => {
  const csv = tradesCsv([trade(), trade({ tradeNo: 2, exitPrice: 99, pnl: -11.2, exitReason: "SL" })], 0.1);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], TRADE_CSV_COLUMNS.join(","));
  assert.deepEqual(TRADE_CSV_COLUMNS, ["trade", "side", "entry_time_utc", "exit_time_utc", "qty", "entry_price",
    "exit_price", "pnl", "pnl_pct_net", "fees", "exit_reason"]);
  const first = lines[1]!.split(",");
  assert.equal(first[1], "long");
  assert.equal(first[2], "2026-09-01T10:00:00.000Z");
  assert.equal(first[3], "2026-09-01T11:00:00.000Z");
  assert.equal(first[7], "16.5");
  // Net of costs: 16.5 over a 930 entry notional, like the trade list's P/L %.
  assert.equal(Number(first[8]), Number(((16.5 / 930) * 100).toFixed(4)));
  // 0.1 % of the entry notional plus 0.1 % of the exit notional.
  assert.equal(Number(first[9]), Number(((100 + 102) * 9.3 * 0.001).toFixed(8)));
  assert.equal(first[10], "TP");
  const second = lines[2]!.split(",");
  assert.equal(second[7], "-11.2", "a loss stays a negative NUMBER, not an escaped text cell");
});

test("an open trade is a row with its exit fields empty, reason 'open'", () => {
  const csv = tradesCsv([trade({ exitTime: null, exitPrice: null, pnl: null, pnlPct: null, exitReason: null })], 0.1);
  const row = csv.trimEnd().split("\r\n")[1]!.split(",");
  assert.equal(row[3], "");
  assert.equal(row[6], "");
  assert.equal(row[7], "");
  assert.equal(row[9], "");
  assert.equal(row[10], "open");
  assert.equal(tradeFees({ entryPrice: 1, exitPrice: null, qty: 1 }, 0.1), null);
});

test("text that a spreadsheet would evaluate or split is quoted and kept as text", () => {
  const csv = tradesCsv([trade({ exitReason: "=HYPERLINK(\"x\")" }), trade({ exitReason: "TP, partial" })], 0.1);
  const lines = csv.trimEnd().split("\r\n");
  assert.ok(lines[1]!.endsWith(`"'=HYPERLINK(""x"")"`), lines[1]);
  assert.ok(lines[2]!.endsWith(`"TP, partial"`), lines[2]);
});

test("the file is named for the run", () => {
  assert.equal(tradesCsvName({ symbol: "SOLUSDT", timeframe: "1h", id: "8f6d2c1e-3b4a-4f5e-9a7b-1c2d3e4f5a6b" }),
    "SOLUSDT-1h-trades-8f6d2c1e.csv");
});

test("C-01 every engine correction has a reader's name on the result page", () => {
  const source = readFileSync(join(import.meta.dirname, "../../backend/src/engine/corrections.ts"), "utf8");
  const block = /export const CORRECTION_KEYS = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? "";
  const keys = [...block.matchAll(/^\s*"([A-Za-z0-9]+)",/gm)].map((m) => m[1]!);
  assert.ok(keys.length >= 10, `read the engine's list (${keys.length})`);
  const unnamed = keys.filter((k) => !(k in CORRECTION_LABELS));
  assert.deepEqual(unnamed, [], "a correction added to the engine needs a name in lib/backtestFigures.ts");
});
