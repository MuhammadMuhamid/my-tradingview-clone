import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScreenerRow } from "../lib/scanner/types";
import {
  parseScannerAlertTarget,
  parseScannerChartTarget,
  tradePanelSellHref,
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

test("OD-7: a Trade-panel link may name the position to SELL; malformed ids and other sides are ignored", () => {
  assert.deepEqual(parseScannerChartTarget(
    "?source=scanner&symbol=SOLUSDT&panel=manual&side=sell&account=acct-1&position=pos_9"), {
    symbol: "SOLUSDT", panel: "manual", sell: { accountId: "acct-1", positionId: "pos_9" },
  });
  // The Bot's trade view does not send account ids yet: the position alone is enough.
  assert.deepEqual(parseScannerChartTarget("?source=scanner&symbol=SOLUSDT&panel=manual&side=sell&position=pos-9"), {
    symbol: "SOLUSDT", panel: "manual", sell: { accountId: null, positionId: "pos-9" },
  });
  for (const query of [
    "side=buy&account=acct-1&position=pos-9",
    "side=sell&account=acct-1&position=..%2Fx",
    "side=sell&account=a%20b&position=pos-9",
    "side=sell&account=acct-1&position=" + "p".repeat(65),
    "side=sell&account=acct-1",
  ]) {
    assert.deepEqual(parseScannerChartTarget(`?source=scanner&symbol=SOLUSDT&panel=manual&${query}`),
      { symbol: "SOLUSDT", panel: "manual" }, query);
  }
  // Without the manual panel there is no sell prefill.
  assert.deepEqual(parseScannerChartTarget("?source=scanner&symbol=SOLUSDT&side=sell&position=pos-9"),
    { symbol: "SOLUSDT", panel: null });
});

test("Alert Scanner links open only the existing review dialog", () => {
  assert.deepEqual(
    parseScannerAlertTarget("?source=scanner&symbol=BTCUSDT&create=level"),
    { symbol: "BTCUSDT" },
  );
  assert.equal(parseScannerAlertTarget("?source=scanner&symbol=BTCUSDT"), null);
  assert.equal(parseScannerAlertTarget("?source=scanner&symbol=BTC/USDT&create=level"), null);
});

test("OD-7: the link for one position round-trips through the parser, and only prefills", () => {
  const href = tradePanelSellHref("SOL/USDT", { accountId: "acct-1", positionId: "pos-9" })!;
  assert.equal(href, "/chart?source=scanner&symbol=SOLUSDT&panel=manual&side=sell&account=acct-1&position=pos-9");
  assert.deepEqual(parseScannerChartTarget(href.slice(href.indexOf("?"))),
    { symbol: "SOLUSDT", panel: "manual", sell: { accountId: "acct-1", positionId: "pos-9" } });
  assert.equal(tradePanelSellHref("SOLUSDT", { accountId: null, positionId: "pos-9" }),
    "/chart?source=scanner&symbol=SOLUSDT&panel=manual&side=sell&position=pos-9");
  assert.equal(tradePanelSellHref("SOLUSDT", { accountId: "acct-1", positionId: "../x" }),
    "/chart?source=scanner&symbol=SOLUSDT&panel=manual", "a malformed id names nothing");
  assert.equal(tradePanelSellHref("SOLUSDT", { accountId: "a b", positionId: "pos-9" }),
    "/chart?source=scanner&symbol=SOLUSDT&panel=manual&side=sell&position=pos-9");
  assert.equal(tradePanelSellHref("/", { positionId: "pos-9" }), null);
});
