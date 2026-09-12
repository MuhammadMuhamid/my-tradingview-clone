import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHART_SETTINGS, isDefaultChartSettings, normalizeChartSettings,
} from "../lib/chartSettings";

test("chart settings default safely and preserve explicit display choices", () => {
  assert.deepEqual(normalizeChartSettings(null), DEFAULT_CHART_SETTINGS);
  const custom = normalizeChartSettings({ showGrid: false, showTrading: false });
  assert.equal(custom.showGrid, false);
  assert.equal(custom.showTrading, false);
  assert.equal(custom.showCrosshair, true);
  assert.equal(custom.showAlerts, true);
  assert.equal(isDefaultChartSettings(custom), false);
});

test("malformed chart setting values never disable a feature by accident", () => {
  const value = normalizeChartSettings({ showGrid: "false", showEvents: 0 });
  assert.equal(value.showGrid, true);
  assert.equal(value.showEvents, true);
});
