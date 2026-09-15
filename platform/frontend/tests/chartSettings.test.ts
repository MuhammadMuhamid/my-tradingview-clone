import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DATE_FORMATS, dateFormatExample, DEFAULT_CHART_SETTINGS, isDefaultChartSettings,
  MAX_SCALE_MARGIN_SUM, normalizeChartSettings, scaleMarginsFor,
  colorLuminance, resolveBackgroundGradient,
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

test("C-03/C-04 — indicator/settings additions normalize, persist, and reject invalid modes", () => {
  const value = normalizeChartSettings({
    colorBarsBasedOnPreviousClose: true,
    timeZone: "Asia/Karachi",
    noOverlappingLabels: false,
    plusButton: false,
    countdownToBarClose: false,
    previousDayClose: "line",
    previousDayCloseColor: "#123456",
    highLow: "value",
    highLowColor: "#abcdef",
    paneSeparatorColor: "#334455",
    paneButtons: "always",
  });
  assert.equal(value.colorBarsBasedOnPreviousClose, true);
  assert.equal(value.timeZone, "Asia/Karachi");
  assert.equal(value.noOverlappingLabels, false);
  assert.equal(value.plusButton, false);
  assert.equal(value.countdownToBarClose, false);
  assert.equal(value.previousDayClose, "line");
  assert.equal(value.highLow, "value");
  assert.equal(value.paneSeparatorColor, "#334455");
  assert.equal(value.paneButtons, "always");
  assert.equal(normalizeChartSettings({ timeZone: "Mars/Base" }).timeZone, "UTC");
  assert.equal(normalizeChartSettings({ paneButtons: "sometimes" }).paneButtons, "hover");
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
    ["lastValueLine", /priceLineVisible: settings\.lastValueLine/, /lastValueLine: v === "valueLine"/],
    ["lastValueLineColor", /priceLineColor: settings\.lastValueLineColor/, /lastValueLineColor: next\.color/],
    ["lastValueLineWidth", /priceLineWidth: settings\.lastValueLineWidth/, /lastValueLineWidth: next\.width/],
    ["lastValueLineStyle", /priceLineStyle: lineStyleOf\(settings\.lastValueLineStyle\)/, /lastValueLineStyle: next\.style/],
    ["lastValueLabel", /lastValueVisible: settings\.lastValueLabel/, /lastValueLabel: v === "valueLine"/],
    ["dateFormat", /dateFormat: settings\.dateFormat/, /set\("dateFormat"/],
    ["crosshairColor", /settings\.crosshairColor \? \{ color: settings\.crosshairColor \}/, /crosshairColor: next\.color/],
    ["crosshairWidth", /width: settings\.crosshairWidth as/, /crosshairWidth: next\.width/],
    ["crosshairStyle", /style: lineStyleOf\(settings\.crosshairStyle\)/, /crosshairStyle: next\.style/],
    ["watermark", /visible: settings\.watermark/, /watermark: v === "symbol"/],
    ["backgroundGradient", /settings\.backgroundGradient/, /set\("backgroundGradient", v === "gradient"\)/],
  ];
  for (const [key, engine, control] of wired) {
    assert.match(chart, engine, `${key} never reaches the chart — it is a dead switch`);
    assert.match(dialog, control, `${key} has no control in the dialog`);
    assert.ok(key in DEFAULT_CHART_SETTINGS, `${key} has no default`);
  }

  /*
   * ── R6 C-1: the shared grid pair is a MIGRATION SEED now, not a control ───
   *
   * `gridColor` / `gridStyle` are what `gridVertColor` / `gridHorzColor` and
   * their styles default FROM, and nothing else: the dialog must not write
   * them (the per-direction rows would be fighting a shared value behind their
   * backs) and the engine must not read them (one of the two directions would
   * silently win). The four the dialog writes are the four the chart applies.
   */
  assert.doesNotMatch(chart, /settings\.gridColor|settings\.gridStyle/,
    "the engine reads the per-direction pairs; the shared one is only a migration seed");
  assert.doesNotMatch(dialog, /set\("gridColor"|set\("gridStyle"/,
    "the dialog writes the per-direction pairs, not the shared one");
  for (const control of [
    /gridVertColor: next\.color/, /gridVertStyle: next\.style/,
    /gridHorzColor: next\.color/, /gridHorzStyle: next\.style/,
  ]) assert.match(dialog, control);
  for (const engine of [
    /visible: settings\.gridVertical,\s*\.\.\.\(settings\.gridVertColor \? \{ color: settings\.gridVertColor \} : \{\}\),\s*style: lineStyleOf\(settings\.gridVertStyle\),/,
    /visible: settings\.gridHorizontal,\s*\.\.\.\(settings\.gridHorzColor \? \{ color: settings\.gridHorzColor \} : \{\}\),\s*style: lineStyleOf\(settings\.gridHorzStyle\),/,
  ]) assert.match(chart, engine,
    "each direction's colour and style reach its own set of grid lines");
});

test("EVERY NEW R6 KEY HAS A DEFAULT AND A CONTROL THAT WRITES IT", () => {
  /*
   * The rule this model states about itself is that a control must reach
   * something. Its mirror is the one this test enforces: a KEY must have a
   * control, or it is a preference nobody can express.
   *
   * The apply sites for these live in `components/CandleChart.tsx` and its
   * legends, which is a separate change in flight — so this pins the half that
   * is here (default, normaliser clause, control) and the wired list above
   * pins the half that has landed. A key that appears in neither list is a key
   * nobody is accountable for.
   */
  const dialog = read("components/tv/ChartSettingsModal.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const controls: [keyof ChartSettings, RegExp][] = [
    ["borderUpColor", /set\("borderUpColor", v\)/],
    ["borderDownColor", /set\("borderDownColor", v\)/],
    ["wickUpColor", /set\("wickUpColor", v\)/],
    ["wickDownColor", /set\("wickDownColor", v\)/],
    /*
     * R3b-25: the `Title` row writes one of THREE forms now — `Name`,
     * `Ticker` and `Description`, which are the reference's — through a
     * helper that refuses anything else, instead of a two-way ternary whose
     * else-branch was the default. `Full symbol` is gone: it printed
     * `BINANCE:BTC/USDT · SPOT`, a form the reference does not offer.
     */
    ["statusTitle", /set\("statusTitle", statusTitleForm\(v\)\)/],
    // R3b-24: the logo and the market dot the reference's Instrument section has.
    ["statusLogo", /set\("statusLogo", v\)/],
    ["statusMarketStatus", /set\("statusMarketStatus", v\)/],
    // R3b-25: the legend's `Background` plate and its opacity slider.
    ["statusLegendBackground", /set\("statusLegendBackground", v\)/],
    ["statusLegendBackgroundOpacity", /set\("statusLegendBackgroundOpacity", Number\(e\.target\.value\)\)/],
    ["statusDayChange", /set\("statusDayChange", v\)/],
    ["statusIndicatorTitles", /set\("statusIndicatorTitles", v\)/],
    ["statusIndicatorInputs", /set\("statusIndicatorInputs", v\)/],
    ["statusIndicatorValues", /set\("statusIndicatorValues", v\)/],
    ["scaleButtons", /set\("scaleButtons", v as ChartSettings\["scaleButtons"\]\)/],
    ["indicatorLastValue", /set\("indicatorLastValue", v === "value"\)/],
    ["bidAskLines", /set\("bidAskLines", v === "line" \? "line" : "hidden"\)/],
    ["bidColor", /set\("bidColor", v\)/],
    ["askColor", /set\("askColor", v\)/],
    ["dayOfWeekOnLabels", /set\("dayOfWeekOnLabels", v\)/],
    ["backgroundColor", /set\("backgroundColor", v\)/],
    ["gridVertColor", /gridVertColor: next\.color/],
    ["gridVertStyle", /gridVertStyle: next\.style/],
    ["gridHorzColor", /gridHorzColor: next\.color/],
    ["gridHorzStyle", /gridHorzStyle: next\.style/],
    ["watermarkMode", /watermarkMode: v as WatermarkMode/],
    ["watermarkColor", /set\("watermarkColor", v\)/],
    ["scaleTextColor", /set\("scaleTextColor", v\)/],
    ["scaleLineColor", /set\("scaleLineColor", v\)/],
    ["showPnlValue", /set\("showPnlValue", v\)/],
    ["showExecutionMarks", /set\("showExecutionMarks", v\)/],
    ["showExecutionLabels", /set\("showExecutionLabels", v\)/],
    ["showAlertLines", /set\("showAlertLines", v\)/],
    ["onlyActiveAlerts", /set\("onlyActiveAlerts", v\)/],
  ];
  for (const [key, control] of controls) {
    assert.ok(key in DEFAULT_CHART_SETTINGS, `${key} has no default`);
    assert.match(dialog, control, `${key} has no control in the dialog`);
    // And the normaliser has a clause: an unknown value must not survive.
    assert.notEqual(
      (normalizeChartSettings({ [key]: "\u0000not a value" }) as unknown as Record<string, unknown>)[key],
      "\u0000not a value",
      `${key} passes a malformed stored value straight through`,
    );
  }
});

test("R6 MIGRATION — one grid appearance becomes one per direction", () => {
  /*
   * `gridColor` / `gridStyle` were shared by both directions. A user who had
   * pinned a magenta dotted grid must find a magenta dotted grid in BOTH new
   * rows, not the theme's default in either.
   */
  const migrated = normalizeChartSettings({ gridColor: "#ff00ff", gridStyle: "dotted" });
  assert.equal(migrated.gridVertColor, "#ff00ff");
  assert.equal(migrated.gridHorzColor, "#ff00ff");
  assert.equal(migrated.gridVertStyle, "dotted");
  assert.equal(migrated.gridHorzStyle, "dotted");
  // The seed itself survives, because the apply site still reads it.
  assert.equal(migrated.gridColor, "#ff00ff");

  // A new-shape value wins over the seed, per direction and per property.
  const explicit = normalizeChartSettings({
    gridColor: "#ff00ff", gridStyle: "dotted",
    gridHorzColor: "#00ff00", gridVertStyle: "dashed",
  });
  assert.equal(explicit.gridVertColor, "#ff00ff");
  assert.equal(explicit.gridHorzColor, "#00ff00");
  assert.equal(explicit.gridVertStyle, "dashed");
  assert.equal(explicit.gridHorzStyle, "dotted");

  // Nothing stored: the theme's own, in all four.
  const fresh = normalizeChartSettings({});
  assert.equal(fresh.gridVertColor, "");
  assert.equal(fresh.gridHorzColor, "");
  assert.equal(fresh.gridVertStyle, "solid");
  assert.equal(fresh.gridHorzStyle, "solid");
});

test("R6 MIGRATION — the watermark boolean becomes a three-state mode", () => {
  /*
   * `true` meant "the instrument's name behind the bars", which is the mode
   * called `symbol`; `false` meant `hidden`. Getting this backwards — or
   * defaulting a stored `true` to `hidden` — turns a watermark a user asked
   * for off, silently, on the update that adds the replay state.
   */
  assert.equal(normalizeChartSettings({ watermark: true }).watermarkMode, "symbol");
  assert.equal(normalizeChartSettings({ watermark: false }).watermarkMode, "hidden");
  assert.equal(normalizeChartSettings({}).watermarkMode, "hidden");
  // The new value wins, and the boolean the apply site still reads is kept in
  // step with it rather than left to drift.
  assert.equal(normalizeChartSettings({ watermark: true, watermarkMode: "replay" }).watermarkMode, "replay");
  assert.equal(normalizeChartSettings({ watermark: true, watermarkMode: "replay" }).watermark, false);
  assert.equal(normalizeChartSettings({ watermarkMode: "symbol" }).watermark, true);
  assert.equal(normalizeChartSettings({ watermarkMode: "elsewhere" }).watermarkMode, "hidden");
});

test("R6 MIGRATION — one indicator switch becomes titles, inputs and values", () => {
  /*
   * `statusIndicatorValues` gated the whole legend. A user who had turned the
   * legend OFF must not find titles and inputs back on; one who had it on gets
   * all three, which is what they were already seeing.
   */
  const off = normalizeChartSettings({ statusIndicatorValues: false });
  assert.equal(off.statusIndicatorTitles, false);
  assert.equal(off.statusIndicatorInputs, false);
  assert.equal(off.statusIndicatorValues, false);

  const on = normalizeChartSettings({ statusIndicatorValues: true });
  assert.equal(on.statusIndicatorTitles, true);
  assert.equal(on.statusIndicatorInputs, true);
  assert.equal(on.statusIndicatorValues, true);

  // An explicit new-shape value still wins over the legacy one.
  const mixed = normalizeChartSettings({ statusIndicatorValues: false, statusIndicatorTitles: true });
  assert.equal(mixed.statusIndicatorTitles, true);
  assert.equal(mixed.statusIndicatorInputs, false);
});

test("R6 MIGRATION — a candle's borders and wicks start as its body's colours", () => {
  /*
   * The pair per component is new; before it, a border and a wick were drawn
   * in `upColor` / `downColor`. A workspace that predates the split must look
   * IDENTICAL after it, which means seeding from the body rather than from the
   * product default.
   */
  const migrated = normalizeChartSettings({ upColor: "#112233", downColor: "#445566" });
  assert.equal(migrated.borderUpColor, "#112233");
  assert.equal(migrated.borderDownColor, "#445566");
  assert.equal(migrated.wickUpColor, "#112233");
  assert.equal(migrated.wickDownColor, "#445566");

  // Set explicitly, they are their own.
  const explicit = normalizeChartSettings({ upColor: "#112233", wickUpColor: "#aabbcc" });
  assert.equal(explicit.wickUpColor, "#aabbcc");
  assert.equal(explicit.borderUpColor, "#112233");

  // And a malformed one falls back to the body, not to the product default.
  const bad = normalizeChartSettings({ upColor: "#112233", borderUpColor: "rgb(1,2,3)" });
  assert.equal(bad.borderUpColor, "#112233");
});

test("R6 — the remaining new keys clamp and default the way the model says", () => {
  /*
   * `hover`, not `always`: R1-11 moved the `log % auto reset` group onto the
   * axis and revealed it on hover, and the reference's own row reads
   * `Visible on mouse over`. A default of `always` would have relit that
   * group on every chart on the update that added the control.
   */
  assert.equal(normalizeChartSettings({}).scaleButtons, "hover");
  assert.equal(normalizeChartSettings({ scaleButtons: "always" }).scaleButtons, "always");
  assert.equal(normalizeChartSettings({ scaleButtons: "sometimes" }).scaleButtons, "hover");

  assert.equal(normalizeChartSettings({}).statusTitle, "ticker");
  assert.equal(normalizeChartSettings({ statusTitle: "symbol" }).statusTitle, "symbol");
  assert.equal(normalizeChartSettings({ statusTitle: "urn" }).statusTitle, "ticker");

  assert.equal(normalizeChartSettings({}).bidAskLines, "hidden");
  assert.equal(normalizeChartSettings({ bidAskLines: "line" }).bidAskLines, "line");
  assert.equal(normalizeChartSettings({ bidColor: "" }).bidColor, DEFAULT_CHART_SETTINGS.bidColor);

  // The theme-following colours: `""` is legal and must survive a round trip.
  for (const key of ["backgroundColor", "watermarkColor", "scaleTextColor", "scaleLineColor"] as const) {
    assert.equal(normalizeChartSettings({}) [key], "");
    assert.equal(normalizeChartSettings({ [key]: "" })[key], "");
    assert.equal(normalizeChartSettings({ [key]: "#123456" })[key], "#123456");
    assert.equal(normalizeChartSettings({ [key]: "teal" })[key], "");
  }

  // The booleans the reference has on, and the one it has off.
  for (const key of ["indicatorLastValue", "dayOfWeekOnLabels", "showPnlValue",
    "showExecutionMarks", "showExecutionLabels", "showAlertLines", "onlyActiveAlerts"] as const) {
    assert.equal(DEFAULT_CHART_SETTINGS[key], true, `${key} should default on`);
    assert.equal(normalizeChartSettings({ [key]: false })[key], false);
    assert.equal(normalizeChartSettings({ [key]: "no" })[key], true,
      `${key} must not be disabled by a malformed stored value`);
  }
  assert.equal(DEFAULT_CHART_SETTINGS.statusDayChange, false);
  assert.equal(normalizeChartSettings({ statusDayChange: true }).statusDayChange, true);
});

test("R6 — a date format is offered as a date, not as its pattern", () => {
  /*
   * The dropdown listed `dd MMM yy` — the library's substitution tokens,
   * printed at a trader. Each option is the date the axis will draw.
   */
  assert.equal(dateFormatExample("dd MMM yy"), "29 Sep '97");
  assert.equal(dateFormatExample("MMM dd, yyyy"), "Sep 29, 1997");
  assert.equal(dateFormatExample("yyyy-MM-dd"), "1997-09-29");
  assert.equal(dateFormatExample("dd/MM/yyyy"), "29/09/1997");
  assert.equal(dateFormatExample("MM/dd/yyyy"), "09/29/1997");
  // Every format the dialog offers renders to something a reader can tell
  // apart from the others.
  const rendered = DATE_FORMATS.map(dateFormatExample);
  assert.equal(new Set(rendered).size, rendered.length);
  for (const example of rendered) {
    assert.doesNotMatch(example, /MM|dd|yy(?!.*')/, `${example} still shows a pattern token`);
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

  /*
   * ── R6 CH-4: the footer is ONE control on the left ───────────────────────
   *
   * `Template` and `Defaults` were two native `<select>`s whose options were
   * commands (`__save`, `__delete:<name>`, `save`, `reset`) and whose value was
   * always `""` — a menu wearing a field's clothes, twice, where the reference
   * has a single ghost button opening a menu.
   *
   * E1-06's rule survives the change and is what the last two assertions pin:
   * the destructive item is a NAMED ROW, and dismissing the menu does nothing.
   */
  const dialog = read("components/tv/ChartSettingsModal.tsx");
  assert.match(dialog, /aria-label="Chart settings template"/);
  assert.match(dialog, /role="menu"/, "the template control is a menu, not a field");
  for (const item of ["Save as…", "Apply defaults", "Save as my default"]) {
    assert.ok(dialog.includes(`>\n            ${item}\n`) || dialog.includes(item),
      `the template menu is missing “${item}”`);
  }
  assert.doesNotMatch(dialog, /label="Chart defaults"/,
    "the second footer select is gone; its two items are rows of the one menu");
  assert.doesNotMatch(dialog, /cancelLabel: "Reset this chart"/,
    "dismissing a dialog must never be the destructive branch");
});

test("NO NATIVE SELECT SURVIVES INSIDE THE CHART SETTINGS DIALOG", () => {
  /*
   * R6 CH-6. A native `<select>` renders the OS's chevron and opens the OS's
   * popup — a different font, a different row height, a different selection
   * colour — and there were five of them in this dialog plus two in its
   * footer. It is the loudest "not that product" tell a screenshot can carry,
   * and it cannot be styled away.
   */
  // Comments stripped: this file's own header NAMES the five selects it
  // replaced, and a rule its own documentation can trip is not a rule.
  const dialog = read("components/tv/ChartSettingsModal.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(dialog, /<select|<Select\b/,
    "this dialog draws its own menus — see `Dropdown` in components/ui.tsx");
  // And the primitive it uses instead opens the product's own popover grammar.
  const ui = read("components/ui.tsx");
  assert.match(ui, /export function Dropdown\(/);
  assert.match(ui, /role="listbox"/);
  assert.match(ui, /className="tvc-menu tvc-menu--compact"/,
    "a dropdown opens the shared popover at the 32px row");
});

test("no settings row can outgrow the dialog's content column", () => {
  /*
   * ── TVP8, re-derived for R6's grid ───────────────────────────────────────
   *
   * The old shape was a 188px label column with the controls flowing after it,
   * and the defect it guarded was a row growing a horizontal scrollbar. The
   * grammar is a two-column grid now: column one is `minmax(<the tab's value
   * column>, max-content)`, column two is the rest, and the same defect is
   * still possible — a 180px dropdown beside a 75px line-style button on the
   * tab with the widest label column.
   *
   * Every number is READ from the file that owns it. The previous version of
   * this test did arithmetic over literals transcribed from the source, so
   * widening a control to 400px left it green.
   */
  const dialog = read("components/tv/ChartSettingsModal.tsx");
  const ui = read("components/ui.tsx");

  /*
   * R6b-06 REWROTE this assertion rather than deleting it.
   *
   * It pinned the floor-and-grow column as the ONLY column, and the Status tab
   * measured wrong because of it: `max-content` let the widest label on that
   * tab (`Last day change values`, 179px) push the `Title` dropdown to x=790
   * against the reference's 714. TradingView lets that label overflow into the
   * empty second column instead. So the Status tab is a FIXED 103px and every
   * other tab keeps the measured floor — which is what this now asks for.
   */
  assert.match(dialog, /tab === "status"\s*\?\s*"103px 1fr"/,
    "the Status tab's value column is fixed, or `Title` lands at x=790");
  assert.match(dialog, /minmax\(\$\{VALUE_COLUMN\[tab\]\}px, max-content\) 1fr/,
    "every other tab's rows share one grid, so its controls line up in one column");

  const numbers = (pattern: RegExp, source: string): number[] => {
    const found = [...source.matchAll(pattern)].map((m) => Number(m[1]));
    assert.ok(found.length > 0, `nothing matched ${pattern}`);
    return found;
  };

  // The widest value column any tab asks for, and the widest control run that
  // can sit in it: a dropdown, a gap, and a line-style button.
  const valueColumns = numbers(/^\s+(?:symbol|status|scales|canvas|trading|alerts|events): (\d+),/gm, dialog);
  const widestColumn = Math.max(...valueColumns);
  const widestDropdown = Math.max(...numbers(/width=\{(\d+)\}/g, dialog));
  const lineButton = numbers(/h-\[34px\] w-\[(\d+)px\] items-center justify-center rounded-md/g, ui)[0]!;
  const swatch = numbers(/flex h-\[34px\] w-\[(\d+)px\] items-center justify-center rounded-md/g, ui)[0]!;

  // 750 panel − 2×20 padding − 206 rail − 20 gutter.
  const contentColumn = 750 - 40 - 206 - 20;
  const forControls = contentColumn - widestColumn - 20;
  const densest = widestDropdown + 8 + lineButton;
  assert.ok(densest <= forControls,
    `the densest row is ${densest}px in a ${forControls}px column `
    + `(dropdown ${widestDropdown}, line button ${lineButton}, column ${widestColumn})`);

  // The Bid and ask row is a dropdown and two swatches, on the same tab.
  const bidAsk = widestDropdown + 8 + swatch + 8 + swatch;
  assert.ok(bidAsk <= forControls, `the bid/ask row is ${bidAsk}px in ${forControls}px`);
});

test("THIN BARS REACHES THE BARS SERIES, AND ONLY IT", () => {
  /*
   * ── TVP8 round two ─────────────────────────────────────────────────────
   *
   * The reference's Symbol tab offers "Thin bars" on its Bars chart. This
   * product had no such setting, and could not have had one: `thinBars: false`
   * was hard-coded at the moment the series was created, which is the only
   * place lightweight-charts was ever told about it. So a zoomed-in Bars chart
   * here was a row of fat ticks where the reference's stays hairline, with no
   * control anywhere to say otherwise.
   *
   * The default is `true` — the library's own, and the reference's.
   */
  assert.equal(DEFAULT_CHART_SETTINGS.thinBars, true);
  assert.equal(normalizeChartSettings({}).thinBars, true);
  assert.equal(normalizeChartSettings({ thinBars: false }).thinBars, false);
  // A setting that is not a boolean must not disable a feature by accident.
  assert.equal(normalizeChartSettings({ thinBars: "no" }).thinBars, true);
  assert.equal(normalizeChartSettings({ thinBars: 0 }).thinBars, true);

  const chart = read("components/CandleChart.tsx");

  /*
   * Applied by its own effect, gated on the RENDER KIND. It cannot share the
   * candle effect: `applyOptions({ thinBars })` on a candlestick series is an
   * option that series does not have, and lightweight-charts ignores it in
   * silence rather than complaining — so an effect that covered both would do
   * nothing on 20 of the 21 chart types and look like it worked.
   */
  assert.match(chart, /if \(!series \|\| renderKind\(chartType\) !== "bars"\) return;/);
  assert.match(chart, /\(series as ISeriesApi<"Bar">\)\.applyOptions\(\{\s*thinBars: settings\.thinBars,/);
  assert.match(chart, /\}, \[chartType, chartReady, settings\.thinBars, upColor, downColor\]\);/);

  // And the creation path no longer welds it shut.
  assert.match(chart, /chart\.addBarSeries\(\{ upColor: CHART_UP, downColor: CHART_DOWN \}\)/);
  assert.doesNotMatch(chart, /addBarSeries\(\{[^}]*thinBars/,
    "a value set at creation is a value no setting can change");

  // The control is offered on the one chart type that has a bar to thin, and
  // gated on the render kind so a second bar-drawn type inherits it.
  const modal = read("components/tv/ChartSettingsModal.tsx");
  assert.match(modal, /const thinBarsApplies = renderKind\(chartType\) === "bars";/);
  assert.match(modal, /\{thinBarsApplies && \(/);
  assert.match(modal, /set\("thinBars", v\)/);
});

// ── IO-A8: the margin pair ─────────────────────────────────────────────────

/*
 * IO-A8 was reported as "both margin controls are inert" and is NOT.
 * `tests/dom/scaleMargins.test.ts` drives the real price scale and records the
 * measurement: the library's test is `sum > 1`, the dialog's maximum is exactly
 * 1.0, and 1.0 is accepted. What is pinned here is the clamp that keeps a
 * FUTURE widening of either cap from landing on the far side of that line,
 * where the call site's `catch` would swallow it into exactly the inert state
 * the finding described.
 */

test("IO-A8 — every pair the dialog can produce passes through untouched", () => {
  // The two controls cap at 50 each, so 50/50 is the most that can be asked
  // for. It is inside the library's limit and must not be quietly rewritten.
  assert.deepEqual(scaleMarginsFor(50, 50), { top: 0.5, bottom: 0.5 });
  assert.deepEqual(scaleMarginsFor(10, 8), { top: 0.1, bottom: 0.08 });
  assert.deepEqual(scaleMarginsFor(0, 0), { top: 0, bottom: 0 });
});

test("IO-A8 — a pair beyond the library's limit is scaled, not dropped", () => {
  /*
   * Unreachable from today's dialog, which is the point: this is the guard for
   * the day someone widens a cap from 50, and without it that change is a
   * throw the call site swallows into two dead controls.
   */
  const { top, bottom } = scaleMarginsFor(60, 60);
  assert.ok(top + bottom <= MAX_SCALE_MARGIN_SUM + 1e-9,
    `the library refuses a sum above 1; got ${top + bottom}`);
  assert.equal(Math.round(top * 1000), Math.round(bottom * 1000),
    "equal margins asked for, equal margins given");
});

test("IO-A8 — a capped pair keeps the ratio the user asked for", () => {
  /*
   * Clamping only the second value would silently privilege whichever control
   * happened to be written first. Twice as much room above as below stays
   * twice as much.
   */
  const { top, bottom } = scaleMarginsFor(80, 40);
  assert.ok(top + bottom <= MAX_SCALE_MARGIN_SUM + 1e-9);
  assert.ok(Math.abs(top / bottom - 2) < 1e-9,
    `the 2:1 the user set became ${top}:${bottom}`);
});

test("IO-A8 — nonsense is a margin of zero, not a NaN the chart swallows", () => {
  assert.deepEqual(scaleMarginsFor(Number.NaN, 10), { top: 0, bottom: 0.1 });
  assert.deepEqual(scaleMarginsFor(-20, 10), { top: 0, bottom: 0.1 });
});

test("EVERY NEW R6 KEY REACHES THE ENGINE OR THE MARKUP", () => {
  /*
   * ── The other half of the rule this model states about itself ────────────
   *
   * The test above pins that every new key has a default, a normaliser clause
   * and a control. This pins the end that matters to a reader: the control
   * MOVES something. Each row traces the key to the expression that applies
   * it, with comments stripped — a rule its own documentation can satisfy is
   * not a rule.
   *
   * The keys whose effect is MARKUP rather than canvas are driven through the
   * DOM in `tests/dom/chartSettingsApply.test.tsx`, by clicking the real
   * control; they are listed here too, because a grep that says WHERE is what
   * makes a missing apply site findable when one of those fails.
   */
  const strip = (rel: string): string => read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const chart = strip("components/CandleChart.tsx");
  const pane = strip("components/tv/ChartPane.tsx");
  const paneLegend = strip("components/tv/PaneLegend.tsx");
  const studyLegend = strip("components/tv/IndicatorLegend.tsx");
  const studyPane = strip("components/tv/IndicatorPane.tsx");
  const workspace = strip("app/chart/page.tsx");
  const overlays = strip("lib/useTradingOverlays.ts");

  const applied: [keyof ChartSettings, string, RegExp][] = [
    // Symbol — the candle's own components, which shared the body's pair.
    ["borderUpColor", "CandleChart", /borderUpColor: candleBorders \? borderUpColor : clear/],
    ["borderDownColor", "CandleChart", /borderDownColor: candleBorders \? borderDownColor : clear/],
    ["wickUpColor", "CandleChart", /wickUpColor: candleWicks \? wickUpColor : clear/],
    ["wickDownColor", "CandleChart", /wickDownColor: candleWicks \? wickDownColor : clear/],

    // Canvas.
    ["backgroundColor", "CandleChart", /const ground = settings\.backgroundColor \|\| "rgba\(0,0,0,0\)"/],
    ["watermarkMode", "CandleChart", /visible: settings\.watermarkMode === "replay" \? replaying : settings\.watermark/],
    ["watermarkColor", "CandleChart", /color: settings\.watermarkColor \|\| chartWatermarkColor\(\)/],
    ["scaleTextColor", "CandleChart", /settings\.scaleTextColor \? \{ textColor: settings\.scaleTextColor \}/],
    ["scaleLineColor", "CandleChart", /settings\.scaleLineColor \? \{ borderColor: settings\.scaleLineColor \}/],

    // Scales and lines.
    /*
     * R6b-13 REWROTE this row rather than deleting it.
     *
     * The expression it pinned — `dayOfWeekOnLabels ? { tickMarkFormatter:
     * dayOfWeekTickFormatter } : { tickMarkFormatter: undefined }` — was an
     * apply site that could not turn OFF: lightweight-charts merges options
     * with a spread, and a key whose value is `undefined` overwrites nothing,
     * so the ON formatter was never uninstalled and the row was inert on every
     * chart that had ever had it on. The test passed the whole time, because
     * it asked whether the setting was READ and not whether OFF was written.
     * It asks for the pair now.
     */
    ["dayOfWeekOnLabels", "CandleChart", /tickMarkFormatter: dayOfWeekFormatter\(settings\.dayOfWeekOnLabels, settings\.timeZone\)/],
    ["indicatorLastValue", "CandleChart", /const lastValueVisible = settings\.indicatorLastValue/],
    ["bidAskLines", "CandleChart", /settings\.bidAskLines === "line" && live && !isCanonicalInstrumentId\(symbol\)/],
    ["bidColor", "CandleChart", /price: bookQuote\.bid, color: settings\.bidColor/],
    ["askColor", "CandleChart", /price: bookQuote\.ask, color: settings\.askColor/],
    ["scaleButtons", "CandleChart", /settings\.scaleButtons !== "hidden" &&/],

    // Trading and alerts — one switch that used to gate three different things.
    ["showTrading", "CandleChart", /line\.kind === "alert" \? settings\.showAlertLines : settings\.showTrading/],
    ["showAlertLines", "CandleChart", /line\.kind === "alert" \? settings\.showAlertLines : settings\.showTrading/],
    ["showExecutionMarks", "CandleChart", /settings\.showExecutionMarks \? \(trades \?\? \[\]\) : \[\]/],
    ["showExecutionLabels", "CandleChart", /const labelled = settings\.showExecutionLabels\s*&& tradeMarkerCount\(visibleTrades, inWindow\) <= TRADE_LABEL_LIMIT/],
    ["showPnlValue", "CandleChart", /settings\.showPnlValue && l\.pnl \? `\$\{l\.title\} \$\{l\.pnl\}` : l\.title/],

    // Status line.
    /*
     * R3b-25: three forms, and the `symbol` value now resolves to the TICKER.
     * The stored literals are unchanged so every workspace on disk keeps
     * working — see `StatusTitleForm`.
     */
    ["statusTitle", "CandleChart", /settings\.statusTitle === "symbol" \? displayTicker\(symbol\)/],
    // R3b-24: the mark before the name, and the dot after the venue.
    ["statusLogo", "CandleChart", /settings\.showStatusLine && settings\.statusSymbol && settings\.statusLogo && \(\s*<InstrumentLogo symbol=\{symbol\} \/>\s*\)/],
    ["statusMarketStatus", "CandleChart", /settings\.statusSymbol && settings\.statusMarketStatus\s*\n?\s*&& marketOpen\(symbol\) === true/],
    // R3b-25: the plate behind the legend's text runs.
    ["statusLegendBackground", "CandleChart", /const legendPlate = settings\.statusLegendBackground/],
    ["statusLegendBackgroundOpacity", "CandleChart", /\$\{settings\.statusLegendBackgroundOpacity \/ 100\}/],
    ["statusDayChange", "CandleChart", /settings\.statusDayChange && dayChange !== null/],
    ["statusIndicatorTitles", "CandleChart", /showTitles=\{settings\.statusIndicatorTitles\}/],
    ["statusIndicatorInputs", "CandleChart", /showInputs=\{settings\.statusIndicatorInputs\}/],
    ["statusIndicatorValues", "CandleChart", /showValues=\{settings\.statusIndicatorValues\}/],
  ];
  const source: Record<string, string> = { CandleChart: chart };
  for (const [key, file, expression] of applied) {
    assert.match(source[file]!, expression,
      `${key} never reaches the chart — it is a dead switch`);
    assert.ok(key in DEFAULT_CHART_SETTINGS, `${key} has no default`);
  }

  /*
   * And the apply sites that are NOT in `CandleChart`, because the thing they
   * move is not drawn there.
   */
  // SL-2: the pane's own legend is the identity the chart shows when it has one.
  assert.match(pane, /titleForm=\{\(pane\.chartSettings\?\.statusTitle\) === "symbol" \? "symbol" : "ticker"\}/);
  /*
   * R3b-25: `symbol` is the TICKER form now (`BTCUSDT`), not the qualified
   * `BINANCE:BTC/USDT · SPOT` — which is not one of the reference's three
   * `Title` options and is exactly what §5 keeps out of primary copy.
   */
  assert.match(paneLegend, /props\.titleForm === "symbol"\s*\?\s*tickerLabel/);
  /*
   * R6b-H: and the same three indicator rows reach a study in its OWN pane.
   * They were threaded into the price pane's overlay legend and stopped
   * there, so `Inputs` off moved an RSI pane by 0px.
   */
  assert.equal((chart.match(/showInputs=\{settings\.statusIndicatorInputs\}/g) ?? []).length, 2,
    "both legends — the price pane's overlays AND the study panes — take the row");
  assert.match(studyPane, /showInputs=\{showInputs\}/,
    "and the pane hands them to the legend it mounts");
  // SL-1: the legend's three parts are three props, not one mount decision.
  for (const prop of [/showTitles && /, /showTitles && showInputs && group\.plots\[0\]\?\.statusInputVisible/, /showValues && group\.plots/]) {
    assert.match(studyLegend, prop, "the legend must hide its own parts, not be unmounted whole");
  }
  // SC-3: a study in its own pane is still a study.
  assert.match(chart, /lastValue=\{settings\.indicatorLastValue\}/);
  assert.match(studyPane, /lastValueVisible: lastValue && overlay\?\.priceScaleLabelVisible !== false/);
  /*
   * SC-5(d): and the visible time axis is not always the price chart's. With a
   * study pane on screen the axis is drawn once, under the LOWEST pane, by that
   * pane's own chart — so a formatter installed only on the price chart would
   * move nothing for any user with an oscillator open.
   */
  assert.match(chart, /dayOfWeekOnLabels=\{settings\.dayOfWeekOnLabels\}/);
  // R6b-13: and the pane's own OFF is a function too — see the rewritten row
  // in the table above.
  assert.match(studyPane, /tickMarkFormatter: dayOfWeekFormatter\(dayOfWeekOnLabels, timeZone\)/);
  // A-1: `Only active alerts` is the filter, and it is a parameter now.
  assert.match(workspace, /\(!onlyActive \|\| isAlertActive\(a\)\)/,
    "onlyActiveAlerts must be able to turn the filter OFF, or the row moves nothing");
  assert.match(workspace, /paneChartSettings\(workspace, pane\.id\)\.onlyActiveAlerts/);
  assert.match(workspace, /kind: "alert" as const/,
    "an alert level must be distinguishable from a position level, or one switch hides both");
  assert.match(workspace, /hasBidAsk=\{settingsQuote !== null\}/,
    "the Bid and ask row appears only for a feed that has answered");
  // T-2: the only positions in this product that prove a P&L.
  assert.match(overlays, /manualPnl\.get\(item\.identifiers\.manualPositionId \?\? ""\)/);
  assert.match(workspace, /manualPositions: manualState\?\.positions \?\? \[\]/);
});

test("R6b-18 — the theme's own gradient is a gradient a user can see", () => {
  /*
   * ── The measurement this replaces ─────────────────────────────────────────
   *
   * `Background → Gradient` with both wells on `Theme` laid
   * `rgba(41,98,255,0.06)` over transparent: rows 60..70 of the plot went from
   * 45/30/32 to 46/34/43 — three points of luminance across the whole canvas,
   * i.e. a dropdown option that moved nothing. The reference shows a second
   * well the moment Gradient is chosen and draws a visible wash.
   */
  const pair = resolveBackgroundGradient("", "");
  assert.notEqual(pair.top, pair.bottom, "both ends resolved to one colour");
  const separation = Math.abs(colorLuminance(pair.top) - colorLuminance(pair.bottom));
  assert.ok(separation >= 24,
    `the two ends differ by ${separation.toFixed(1)} points of luminance; the previous answer was 3`);
});

test("R6b-18 — a chosen colour wins over the theme, in either well", () => {
  const pair = resolveBackgroundGradient("#2a2e39", "");
  assert.equal(pair.top, "#2a2e39");
  assert.ok(pair.bottom.startsWith("#"), "the untouched well is still a real colour");
  const both = resolveBackgroundGradient("#2a2e39", "#131722");
  assert.deepEqual(both, { top: "#2a2e39", bottom: "#131722" });
});

test("R6b-13/14/19 — the reach rows are applied to the STUDY PANES, not only to price", () => {
  /*
   * ── Why this is a source assertion and what it is NOT ────────────────────
   *
   * That the pane HONOURS these options is driven against a real
   * lightweight-charts chart in `tests/dom/studyPaneCanvas.test.tsx`. What a
   * DOM test cannot see is the WIRE — whether `CandleChart` hands them over at
   * the pane's mount — because with the props missing the pane simply falls
   * back to the theme and looks plausible. That is exactly the shape R6b
   * found: six rows moving the price pane and nothing else.
   */
  const strip = (rel: string): string => read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const chart = strip("components/CandleChart.tsx");
  const clock = strip("lib/chartClock.ts");

  for (const prop of [
    "dateFormat={settings.dateFormat}",
    "timeFormat24h={settings.timeFormat24h}",
    "backgroundColor={settings.backgroundColor}",
    "backgroundGradient={settings.backgroundGradient}",
    "gridVertical={settings.gridVertical}",
    "gridHorizontal={settings.gridHorizontal}",
    "showCrosshair={settings.showCrosshair}",
    "scaleTextColor={settings.scaleTextColor}",
    "scaleLineColor={settings.scaleLineColor}",
  ]) {
    assert.ok(chart.includes(prop),
      `the study panes never receive ${prop} — the row moves the price pane only`);
  }

  /*
   * And the formatter bug itself: `undefined` is not "off". The library merges
   * options with a spread, so a key whose value is `undefined` overwrites
   * nothing and the ON formatter is never uninstalled.
   */
  assert.doesNotMatch(chart, /tickMarkFormatter: undefined/);
  assert.doesNotMatch(chart, /timeFormatter: settings\.timeFormat24h \? undefined/);
  assert.match(chart, /tickMarkFormatter: dayOfWeekFormatter\(settings\.dayOfWeekOnLabels, settings\.timeZone\)/);
  assert.match(chart, /timeFormatter: hoursFormatter\(settings\.timeFormat24h, settings\.timeZone\)/);
  assert.match(clock, /export function defaultTickFormatter/);
  assert.match(clock, /export function hour12Formatter/);
  assert.match(clock, /export function hour24Formatter/);

  const pane = strip("components/tv/IndicatorPane.tsx");
  assert.doesNotMatch(pane, /tickMarkFormatter: dayOfWeekOnLabels \? dayOfWeekTickFormatter : undefined/);
  assert.match(pane, /tickMarkFormatter: dayOfWeekFormatter\(dayOfWeekOnLabels, timeZone\)/);
  assert.match(pane, /timeFormatter: hoursFormatter\(timeFormat24h, timeZone\)/);
});
