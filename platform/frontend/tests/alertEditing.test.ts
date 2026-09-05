/**
 * The alert editor's rules, without a DOM.
 *
 * The component is a renderer: it reads `alertEditForm`, writes through
 * `alertEditRequest`, and refuses to save what `validateAlertForm` names. So
 * the behaviour worth pinning is here — what loads, what is sent, and what is
 * NOT sent, which is the half that decides whether editing one field silently
 * resets another.
 *
 * The static checks at the end cover what a pure test cannot: that both
 * surfaces actually mount the editor, and that clicking an armed alert opens
 * the alert rather than a blank dialog for its family.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ConditionKind, MaAlert } from "../lib/api";
import {
  ALERT_FAMILY_LABELS, alertEditForm, alertEditRequest, hasAlertChanges,
  leavesFilteredView, modesFor, pivotLevelNames, usesBand, usesGates,
  validateAlertForm,
} from "../lib/alertEditing";

const ROOT = path.join(__dirname, "..");

const BASE: MaAlert = {
  id: "a1", symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
  maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
  targetPrice: 100, priceDirection: "either",
  srSide: null, srPivotLength: null, srInvalidation: null,
  pivotType: null, pivotLevelName: null, pivotAnchor: null,
  rsiLength: null, rsiLevel: null, rsiMaLength: null,
  macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null,
  filterStAtrMethod: null, filterStSide: null,
  stPeriod: null, stMultiplier: null, stAtrMethod: null,
  bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
  stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
  adxDiLength: null, adxSmoothing: null, adxLevel: null,
  nearMinPct: 0.2, nearMaxPct: 0.5, enabled: true,
  frequency: "once_per_bar_close", cooldownMin: 60, note: null,
  lastSide: "below", lastFiredAt: null, lastFiredBarTime: null,
  lastBarTime: null, completedAt: null, createdAt: "", updatedAt: "",
};

const ALERTS: Record<ConditionKind, MaAlert> = {
  price: { ...BASE, conditionKind: "price", targetPrice: 64250.5, priceDirection: "cross_up" },
  ma: {
    ...BASE, conditionKind: "ma", targetPrice: null, priceDirection: null,
    maType: "ema", maLength: 200, mode: "near_above", nearMinPct: 0.3, nearMaxPct: 0.9,
  },
  ma_vs_ma: {
    ...BASE, conditionKind: "ma_vs_ma", targetPrice: null, priceDirection: null,
    maType: "ema", maLength: 50, ma2Type: "sma", ma2Length: 200, mode: "cross_up",
  },
  sr_zone: {
    ...BASE, conditionKind: "sr_zone", targetPrice: null, priceDirection: null,
    srSide: "support", srPivotLength: 7, srInvalidation: "wick",
    mode: "near_below", nearMinPct: 0.25, nearMaxPct: 0.75,
    filterRsiLength: 21, filterRsiLevel: 55, filterRsiSide: "above",
  },
  pivot_level: {
    ...BASE, conditionKind: "pivot_level", targetPrice: null, priceDirection: null,
    pivotType: "Camarilla", pivotLevelName: "R3", pivotAnchor: "4h", mode: "touch",
  },
  rsi: {
    ...BASE, conditionKind: "rsi", targetPrice: null, priceDirection: null,
    rsiLength: 14, rsiLevel: 70, rsiMaLength: 9, indicatorTarget: "level", mode: "cross_down",
  },
  supertrend: {
    ...BASE, conditionKind: "supertrend", targetPrice: null, priceDirection: null,
    stPeriod: 14, stMultiplier: 2.5, stAtrMethod: "sma", mode: "cross_down",
  },
  bollinger: {
    ...BASE, conditionKind: "bollinger", targetPrice: null, priceDirection: null,
    bbLength: 30, bbMult: 2.5, bbBand: "lower", bbMaType: "ema", mode: "near_below",
    nearMinPct: 0.15, nearMaxPct: 0.6,
  },
  stochastic: {
    ...BASE, conditionKind: "stochastic", targetPrice: null, priceDirection: null,
    stochKLength: 21, stochKSmooth: 3, stochDSmooth: 5, stochLevel: 80,
    indicatorTarget: "level", mode: "cross_down",
  },
  adx: {
    ...BASE, conditionKind: "adx", targetPrice: null, priceDirection: null,
    adxDiLength: 20, adxSmoothing: 10, adxLevel: 30, mode: "cross_up",
  },
  macd: {
    ...BASE, conditionKind: "macd", targetPrice: null, priceDirection: null,
    macdFast: 8, macdSlow: 21, macdSignal: 5, indicatorTarget: "zero", mode: "cross_up",
  },
};

const KINDS = Object.keys(ALERTS) as ConditionKind[];

// ── Loading ────────────────────────────────────────────────────────────────

test("the editor loads each family's own persisted values", () => {
  const price = alertEditForm(ALERTS.price);
  assert.equal(price.targetPrice, "64250.5");
  assert.equal(price.priceDirection, "cross_up");

  const ma = alertEditForm(ALERTS.ma);
  assert.equal(ma.maType, "ema");
  assert.equal(ma.maLength, 200);
  assert.equal(ma.mode, "near_above");
  assert.deepEqual([ma.nearMinPct, ma.nearMaxPct], [0.3, 0.9]);

  const cross = alertEditForm(ALERTS.ma_vs_ma);
  assert.deepEqual(
    [cross.maType, cross.maLength, cross.ma2Type, cross.ma2Length],
    ["ema", 50, "sma", 200]
  );

  const sr = alertEditForm(ALERTS.sr_zone);
  assert.equal(sr.srSide, "support");
  assert.equal(sr.pivotLength, 7);
  assert.equal(sr.invalidation, "wick");
  assert.equal(sr.filterRsi, true);
  assert.deepEqual([sr.filterRsiLength, sr.filterRsiLevel, sr.filterRsiSide], [21, 55, "above"]);
  assert.equal(sr.filterMa, false, "an absent gate must not load as enabled");

  const pivot = alertEditForm(ALERTS.pivot_level);
  assert.deepEqual([pivot.pivotType, pivot.levelName, pivot.anchor], ["Camarilla", "R3", "4h"]);

  const rsi = alertEditForm(ALERTS.rsi);
  assert.deepEqual([rsi.rsiLength, rsi.rsiTarget, rsi.rsiLevel], [14, "level", 70]);

  const macd = alertEditForm(ALERTS.macd);
  assert.deepEqual(
    [macd.macdFast, macd.macdSlow, macd.macdSignal, macd.macdTarget], [8, 21, 5, "zero"]
  );
});

test("common fields load on every family", () => {
  for (const kind of KINDS) {
    const form = alertEditForm(ALERTS[kind]);
    assert.equal(form.symbol, "BTCUSDT", kind);
    assert.equal(form.timeframe, "1h", kind);
    assert.equal(form.frequency, "once_per_bar_close", kind);
    assert.equal(form.cooldownMin, 60, kind);
    assert.equal(form.enabled, true, kind);
    assert.equal(form.note, "", kind);
  }
});

// ── Saving ─────────────────────────────────────────────────────────────────

test("an untouched form sends no change at all", () => {
  for (const kind of KINDS) {
    const alert = ALERTS[kind];
    const body = alertEditRequest(alert, alertEditForm(alert));
    assert.equal(
      hasAlertChanges(body), false,
      `${kind} would rewrite itself on an unmodified save: ${JSON.stringify(body)}`
    );
    assert.equal(body.conditionKind, kind, "the family is always echoed back");
  }
});

test("editing one field sends only that field", () => {
  const alert = ALERTS.rsi;
  const form = { ...alertEditForm(alert), rsiLevel: 30 };
  const body = alertEditRequest(alert, form);
  assert.deepEqual(Object.keys(body).sort(), ["conditionKind", "rsiLevel"]);
  assert.equal(body.rsiLevel, 30);
});

test("each family's own fields reach the request under the server's names", () => {
  const cases: Array<[ConditionKind, Record<string, unknown>, Record<string, unknown>]> = [
    ["price", { targetPrice: "70000", priceDirection: "cross_down" },
      { targetPrice: 70000, priceDirection: "cross_down" }],
    ["ma", { maType: "sma", maLength: 50 }, { maType: "sma", maLength: 50 }],
    ["ma_vs_ma", { ma2Length: 100 }, { ma2Length: 100 }],
    ["sr_zone", { srSide: "resistance", pivotLength: 12, invalidation: "close" },
      { srSide: "resistance", pivotLength: 12, invalidation: "close" }],
    ["pivot_level", { pivotType: "Fibonacci", levelName: "S1", anchor: "1d" },
      { pivotType: "Fibonacci", levelName: "S1", anchor: "1d" }],
    ["rsi", { rsiTarget: "sma", rsiMaLength: 21 }, { target: "sma", rsiMaLength: 21 }],
    ["macd", { macdTarget: "signal", macdFast: 12 }, { target: "signal", macdFast: 12 }],
  ];
  for (const [kind, edits, expected] of cases) {
    const alert = ALERTS[kind];
    const body = alertEditRequest(alert, { ...alertEditForm(alert), ...edits }) as
      Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(body[key], value, `${kind}.${key}`);
    }
  }
});

test("common fields are editable and normalised on every family", () => {
  for (const kind of KINDS) {
    const alert = ALERTS[kind];
    const body = alertEditRequest(alert, {
      ...alertEditForm(alert),
      symbol: " ethusdt ", timeframe: "4h", frequency: "once_only",
      cooldownMin: 0, note: "watch this", enabled: false,
    });
    assert.equal(body.symbol, "ETHUSDT", kind);
    assert.equal(body.timeframe, "4h", kind);
    assert.equal(body.frequency, "once_only", kind);
    assert.equal(body.cooldownMin, 0, kind);
    assert.equal(body.note, "watch this", kind);
    assert.equal(body.enabled, false, kind);
  }
});

test("a gate is switched on, altered and removed as a whole", () => {
  const gated = ALERTS.sr_zone;
  const off = alertEditRequest(gated, { ...alertEditForm(gated), filterRsi: false });
  assert.equal(off.filterRsi, false, "removing a gate needs an explicit false");
  assert.equal(off.filterRsiLength, undefined);

  const changed = alertEditRequest(gated, { ...alertEditForm(gated), filterRsiLevel: 45 });
  assert.equal(changed.filterRsi, true);
  // Every part of the gate is sent, so a half-written gate can never be stored.
  assert.deepEqual(
    [changed.filterRsiLength, changed.filterRsiLevel, changed.filterRsiSide], [21, 45, "above"]
  );

  const added = alertEditRequest(ALERTS.pivot_level, {
    ...alertEditForm(ALERTS.pivot_level), filterMa: true,
  });
  assert.equal(added.filterMa, true);
  assert.equal(typeof added.filterMaLength, "number");
  assert.equal(added.filterRsi, undefined, "an untouched gate is not sent");
});

test("the family is never sent as a change, so an edit cannot convert an alert", () => {
  for (const kind of KINDS) {
    const alert = ALERTS[kind];
    const body = alertEditRequest(alert, { ...alertEditForm(alert), enabled: false });
    assert.equal(body.conditionKind, alert.conditionKind, kind);
  }
});

test("another family's fields are never sent", () => {
  const body = alertEditRequest(ALERTS.macd, {
    ...alertEditForm(ALERTS.macd), rsiLevel: 40, targetPrice: "5", srSide: "support",
  }) as Record<string, unknown>;
  for (const key of ["rsiLevel", "targetPrice", "srSide", "pivotType", "maLength"]) {
    assert.equal(body[key], undefined, `${key} leaked into a MACD edit`);
  }
});

// ── Validation ─────────────────────────────────────────────────────────────

test("obvious mistakes are named before the request is made", () => {
  const cases: Array<[ConditionKind, Record<string, unknown>, RegExp]> = [
    ["price", { symbol: "BTC/USDT" }, /2–24 letters/],
    ["price", { targetPrice: "0" }, /above zero/],
    ["price", { targetPrice: "abc" }, /above zero/],
    ["price", { cooldownMin: -1 }, /whole number of minutes/],
    ["ma", { maLength: 0 }, /1 to 1000/],
    ["ma", { nearMinPct: 1, nearMaxPct: 0.5 }, /far edge/],
    ["ma_vs_ma", { ma2Type: "ema", ma2Length: 50 }, /must differ/],
    ["sr_zone", { pivotLength: 1 }, /2 to 100/],
    ["sr_zone", { filterRsiLevel: 150 }, /between 0 and 100/],
    ["pivot_level", { pivotType: "Fibonacci", levelName: "R4" }, /do not define R4/],
    ["rsi", { rsiLevel: 150 }, /between 0 and 100/],
    ["rsi", { rsiTarget: "sma", rsiMaLength: 0 }, /1 to 1000/],
    ["macd", { macdFast: 30 }, /below slow length/],
  ];
  for (const [kind, edits, error] of cases) {
    const form = { ...alertEditForm(ALERTS[kind]), ...edits };
    const problem = validateAlertForm(kind, form);
    assert.ok(problem, `${kind} ${JSON.stringify(edits)} was accepted`);
    assert.match(problem, error, `${kind} ${JSON.stringify(edits)}`);
  }
});

test("every family's own persisted state validates as loaded", () => {
  for (const kind of KINDS) {
    assert.equal(validateAlertForm(kind, alertEditForm(ALERTS[kind])), null, kind);
  }
});

test("a band is validated only where it is offered", () => {
  // A cross alert never reads the band, so a stale band must not block a save.
  const cross = { ...alertEditForm(ALERTS.ma), mode: "cross_up" as const, nearMinPct: 5, nearMaxPct: 1 };
  assert.equal(validateAlertForm("ma", cross), null);
  assert.equal(usesBand("ma", "cross_up"), false);
  assert.equal(usesBand("ma", "near_above"), true);
  assert.equal(usesBand("rsi", "near_above"), false);
});

// ── Field vocabulary ───────────────────────────────────────────────────────

test("only the modes a family can actually be evaluated with are offered", () => {
  for (const kind of ["rsi", "macd", "ma_vs_ma"] as ConditionKind[]) {
    assert.deepEqual(modesFor(kind), ["cross_up", "cross_down"], kind);
  }
  assert.ok(modesFor("ma").includes("touch"));
  assert.ok(modesFor("sr_zone").includes("near_below"));
});

/*
 * Gates used to be offered on the two level families only. They are now offered
 * everywhere, which is a deliberate widening rather than a slip: "MACD crosses
 * up, but only while price is above the Supertrend" is the same shape of
 * request as the level version, and the old restriction was an artefact of the
 * order the families were built in.
 *
 * The property that matters is that the OFFER and the SAVE agree. A dialog that
 * shows a gate the request builder drops is a filter the user configures, sees
 * confirmed, and which silently never applies.
 */
test("every family offers gates, and every family actually saves them", () => {
  for (const kind of KINDS) {
    assert.equal(usesGates(kind), true, kind);

    const alert = ALERTS[kind];
    const form = alertEditForm(alert);
    const body = alertEditRequest(alert, {
      ...form,
      filterSt: true,
      filterStPeriod: 14,
      filterStMultiplier: 2,
      filterStAtrMethod: "sma",
      filterStSide: "below",
    });
    assert.equal(body.filterSt, true, `${kind} dropped the gate it offered`);
    assert.equal(body.filterStPeriod, 14, kind);
    assert.equal(body.filterStSide, "below", kind);
  }
});

test("switching a gate off sends the explicit false that clears it", () => {
  // Omitting the key would leave the row's own gate in place, because the
  // server merges an edit onto what it already holds — so the dialog would show
  // the gate unchecked while the alert kept applying it.
  const gated: MaAlert = {
    ...ALERTS.rsi,
    filterStPeriod: 10, filterStMultiplier: 3,
    filterStAtrMethod: "rma", filterStSide: "above",
  };
  const form = alertEditForm(gated);
  assert.equal(form.filterSt, true, "a persisted gate must load as enabled");
  const body = alertEditRequest(gated, { ...form, filterSt: false });
  assert.equal(body.filterSt, false);
});

test("a Supertrend edit sends its own inputs and nothing else", () => {
  const alert = ALERTS.supertrend;
  const form = alertEditForm(alert);
  assert.equal(form.stPeriod, 14);
  assert.equal(form.stMultiplier, 2.5);
  assert.equal(form.stAtrMethod, "sma");

  assert.equal(hasAlertChanges(alertEditRequest(alert, form)), false,
    "an untouched Supertrend form must save nothing");

  const body = alertEditRequest(alert, { ...form, stMultiplier: 3 });
  assert.equal(body.stMultiplier, 3);
  assert.equal(body.stPeriod, undefined, "an unchanged input must not be resent");
});

test("Fibonacci pivots do not offer levels they never compute", () => {
  assert.equal(pivotLevelNames("Fibonacci").includes("R4"), false);
  assert.ok(pivotLevelNames("Traditional").includes("R4"));
});

test("every family has a label for the editor title", () => {
  for (const kind of KINDS) {
    assert.ok(ALERT_FAMILY_LABELS[kind], kind);
  }
});

test("an edit that leaves the current filter is detectable", () => {
  const active = (a: MaAlert): boolean => a.enabled && a.completedAt === null;
  assert.equal(leavesFilteredView(ALERTS.rsi, { ...ALERTS.rsi, enabled: false }, active), true);
  assert.equal(leavesFilteredView(ALERTS.rsi, ALERTS.rsi, active), false);
});

// ── Both surfaces reach the same editor ────────────────────────────────────

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

test("the Alerts page and the chart rail both open the shared editor", () => {
  // The chart's dialogs were extracted out of its page; the editor it reaches
  // is still the one shared with the Alerts page, which is the invariant.
  for (const file of ["app/alerts/page.tsx", "components/tv/ChartDialogs.tsx"]) {
    const source = read(file);
    assert.match(source, /<AlertEditor\b/, `${file} does not mount the alert editor`);
    assert.match(source, /from "@\/components\/tv\/AlertEditor"/, file);
  }
  // And the chart page still routes an armed alert into that surface.
  assert.match(read("app/chart/page.tsx"), /editingAlert=\{editingAlert\}/);
});

test("clicking an armed alert in the rail opens THAT alert", () => {
  const chart = read("app/chart/page.tsx");
  assert.match(
    chart, /onOpenAlert=\{setEditingAlert\}/,
    "the rail must hand the alert to the editor, not re-open a blank family dialog"
  );
});

test("the Alerts page offers an edit path on every row", () => {
  const page = read("app/alerts/page.tsx");
  assert.match(page, /aria-label=\{`Edit alert —/, "the row itself is not an edit target");
  assert.match(page, /aria-label=\{`Edit \$\{a\.symbol\}/, "no discrete Edit control on the row");
});

test("the editor refreshes from the server rather than trusting the form", () => {
  const editor = read("components/tv/AlertEditor.tsx");
  assert.match(editor, /api\.updateMaAlert\(alert\.id, patch\)/);
  assert.match(editor, /onSaved\(updated,/, "the row shown after a save must be the server's");
  // A failed save must not close the dialog or report success.
  assert.match(editor, /catch \(e\) \{\s*\/\/[\s\S]*?setErr\(\(e as Error\)\.message\)/);
});
