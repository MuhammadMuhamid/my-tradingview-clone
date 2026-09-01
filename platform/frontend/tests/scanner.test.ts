import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyFilters, EMPTY_FILTERS } from "../components/scanner/FilterPanel";
import { COLUMNS } from "../lib/scanner/columns";
import type { ScreenerRow } from "../lib/scanner/types";

const ROOT = path.join(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

function row(symbol: string, state: ScreenerRow["state"], bull: number | null): ScreenerRow {
  return {
    symbol, state, price: state === "unresolved" ? null : 100, change_24h_pct: 1,
    indicators: {}, series: {}, errors: state === "partial" ? { rsi: "missing" } : {},
    score: null, empirical: null, strategy: bull === null ? null : {
      bull: { side: "bull", timeframes: {}, passed: 1, total: 2, pct: bull, aligned: false },
      bear: { side: "bear", timeframes: {}, passed: 1, total: 2, pct: 100 - bull, aligned: false },
      bullish_pct: bull, bearish_pct: 100 - bull, bias: "bull", setup: null,
      note: "condition share, not probability", timeframes_used: {}, series: {},
    }, mtf: {}, note: state === "unresolved" ? "not resolved on Binance USD-M" : null,
  };
}

test("native Scanner route and navigation preserve visible USD-M Futures identity", () => {
  const page = read("app/scanner/page.tsx");
  const nav = read("components/Nav.tsx");
  assert.match(page, /Futures Scanner/);
  assert.match(page, /snapshot\?\.market\.market_type === "usd_m_perpetual"/);
  assert.match(page, /Binance USD-M Perpetual/);
  assert.match(page, /not Spot/);
  assert.ok(nav.indexOf('href: "/chart"') < nav.indexOf('href: "/scanner"'));
  assert.ok(nav.indexOf('href: "/scanner"') < nav.indexOf('href: "/alerts"'));
});

test("browser Scanner client is same-origin and exposes no service URL", () => {
  const api = read("lib/scanner/api.ts");
  assert.match(api, /"\/api\/scanner"/);
  assert.doesNotMatch(api, /8000|NEXT_PUBLIC|SCANNER_SERVICE_URL|https?:\/\//);
  assert.doesNotMatch(read("app/scanner/page.tsx"), /8000|NEXT_PUBLIC|https?:\/\//);
});

test("normal, partial and unresolved rows survive core Scanner filtering and sorting", () => {
  const rows = [row("BTC/USDT", "ok", 75), row("ETH/USDT", "partial", 40),
    row("UNKNOWN/USDT", "unresolved", null)];
  assert.deepEqual(applyFilters(rows, COLUMNS, EMPTY_FILTERS, (spec, item) => spec.accessor(item)), rows);
  const filtered = applyFilters(rows, COLUMNS, {
    numeric: { mtf_bull_pct: { min: "50", max: "" } }, categorical: {},
  }, (spec, item) => spec.accessor(item));
  assert.deepEqual(filtered.map((item) => item.symbol), ["BTC/USDT"]);
  const bull = COLUMNS.find((column) => column.id === "mtf_bull_pct")!;
  assert.deepEqual(rows.slice(0, 2).sort((a, b) => Number(bull.accessor(b)) - Number(bull.accessor(a)))
    .map((item) => item.symbol), ["BTC/USDT", "ETH/USDT"]);
});

test("expanded details retain both checklists, score disclaimer, provenance, and truthful calibration", () => {
  const detail = read("components/scanner/RowDetail.tsx");
  const strategy = read("components/scanner/StrategyPanel.tsx");
  const calibration = read("components/scanner/CalibrationPanel.tsx");
  assert.match(detail, /ScoreBreakdown/);
  assert.match(detail, /Data provenance/);
  assert.match(strategy, /bull\.rules/);
  assert.match(strategy, /ruleOf\(bear\.rules/);
  assert.match(strategy, /\(optional\)/);
  assert.match(calibration, /Current calibration/);
  assert.match(calibration, /Stale calibration/);
  assert.match(calibration, /withheld unless current and usable/);
  assert.match(calibration, /fingerprint/i);
  assert.match(calibration, /data\.current && data\.available \? d\.display : `withheld/);
});

test("Futures row actions cannot invoke Spot behavior", () => {
  const detail = read("components/scanner/RowDetail.tsx");
  for (const label of ["Open Chart", "Create Alert", "Trade", "Backtest"]) {
    assert.match(detail, new RegExp(`\\["${label}",`));
  }
  assert.match(detail, /<button disabled aria-label=/);
  assert.match(detail, /no Spot chart will be opened/);
  assert.match(detail, /no Spot alert will be created/);
  assert.match(detail, /Manual Trading V1 is Spot-only/);
  assert.match(detail, /calibration is not a backtest/);
  assert.doesNotMatch(detail, /href=|router\.push|window\.location/);
});

test("Scanner writes are explicit and polling pauses while the page is hidden", () => {
  const page = read("app/scanner/page.tsx");
  for (const operation of ["refresh", "patchConfig", "addSymbol", "removeSymbol",
    "loadPreset", "savePreset", "deletePreset"]) {
    assert.match(page, new RegExp(`api\\.${operation}`));
  }
  assert.match(page, /document\.visibilityState === "visible"/);
  assert.match(page, /15_000/);
});
