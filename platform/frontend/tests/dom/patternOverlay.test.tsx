import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PatternOverlayControls } from "@/components/tv/PatternOverlayControls";
import type { PatternAnalysis } from "@/lib/candleOverlay";
import type { CandleOverlayState, PatternAnalysisState } from "@/lib/useCandleOverlay";
import realExactBarFixture from "../fixtures/p2_btcusdt_15m_exact_bar.json";

afterEach(cleanup);

const catalog = [
  { id: "doji", name: "Doji", direction: "none" as const, bars: 1,
    confirmation: "bar_close" as const, predictive_claim: false as const },
  { id: "hammer_bullish", name: "Hammer - Bullish", direction: "bull" as const, bars: 1,
    confirmation: "bar_close" as const, predictive_claim: false as const },
];

function overlay(over: Partial<CandleOverlayState> = {}): CandleOverlayState {
  return {
    enabled: true, setEnabled: () => {}, direction: "both", setDirection: () => {},
    selectedIds: null, setSelectedIds: () => {},
    catalog: { detector_id: "trading-scene-candlesticks", detector_version: "2.0.0",
      catalog_observed_at: "2026-09-08", confirmation: "bar_close", causal: true,
      predictive_claim: false, settings: {}, settings_hash: "hash", patterns: catalog },
    ...over,
  };
}

const result: PatternAnalysisState = { analysis: null, loading: false, error: null };

test("pattern controls expose scientific caveat, direction, search, and exports", () => {
  render(<PatternOverlayControls overlay={overlay()} result={result} symbol="BTCUSDT" timeframe="1h" />);
  fireEvent.click(screen.getByText(/Patterns/));
  assert.match(screen.getByText(/Fit describes geometry/).textContent ?? "", /not expected return/);
  assert.ok(screen.getByRole("combobox", { name: "Candlestick pattern direction" }));
  assert.ok(screen.getByRole("searchbox", { name: "Search candlestick patterns" }));
  assert.equal(screen.getByRole("button", { name: "Export JSON" }).hasAttribute("disabled"), true);
  assert.equal(screen.getByRole("button", { name: "Export CSV" }).hasAttribute("disabled"), true);
});

test("catalog search and exact selection call the shared overlay state", () => {
  const selections: Array<readonly string[] | null> = [];
  const directions: string[] = [];
  render(<PatternOverlayControls overlay={overlay({
    setSelectedIds: (ids) => selections.push(ids), setDirection: (value) => directions.push(value),
  })} result={result} symbol="BTCUSDT" timeframe="1h" />);
  fireEvent.click(screen.getByText(/Patterns/));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "hammer" } });
  assert.equal(screen.queryByText("Doji"), null);
  assert.ok(screen.getByText("Hammer - Bullish"));
  fireEvent.click(screen.getByRole("checkbox", { name: "All catalog patterns" }));
  assert.deepEqual(selections, [[]]);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "bull" } });
  assert.deepEqual(directions, ["bull"]);
});

test("rendered controls report the canonical analysis from reviewed real OHLC", () => {
  const analysis = realExactBarFixture.analysis as unknown as PatternAnalysis;
  render(<PatternOverlayControls overlay={overlay()} result={{
    analysis, loading: false, error: null,
  }} symbol="BTCUSDT" timeframe="15m" />);
  assert.match(screen.getByText(/Patterns/).textContent ?? "", /2/);
  fireEvent.click(screen.getByText(/Patterns/));
  assert.equal(screen.getByRole("button", { name: "Export JSON" }).hasAttribute("disabled"), false);
  assert.equal(screen.getByRole("button", { name: "Export CSV" }).hasAttribute("disabled"), false);
  assert.match(screen.getByText(/Confirmed bar-close formations/).textContent ?? "", /not expected return/);
});
