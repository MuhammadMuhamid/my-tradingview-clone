import {after, beforeEach, test} from "node:test";
import assert from "node:assert/strict";
import {fireEvent, screen, within} from "@testing-library/react";
import {closeBrowser, render, resetBrowser, server, settle} from "./harness/env";
import {BacktestForm} from "@/components/BacktestForm";
import {INTERVAL_VALUES, type Strategy, type SymbolInfo} from "@/lib/types";

beforeEach(resetBrowser);
after(closeBrowser);
const symbols = [{symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", priceTick: 0.01, qtyStep: 0.01, minNotional: 5, isActive: true, venue: "BINANCE", assetClass: "crypto_spot"}] as SymbolInfo[];
const strategies: Strategy[] = [{id: 1, key: "ma_rr_v9", name: "MA + R:R", description: null, pineSource: null}];

test("fixed cash and equity sizing send canonical request inputs and all native intervals are selectable", async () => {
  let payload: Record<string, unknown> | null = null;
  server.routes.set("POST /api/backtests", (body) => { payload = body as Record<string, unknown>; return {id: "run-1"}; });
  render(<BacktestForm symbols={symbols} strategies={strategies} onQueued={() => {}} />);
  const timeframe = screen.getByLabelText("Timeframe");
  assert.deepEqual(within(timeframe).getAllByRole("option").map(o => (o as HTMLOptionElement).value), [...INTERVAL_VALUES]);
  fireEvent.change(screen.getByLabelText("Initial capital"), {target: {value: "500"}});
  fireEvent.change(screen.getByLabelText(/^Cash per entry/), {target: {value: "200"}});
  fireEvent.change(timeframe, {target: {value: "1d"}});
  fireEvent.click(screen.getByRole("button", {name: /Run backtest|Queue backtest/}));
  await settle();
  assert.equal(((payload as Record<string, unknown> | null)?.params as Record<string, unknown>).qty_cash, 200);
  assert.equal((payload as Record<string, unknown> | null)?.timeframe, "1d");
  fireEvent.change(screen.getByLabelText(/^Position size/), {target: {value: "equity"}});
  fireEvent.change(screen.getByLabelText(/^Equity per entry/), {target: {value: ""}});
  assert.equal((screen.getByLabelText(/^Position size/) as HTMLSelectElement).value, "equity");
  fireEvent.click(screen.getByRole("button", {name: /Run backtest|Queue backtest/}));
  assert.ok(screen.getByText(/Enter an equity percentage greater than 0/));
  fireEvent.change(screen.getByLabelText(/^Equity per entry/), {target: {value: "25"}});
  fireEvent.click(screen.getByRole("button", {name: /Run backtest|Queue backtest/}));
  await settle();
  assert.equal(((payload as Record<string, unknown> | null)?.params as Record<string, unknown>).qty_pct_equity, 25);
});

test("the Symbol field names each market by its ticker, as the chart and Stress do", () => {
  // A canonical identity (`instrument:v1:…`) used to render through
  // `displaySymbol` as `BINANCE:SOL/USDT · SPOT`, truncated in a 207px field.
  const canonical = [
    {...symbols[0]!, symbol: "SOLUSDT", baseAsset: "SOL", canonicalId: "instrument:v1:BINANCE:spot:SOL:USDT:USDT:spot"},
    {...symbols[0]!, symbol: "BTCUSDT", canonicalId: null},
  ] as SymbolInfo[];
  render(<BacktestForm symbols={canonical} strategies={strategies} onQueued={() => {}} />);
  const field = screen.getByLabelText("Symbol");
  const options = within(field).getAllByRole("option") as HTMLOptionElement[];
  assert.deepEqual(options.map((o) => o.textContent), ["SOLUSDT", "BTCUSDT"]);
  assert.deepEqual(options.map((o) => o.value), ["SOLUSDT", "BTCUSDT"], "the value sent is unchanged");
  for (const o of options) assert.doesNotMatch(o.textContent ?? "", /BINANCE:|·|\//);
});
