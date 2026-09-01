import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScreenerRow } from "../lib/scanner/types";
import {
  parseScannerAlertTarget,
  parseScannerChartTarget,
  platformSpotSymbol,
  scannerActionHrefs,
} from "../lib/spotScene";

function spotRow(overrides: Partial<ScreenerRow> = {}): ScreenerRow {
  return {
    symbol: "BTC/USDT",
    market: {
      exchange: "binance", market_type: "spot", contract_type: null,
      linear: false, spot: true, config_symbol: "BTC/USDT", native_symbol: "BTC/USDT",
    },
    state: "ok", price: 100, change_24h_pct: 1, indicators: {}, series: {}, errors: {},
    score: null, empirical: null, strategy: null, mtf: {}, note: null,
    ...overrides,
  };
}

test("Scanner action links target the exact existing Platform Spot symbol", () => {
  const row = spotRow();
  assert.equal(platformSpotSymbol(row), "BTCUSDT");
  assert.deepEqual(scannerActionHrefs(row), {
    chart: "/chart?source=scanner&symbol=BTCUSDT",
    alert: "/alerts?source=scanner&symbol=BTCUSDT&create=level",
    trade: "/chart?source=scanner&symbol=BTCUSDT&panel=manual",
  });
});

test("unresolved, non-Spot, and substituted identities cannot navigate", () => {
  const cases = [
    spotRow({ state: "unresolved" }),
    spotRow({ market: undefined }),
    spotRow({ market: { ...spotRow().market!, exchange: "binanceusdm" } }),
    spotRow({ market: { ...spotRow().market!, native_symbol: "BTC/USDT:USDT" } }),
  ];
  for (const row of cases) {
    assert.equal(platformSpotSymbol(row), null);
    assert.deepEqual(scannerActionHrefs(row), { chart: null, alert: null, trade: null });
  }
});

test("Chart Scanner links only prefill symbol and the established manual panel", () => {
  assert.deepEqual(parseScannerChartTarget("?source=scanner&symbol=btcusdt"), {
    symbol: "BTCUSDT", panel: null,
  });
  assert.deepEqual(parseScannerChartTarget("?source=scanner&symbol=BTCUSDT&panel=manual"), {
    symbol: "BTCUSDT", panel: "manual",
  });
  assert.equal(parseScannerChartTarget("?source=scanner&symbol=BTC/USDT"), null);
  assert.equal(parseScannerChartTarget("?source=scanner&symbol=BTCUSDT&panel=execute"), null);
});

test("Alert Scanner links open only the existing review dialog", () => {
  assert.deepEqual(
    parseScannerAlertTarget("?source=scanner&symbol=BTCUSDT&create=level"),
    { symbol: "BTCUSDT" },
  );
  assert.equal(parseScannerAlertTarget("?source=scanner&symbol=BTCUSDT"), null);
  assert.equal(parseScannerAlertTarget("?source=scanner&symbol=BTC/USDT&create=level"), null);
});
