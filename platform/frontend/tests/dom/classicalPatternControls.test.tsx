import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClassicalPatternControls } from "@/components/tv/ClassicalPatternControls";
import type { ClassicalCatalog } from "@/lib/classicalPatterns";
import type { ClassicalOverlayState } from "@/lib/useClassicalPatterns";

afterEach(cleanup);

const patterns = [
  { id: "double_top", name: "Double Top", family: "double", direction: "bear" as const,
    confirmation: "close" as const, pivot_basis: "confirmed_5_5" as const,
    target_basis: "measured_move" as const, predictive_claim: false as const },
  { id: "triangle", name: "Triangle", family: "triangle", direction: "both" as const,
    confirmation: "close" as const, pivot_basis: "confirmed_5_5" as const,
    target_basis: "measured_move" as const, predictive_claim: false as const },
];
const catalog: ClassicalCatalog = {
  detector_id: "trading-scene-classical-patterns", detector_version: "1.0.0",
  catalog_observed_at: "2026-09-08", search_horizon_bars: 600, confirmation: "close",
  pivot_confirmation: { left_bars: 5, right_bars: 5 }, causal: true, predictive_claim: false,
  settings: {}, settings_hash: "abc", patterns,
};

function overlay(overrides: Partial<ClassicalOverlayState> = {}): ClassicalOverlayState {
  return {
    enabled: true, setEnabled: () => {}, catalog, includeDeveloping: true,
    setIncludeDeveloping: () => {}, status: "all", setStatus: () => {}, selectedIds: null,
    setSelectedIds: () => {}, showTargets: true, setShowTargets: () => {}, ...overrides,
  };
}

test("classical controls expose status, in-progress, targets, catalog and exports", () => {
  render(<ClassicalPatternControls overlay={overlay()}
    result={{ analysis: null, loading: false, error: null }} symbol="BTCUSDT" timeframe="1h" />);
  fireEvent.click(screen.getByText(/Chart patterns/));
  assert.ok(screen.getByRole("combobox", { name: "Classical pattern status" }));
  assert.ok(screen.getByRole("checkbox", { name: "Include developing patterns" }));
  assert.ok(screen.getByRole("checkbox", { name: "Measured targets" }));
  assert.ok(screen.getByRole("searchbox", { name: "Search classical chart patterns" }));
  assert.equal(screen.getAllByText(/Double Top/).length, 1);
  assert.equal(screen.getByRole("button", { name: "Export JSON" }).hasAttribute("disabled"), true);
});

test("search and catalog selection call the canonical id setters", () => {
  let selected: readonly string[] | null = null;
  render(<ClassicalPatternControls overlay={overlay({ setSelectedIds: (next) => { selected = next; } })}
    result={{ analysis: null, loading: false, error: null }} symbol="BTCUSDT" timeframe="1h" />);
  fireEvent.click(screen.getByText(/Chart patterns/));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "triangle" } });
  assert.equal(screen.queryByText("Double Top"), null);
  fireEvent.click(screen.getByRole("checkbox", { name: /All 16/ }));
  assert.deepEqual(selected, []);
});
