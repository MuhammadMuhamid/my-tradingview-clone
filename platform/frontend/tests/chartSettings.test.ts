import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHART_SETTINGS, isDefaultChartSettings, normalizeChartSettings,
} from "../lib/chartSettings";

test("chart settings default safely and preserve explicit display choices", () => {
  assert.deepEqual(normalizeChartSettings(null), DEFAULT_CHART_SETTINGS);
  const custom = normalizeChartSettings({ gridVertical: false, showTrading: false });
  assert.equal(custom.gridVertical, false);
  assert.equal(custom.showTrading, false);
  assert.equal(custom.showCrosshair, true);
  assert.equal(custom.showAlerts, true);
  assert.equal(isDefaultChartSettings(custom), false);
});

test("malformed chart setting values never disable a feature by accident", () => {
  const value = normalizeChartSettings({ gridVertical: "false", showEvents: 0 });
  assert.equal(value.gridVertical, true);
  assert.equal(value.showEvents, true);
});

test("a workspace saved with the single grid switch keeps the grid it had", () => {
  // `showGrid` was one switch for both directions. A user who had turned the
  // grid OFF must not find it back on after the field split in two.
  const off = normalizeChartSettings({ showGrid: false });
  assert.equal(off.gridVertical, false);
  assert.equal(off.gridHorizontal, false);
  const on = normalizeChartSettings({ showGrid: true });
  assert.equal(on.gridVertical, true);
  assert.equal(on.gridHorizontal, true);
  // An explicit new-shape value still wins over the legacy one.
  const mixed = normalizeChartSettings({ showGrid: false, gridHorizontal: true });
  assert.equal(mixed.gridVertical, false);
  assert.equal(mixed.gridHorizontal, true);
});

test("numeric settings are clamped rather than trusted", () => {
  const wild = normalizeChartSettings({
    scaleFontSize: 999, marginTopPct: -5, marginBottomPct: 120, rightOffsetBars: 10_000,
  });
  assert.equal(wild.scaleFontSize, 20);
  assert.equal(wild.marginTopPct, 0);
  assert.equal(wild.marginBottomPct, 50);
  assert.equal(wild.rightOffsetBars, 200);
});

test("a colour that is not a colour cannot reach the canvas", () => {
  const bad = normalizeChartSettings({ upColor: "javascript:alert(1)", downColor: "#GGGGGG" });
  assert.equal(bad.upColor, DEFAULT_CHART_SETTINGS.upColor);
  assert.equal(bad.downColor, DEFAULT_CHART_SETTINGS.downColor);
  const good = normalizeChartSettings({ upColor: "#00ff88" });
  assert.equal(good.upColor, "#00ff88");
});

test("precision only accepts the digit counts the price format can honour", () => {
  assert.equal(normalizeChartSettings({ precision: 4 }).precision, 4);
  assert.equal(normalizeChartSettings({ precision: 42 }).precision, "auto");
  assert.equal(normalizeChartSettings({ precision: "lots" }).precision, "auto");
});

test("scale placement falls back rather than hiding both axes by accident", () => {
  assert.equal(normalizeChartSettings({ scalePlacement: "left" }).scalePlacement, "left");
  assert.equal(normalizeChartSettings({ scalePlacement: "elsewhere" }).scalePlacement, "right");
});
