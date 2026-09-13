import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CHART_SETTINGS, isDefaultChartSettings, normalizeChartSettings,
  type ChartSettings,
} from "../lib/chartSettings";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

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

// ── TVP8: the lines the "Scales and lines" tab is named for ────────────────

test("THE LINES TAB HAS LINE CONTROLS, AND EVERY ONE REACHES THE ENGINE", () => {
  /*
   * The tab literally named "Scales and lines" had seven controls and every
   * one of them was a scale. The reference's equivalent is mostly about
   * LINES — the dashed last-price line running back across the plot, the price
   * tag on the scale, and the colour, width and style of the grid and the
   * crosshair.
   *
   * The rule this file enforces is `lib/chartSettings.ts`'s own: a control
   * belongs in the model when the engine can honour it and the pane can
   * persist it. So each of these is traced to the `applyOptions` that reads
   * it, with comments stripped — a rule its own documentation can satisfy is
   * not a rule.
   */
  const chart = read("components/CandleChart.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const dialog = read("components/tv/ChartSettingsModal.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const wired: [keyof ChartSettings, RegExp, RegExp][] = [
    ["lastValueLine", /priceLineVisible: settings\.lastValueLine/, /set\("lastValueLine"/],
    ["lastValueLineColor", /priceLineColor: settings\.lastValueLineColor/, /set\("lastValueLineColor"/],
    ["lastValueLineWidth", /priceLineWidth: settings\.lastValueLineWidth/, /set\("lastValueLineWidth"/],
    ["lastValueLineStyle", /priceLineStyle: lineStyleOf\(settings\.lastValueLineStyle\)/, /set\("lastValueLineStyle"/],
    ["lastValueLabel", /lastValueVisible: settings\.lastValueLabel/, /set\("lastValueLabel"/],
    ["dateFormat", /dateFormat: settings\.dateFormat/, /set\("dateFormat"/],
    ["gridColor", /settings\.gridColor \? \{ color: settings\.gridColor \}/, /set\("gridColor"/],
    ["gridStyle", /style: lineStyleOf\(settings\.gridStyle\)/, /set\("gridStyle"/],
    ["crosshairColor", /settings\.crosshairColor \? \{ color: settings\.crosshairColor \}/, /set\("crosshairColor"/],
    ["crosshairWidth", /width: settings\.crosshairWidth as/, /set\("crosshairWidth"/],
    ["crosshairStyle", /style: lineStyleOf\(settings\.crosshairStyle\)/, /set\("crosshairStyle"/],
    ["watermark", /visible: settings\.watermark/, /set\("watermark"/],
    ["backgroundGradient", /settings\.backgroundGradient/, /set\("backgroundGradient"/],
  ];
  for (const [key, engine, control] of wired) {
    assert.match(chart, engine, `${key} never reaches the chart — it is a dead switch`);
    assert.match(dialog, control, `${key} has no control in the dialog`);
    assert.ok(key in DEFAULT_CHART_SETTINGS, `${key} has no default`);
  }
});

test("an empty colour means the theme's own, and survives a round trip", () => {
  /*
   * `""` is a legal value, not a malformed one: it is what every chart had
   * before these controls existed and what "Theme colour" returns them to. A
   * validator that replaced it with a literal would quietly pin the grid to
   * one theme's colour the first time a workspace was reloaded.
   */
  assert.equal(normalizeChartSettings({ gridColor: "" }).gridColor, "");
  assert.equal(normalizeChartSettings({ crosshairColor: "" }).crosshairColor, "");
  assert.equal(normalizeChartSettings({ gridColor: "#123456" }).gridColor, "#123456");
  assert.equal(normalizeChartSettings({ gridColor: "not a colour" }).gridColor, "");
  assert.equal(DEFAULT_CHART_SETTINGS.gridColor, "");
});

test("a line style and a date format cannot be anything the renderer cannot draw", () => {
  assert.equal(normalizeChartSettings({ gridStyle: "dotted" }).gridStyle, "dotted");
  assert.equal(normalizeChartSettings({ gridStyle: "squiggly" }).gridStyle, "solid");
  assert.equal(normalizeChartSettings({ crosshairStyle: "solid" }).crosshairStyle, "solid");
  assert.equal(normalizeChartSettings({ dateFormat: "yyyy-MM-dd" }).dateFormat, "yyyy-MM-dd");
  assert.equal(normalizeChartSettings({ dateFormat: "stardate" }).dateFormat, "dd MMM yy");
  // Widths are clamped to what lightweight-charts accepts.
  assert.equal(normalizeChartSettings({ crosshairWidth: 99 }).crosshairWidth, 4);
  assert.equal(normalizeChartSettings({ lastValueLineWidth: 0 }).lastValueLineWidth, 1);
});

test("A SAVED DEFAULT IS WHAT A NEW PANE STARTS FROM", () => {
  /*
   * The dialog gained a Defaults button, which every other settings dialog in
   * the product already had. It would have applied to nothing: a pane with no
   * stored settings fell straight to `DEFAULT_CHART_SETTINGS`.
   *
   * The behaviour is unchanged for anyone who never presses it —
   * `userDefaultChartSettings` returns the product's own when nothing is
   * saved — which is why this asserts both directions.
   */
  const workspace = read("lib/workspace.ts");
  assert.match(workspace, /if \(pane\?\.chartSettings === undefined\) return userDefaultChartSettings\(\);/,
    "a pane with nothing stored must read the user's default, or the button is a lie");

  const settings = read("lib/chartSettings.ts");
  for (const fn of [
    "userDefaultChartSettings", "saveUserDefaultChartSettings",
    "clearUserDefaultChartSettings", "loadChartSettingsTemplates",
    "saveChartSettingsTemplate", "deleteChartSettingsTemplate",
  ]) {
    assert.match(settings, new RegExp(`export function ${fn}\\b`), `${fn} is missing`);
  }

  // And the footer carries both, as the reference does.
  const dialog = read("components/tv/ChartSettingsModal.tsx");
  assert.match(dialog, /label="Chart settings template"/);
  assert.match(dialog, /Save current settings as…/);
  assert.match(dialog, /Save as default/);
});
