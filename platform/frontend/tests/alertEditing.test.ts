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
import { ALERT_HISTORY_BARS, type ConditionKind, type MaAlert } from "../lib/api";
import {
  ALERT_FAMILY_LABELS, alertEditForm, alertEditRequest, editsInPriceDialog, hasAlertChanges,
  leavesFilteredView, modesFor, pivotLevelNames, usesBand, usesGates,
  validateAlertForm, warmupBars, type AlertEditForm,
} from "../lib/alertEditing";

const ROOT = path.join(__dirname, "..");

const BASE: MaAlert = {
  id: "a1", symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
  filters: null,
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
  // A legacy single-gate row loads as a one-entry LIST, and an absent gate
  // does not load at all.
  assert.deepEqual(sr.gates, [{ kind: "rsi", length: 21, level: 55, side: "above" }]);

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

test("the gate list is sent whole when it changed, and not at all when it did not", () => {
  const gated = ALERTS.sr_zone;
  const form = alertEditForm(gated);

  // Untouched: nothing. A legacy row's own gate must not be restated as a list
  // on a save that changed something else.
  assert.equal(alertEditRequest(gated, { ...form, cooldownMin: 5 }).filters, undefined,
    "an untouched gate list was sent");

  // Removing the last gate is an explicit [] — omitting the key would leave
  // the row's own gate applying while the editor showed none.
  assert.deepEqual(alertEditRequest(gated, { ...form, gates: [] }).filters, []);

  // Changing one gate sends the whole list, every part of every gate, so a
  // half-written gate can never be stored.
  const changed = alertEditRequest(gated, {
    ...form, gates: [{ kind: "rsi", length: 21, level: 45, side: "above" }],
  });
  assert.deepEqual(changed.filters, [{ kind: "rsi", length: 21, level: 45, side: "above" }]);

  // And the list can hold what the three checkboxes never could: two gates of
  // one kind, one on its own timeframe.
  const added = alertEditRequest(ALERTS.pivot_level, {
    ...alertEditForm(ALERTS.pivot_level),
    gates: [
      { kind: "rsi", length: 14, level: 50, side: "above" },
      { kind: "rsi", length: 14, level: 50, side: "above", timeframe: "4h" },
    ],
  });
  assert.equal(added.filters?.length, 2);
  assert.equal(added.filters?.[1]?.timeframe, "4h");
  assert.equal(added.filterRsi, undefined, "the legacy single-gate flags are not sent");
});

test("a row that carries the list loads its whole list, not the legacy columns", () => {
  // The server describes a list row BY the list and ignores the legacy
  // columns; the old three-checkbox form read the columns, so a list-gated
  // alert opened showing no gates at all.
  const listed: MaAlert = {
    ...ALERTS.rsi,
    filters: [
      { kind: "macd", side: "above", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal" },
      { kind: "ma", side: "below", type: "sma", length: 100, timeframe: "1d" },
    ],
  };
  assert.deepEqual(alertEditForm(listed).gates, listed.filters);
  assert.equal(hasAlertChanges(alertEditRequest(listed, alertEditForm(listed))), false,
    "an untouched list-gated form must save nothing");
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
    ["sr_zone", { gates: [{ kind: "rsi", length: 21, level: 150, side: "above" }] },
      /between 0 and 100/],
    // Every gate in the list is checked, not only the first.
    ["rsi", { gates: [
      { kind: "rsi", length: 14, level: 50, side: "above" },
      { kind: "ma", type: "ema", length: 0, side: "above" },
    ] }, /moving-average filter length/],
    ["macd", { gates: [{
      kind: "macd", side: "above", fastLength: 30, slowLength: 26, signalLength: 9, target: "signal",
    }] }, /fast length must be below its slow/],
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
  // Stochastic and ADX are here because they were NOT: the dialog offered them
  // touch and both approach bands, the server refuses all three outright, and
  // the save came back 400 on a control the dialog had presented as ordinary.
  for (const kind of ["rsi", "macd", "ma_vs_ma", "stochastic", "adx"] as ConditionKind[]) {
    assert.deepEqual(modesFor(kind), ["cross_up", "cross_down"], kind);
  }
  assert.ok(modesFor("ma").includes("touch"));
  assert.ok(modesFor("sr_zone").includes("near_below"));
  // Bollinger compares price against a band, so it keeps the full set.
  assert.ok(modesFor("bollinger").includes("touch"));
  assert.equal(usesBand("bollinger", "near_above"), true);
  assert.equal(usesBand("bollinger", "cross_up"), false);
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
    const gate = {
      kind: "supertrend", period: 14, multiplier: 2, atrMethod: "sma", side: "below",
    } as const;
    const body = alertEditRequest(alert, { ...form, gates: [...form.gates, gate] });
    assert.ok(body.filters, `${kind} dropped the gate it offered`);
    assert.deepEqual(body.filters.at(-1), gate, kind);
  }
});

test("switching the last gate off sends the explicit empty list that clears it", () => {
  // Omitting the key would leave the row's own gate in place, because the
  // server merges an edit onto what it already holds — so the dialog would show
  // no gate while the alert kept applying it.
  const gated: MaAlert = {
    ...ALERTS.rsi,
    filterStPeriod: 10, filterStMultiplier: 3,
    filterStAtrMethod: "rma", filterStSide: "above",
  };
  const form = alertEditForm(gated);
  assert.equal(form.gates.length, 1, "a persisted gate must load");
  const body = alertEditRequest(gated, { ...form, gates: [] });
  assert.deepEqual(body.filters, []);
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

test("a price alert is edited in the dialog that armed it; every other family in the shared editor", () => {
  // C14: the price family has a create dialog that can represent all of it,
  // so arming and editing are one product. The rest keep `AlertEditor`, whose
  // per-family rows are the only editor they have.
  for (const kind of Object.keys(ALERTS) as ConditionKind[]) {
    assert.equal(editsInPriceDialog(ALERTS[kind]), kind === "price", kind);
  }
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
  /*
   * A failed save must not close the dialog or report success.
   *
   * REV-UX-01 changed the spelling here: the catch used to be
   * `setErr((e as Error).message)`, which put the backend's own words into the
   * dialog as copy, and is now `setErr(describeAction(e, …))`. What this
   * assertion is ABOUT is that the catch reports rather than closing — so it
   * is pinned on `setErr` being called and `onSaved`/`onClose` not being, not
   * on how the message is built.
   */
  const saveCatch = /catch \(e\) \{[^}]*setErr\([^)]*\)/.exec(editor)?.[0] ?? "";
  assert.ok(saveCatch.length > 0, "a failed save is swallowed — nothing is reported");
  assert.doesNotMatch(saveCatch, /onSaved|onClose/,
    "a failed save must not close the dialog or report success");
  assert.doesNotMatch(editor, /setErr\(\(e as Error\)\.message\)/,
    "the backend's own words are not the dialog's copy — see tests/rawCauseCopy.test.ts");
});

// ── every family can actually be edited ────────────────────────────────────

/**
 * The defect this covers was silent, which is the worst kind of save bug.
 *
 * `alertEditRequest`'s switch had no arm for `bollinger`, `stochastic` or
 * `adx`. Every field the dialog showed for those families — including the
 * Condition dropdown it rendered for all of them — was read into the form,
 * changed by the user, and then dropped: `hasAlertChanges` reported not-dirty,
 * and Save closed the dialog having written nothing. No error, no 400, no
 * feedback of any kind.
 *
 * Keyed exhaustively by `ConditionKind` so a family added to the union without
 * an arm here fails to compile rather than shipping the same silence again.
 */
const EDITABLE_FIELDS: Record<ConditionKind, (keyof AlertEditForm)[]> = {
  price: ["targetPrice", "priceDirection"],
  ma: ["maType", "maLength", "mode"],
  ma_vs_ma: ["maType", "maLength", "ma2Type", "ma2Length", "mode"],
  sr_zone: ["srSide", "pivotLength", "invalidation", "mode"],
  pivot_level: ["pivotType", "levelName", "anchor", "mode"],
  rsi: ["rsiLength", "rsiTarget", "rsiLevel", "rsiMaLength", "mode"],
  macd: ["macdFast", "macdSlow", "macdSignal", "macdTarget", "mode"],
  supertrend: ["stPeriod", "stMultiplier", "stAtrMethod", "mode"],
  bollinger: ["bbLength", "bbMult", "bbBand", "bbMaType", "mode"],
  stochastic: ["stochKLength", "stochKSmooth", "stochDSmooth", "stochTarget", "stochLevel", "mode"],
  adx: ["adxDiLength", "adxSmoothing", "adxLevel", "mode"],
};

/** A different legal value for one field, so the change is real. */
const OTHER: Partial<Record<keyof AlertEditForm, unknown>> = {
  targetPrice: "12345", priceDirection: "cross_up",
  maType: "sma", maLength: 55, ma2Type: "ema", ma2Length: 89,
  mode: "cross_down",
  srSide: "resistance", pivotLength: 9, invalidation: "wick",
  pivotType: "Camarilla", levelName: "R1", anchor: "1w",
  rsiLength: 21, rsiTarget: "sma", rsiLevel: 65, rsiMaLength: 9,
  macdFast: 8, macdSlow: 21, macdSignal: 5, macdTarget: "zero",
  stPeriod: 7, stMultiplier: 2.5, stAtrMethod: "sma",
  bbLength: 34, bbMult: 2.5, bbBand: "lower", bbMaType: "ema",
  stochKLength: 21, stochKSmooth: 3, stochDSmooth: 5, stochTarget: "level", stochLevel: 80,
  adxDiLength: 21, adxSmoothing: 21, adxLevel: 30,
};

const FAMILY_ROW: Record<ConditionKind, Partial<MaAlert>> = {
  price: { targetPrice: 100, priceDirection: "either" },
  ma: { maType: "ema", maLength: 200, mode: "cross_up" },
  ma_vs_ma: { maType: "ema", maLength: 50, ma2Type: "sma", ma2Length: 200, mode: "cross_up" },
  sr_zone: { srSide: "support", srPivotLength: 5, srInvalidation: "close", mode: "near_above" },
  pivot_level: {
    pivotType: "Fibonacci", pivotLevelName: "S1", pivotAnchor: "1d", mode: "near_above",
  },
  rsi: { rsiLength: 50, rsiLevel: 50, rsiMaLength: 14, indicatorTarget: "level", mode: "cross_up" },
  macd: { macdFast: 12, macdSlow: 26, macdSignal: 9, indicatorTarget: "signal", mode: "cross_up" },
  supertrend: { stPeriod: 10, stMultiplier: 3, stAtrMethod: "rma", mode: "cross_up" },
  bollinger: { bbLength: 20, bbMult: 2, bbBand: "upper", bbMaType: "sma", mode: "touch" },
  stochastic: {
    stochKLength: 14, stochKSmooth: 1, stochDSmooth: 3, stochLevel: 20,
    indicatorTarget: "signal", mode: "cross_up",
  },
  adx: { adxDiLength: 14, adxSmoothing: 14, adxLevel: 25, mode: "cross_up" },
};

test("changing any field of any family produces a patch the server would act on", () => {
  for (const [kind, fields] of Object.entries(EDITABLE_FIELDS) as
    [ConditionKind, (keyof AlertEditForm)[]][]) {
    const row: MaAlert = { ...BASE, conditionKind: kind, ...FAMILY_ROW[kind] };
    const loaded = alertEditForm(row);

    // Loading and saving without touching anything sends nothing.
    assert.equal(hasAlertChanges(alertEditRequest(row, loaded)), false,
      `${kind} reports a change it did not make`);

    for (const field of fields) {
      const next = { ...loaded, [field]: OTHER[field] };
      assert.notDeepEqual(next[field], loaded[field],
        `${kind}.${String(field)} test value is not actually different`);
      const patch = alertEditRequest(row, next);
      assert.equal(hasAlertChanges(patch), true,
        `${kind}: editing ${String(field)} is silently discarded`);
    }
  }
});

test("a family's own fields never leak into another family's patch", () => {
  // The form carries defaults for every family's columns; only the edited
  // family's may be sent, or saving an ADX alert would rewrite its unrelated
  // Bollinger columns to defaults it never chose.
  const row: MaAlert = { ...BASE, conditionKind: "adx", ...FAMILY_ROW.adx };
  const patch = alertEditRequest(row, { ...alertEditForm(row), adxLevel: 30, bbLength: 99 });
  assert.equal(patch.adxLevel, 30);
  assert.equal("bbLength" in patch, false);
  assert.equal("stochKLength" in patch, false);
});

// ── the bound a per-field check cannot see ─────────────────────────────────

test("lengths that together outrun the runner's history are refused", () => {
  const adx: MaAlert = { ...BASE, conditionKind: "adx", ...FAMILY_ROW.adx };
  const form = { ...alertEditForm(adx), adxDiLength: 700, adxSmoothing: 700 };
  // Each length passes 1..1000 on its own; together they need 1400 bars.
  assert.equal(warmupBars("adx", form), 1400);
  const message = validateAlertForm("adx", form);
  assert.match(String(message), /1400 bars/);
  assert.match(String(message), /1200/);
  // And a configuration that fits is accepted.
  assert.equal(validateAlertForm("adx", { ...form, adxDiLength: 14, adxSmoothing: 14 }), null);

  const stoch: MaAlert = { ...BASE, conditionKind: "stochastic", ...FAMILY_ROW.stochastic };
  assert.match(
    String(validateAlertForm("stochastic", {
      ...alertEditForm(stoch), stochKLength: 600, stochKSmooth: 600, stochDSmooth: 600,
    })), /1800 bars/);

  const macd: MaAlert = { ...BASE, conditionKind: "macd", ...FAMILY_ROW.macd };
  assert.match(
    String(validateAlertForm("macd", {
      ...alertEditForm(macd), macdFast: 400, macdSlow: 900, macdSignal: 900,
    })), /1800 bars/);
});

test("the history bound is the server's own number", () => {
  const backend = fs.readFileSync(
    path.join(ROOT, "..", "backend", "src", "types", "maAlerts.ts"), "utf8");
  const match = /export const ALERT_HISTORY_BARS = (\d+);/.exec(backend);
  assert.ok(match, "the server no longer declares ALERT_HISTORY_BARS");
  assert.equal(Number(match![1]), ALERT_HISTORY_BARS,
    "the dialog would name a limit the runner does not have");
});

test("ALERTS — every create dialog can arm, and every control reaches the request", () => {
  /*
   * The edit dialog has always had "Armed"; none of the four create dialogs
   * did, so every alert was born live. Setting one up in advance meant
   * creating it armed and then finding it in the panel to pause it, with
   * whatever it fired in between already sent.
   *
   * This asserts the two halves that make it real rather than decorative: the
   * field is present, and its value reaches `createMaAlert`. A checkbox that
   * does not reach the request is the defect this campaign keeps finding.
   */
  const dialogs = [
    "components/tv/PriceAlertModal.tsx",
    "components/tv/LevelAlertModal.tsx",
    "components/tv/MaAlertModal.tsx",
    "components/tv/IndicatorAlertModal.tsx",
  ];
  for (const file of dialogs) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(src, /<AlertArmedField value=\{armed\} onChange=\{setArmed\} \/>/, `${file}: no armed field`);
    assert.match(src, /enabled: armed,/, `${file}: the armed state never reaches the request`);
  }

  // The server side of that, so the control is over something real.
  const route = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "src", "api", "routes", "maAlerts.ts"), "utf8");
  assert.match(route, /enabled: b\.enabled === undefined \? true : Boolean\(b\.enabled\)/,
    "the create route must read `enabled` from the body, or the checkbox is a lie");

  // Price alerts were the one family with no cooldown at all — and the family
  // most likely to sit on a level that price chops through.
  const price = fs.readFileSync(path.join(__dirname, "..", "components/tv/PriceAlertModal.tsx"), "utf8");
  assert.match(price, /Cooldown/, "the price dialog offers a cooldown");
  assert.match(price, /frequency, cooldownMin,/, "and sends it");
});

test("ALERTS — NO CREATE DIALOG CAN SILENTLY RE-ARM A PAUSED ALERT", () => {
  /*
   * TVP8. `api.createMaAlert` is an UPSERT: the repository's
   * `ON CONFLICT <condition key> DO UPDATE SET … enabled = EXCLUDED.enabled`
   * means "creating" an alert whose condition already exists overwrites that
   * row, `enabled` included.
   *
   * Two of the four create dialogs did `useState(true)` and never looked at
   * what was already there. Opening one on a condition the user had
   * deliberately PAUSED showed "Armed ☑" and pressing Save re-armed it —
   * silently, with no edit and no warning. `PriceAlertModal` and
   * `MaAlertModal` had been fixed for exactly this; `LevelAlertModal` and
   * `IndicatorAlertModal` had not.
   *
   * The test that was supposed to cover the Armed field could not see this: it
   * asserts the field exists and that `enabled: armed` reaches the request,
   * both of which were true the whole time. So this asks the other question —
   * does the dialog READ the state it is about to overwrite?
   */
  const dialogs = [
    "components/tv/PriceAlertModal.tsx",
    "components/tv/LevelAlertModal.tsx",
    "components/tv/MaAlertModal.tsx",
    "components/tv/IndicatorAlertModal.tsx",
  ];
  /*
   * Comments stripped first, and that is not fussiness: the first version of
   * this matched `setArmed(match.enabled)` inside the very comment this fix
   * added to explain itself, so deleting the real line left it green. A rule
   * that its own documentation can satisfy is not a rule.
   */
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const file of dialogs) {
    const src = code(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    // Every one of them takes the alerts already on this symbol …
    assert.match(src, /\bexisting\b/,
      `${file}: cannot know what it would overwrite — it is not given the existing alerts`);
    // … and arms from the matched row rather than from a literal.
    // (`twin` is PriceAlertModal's name for the matched row since C14 gave it
    // an editing mode, where `match` can also be the alert being edited.)
    assert.match(src, /setArmed\((?:match\.enabled|twin\.enabled|matchedArmed)\)/,
      `${file}: arms from a literal, so an untouched Save can re-arm a paused alert`);
  }

  // And the upsert this is about is real, not assumed.
  const repo = fs.readFileSync(
    path.join(__dirname, "..", "..", "backend", "src", "repositories", "maAlerts.ts"), "utf8");
  assert.match(repo, /ON CONFLICT \$\{CONFLICT_TARGET\[kind\]\} DO UPDATE SET/);
  assert.match(repo, /enabled\s*=\s*EXCLUDED\.enabled/,
    "if the upsert stopped writing `enabled`, this whole rule would be moot");
});
