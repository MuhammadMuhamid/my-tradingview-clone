/**
 * Bollinger, Stochastic and ADX alerts.
 *
 * ── What these have to prove ───────────────────────────────────────────────
 *
 * Not that the maths is right — that is `ta/core.ts`'s, checked in
 * `taParity.test.ts`. What matters here is that three new families joined an
 * existing engine without changing what any of the others do, and without
 * acquiring a way to be armed and unfireable:
 *
 *   a cross needs a known previous side, so the first evaluation seeds and
 *     stays quiet — arming "notify me when ADX rises through 25" while ADX is
 *     already at 30 must not fire immediately;
 *   an unwarmed indicator leaves the stored side alone rather than letting a
 *     NaN comparison manufacture a cross on the next bar;
 *   gates apply, because they apply to every family;
 *   the request → condition → columns → row round trip is lossless;
 *   the descriptions and notifications say what the alert is about, on the
 *     right scale — a Bollinger alert reports a price, an oscillator reports
 *     its own reading rather than a percentage of price.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  conditionFromRow, describeCondition, evaluateCondition, requiredSeries,
  validateCondition, type AlertCondition, type Sample, type Side,
} from "../src/alerts/alertConditions";
import {
  planAlert, stateAfterPlan, type AlertSpec, type FeedSample,
} from "../src/alerts/alertPlan";
import { initialFireState } from "../src/alerts/alertFrequency";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { formatAlertPush } from "../src/alerts/alertMessage";
import { CONDITION_KINDS } from "../src/types/maAlerts";

const sample = (over: Partial<Sample> = {}): Sample =>
  ({ high: 101, low: 99, close: 100, ...over });

const read = (kind: Parameters<typeof readCondition>[0], body: Record<string, unknown>): AlertCondition => {
  const out = readCondition(kind, body);
  assert.ok(!("error" in out), JSON.stringify(out));
  return out.condition;
};

// ── the families exist and are complete ────────────────────────────────────

test("the three families are registered kinds and need no chart MA computed", () => {
  for (const kind of ["bollinger", "stochastic", "adx"] as const) {
    assert.ok((CONDITION_KINDS as readonly string[]).includes(kind));
  }
  assert.deepEqual(requiredSeries(read("bollinger", {})), [],
    "a Bollinger band is resolved by the runner, not from a chart MA series");
  assert.deepEqual(requiredSeries(read("stochastic", {})), []);
  assert.deepEqual(requiredSeries(read("adx", {})), []);
});

test("defaults are the studies' own, so an alert watches the line on the chart", () => {
  const bb = read("bollinger", {});
  assert.equal(bb.kind, "bollinger");
  if (bb.kind !== "bollinger") return;
  assert.equal(bb.length, 20);
  assert.equal(bb.mult, 2);
  assert.equal(bb.maType, "sma");
  assert.equal(bb.band, "upper");

  const stoch = read("stochastic", {});
  if (stoch.kind !== "stochastic") return;
  assert.equal(stoch.kLength, 14);
  assert.equal(stoch.kSmooth, 1);
  assert.equal(stoch.dSmooth, 3);

  const adx = read("adx", {});
  if (adx.kind !== "adx") return;
  assert.equal(adx.diLength, 14);
  assert.equal(adx.smoothing, 14);
  assert.equal(adx.level, 25, "the conventional trend-present line, and the one the study draws");
});

// ── validation refuses what cannot fire ────────────────────────────────────

test("an alert that could never fire is refused rather than stored", () => {
  const rejects = (kind: Parameters<typeof readCondition>[0], body: Record<string, unknown>): string => {
    const out = readCondition(kind, body);
    assert.ok("error" in out, `${kind} ${JSON.stringify(body)} was accepted`);
    return out.error;
  };
  // A window of one has no deviation, so both bands sit on the basis and every
  // "touch" is a touch.
  assert.match(rejects("bollinger", { bbLength: 1 }), /bbLength/);
  assert.match(rejects("bollinger", { bbMult: 0 }), /bbMult/);
  assert.match(rejects("bollinger", { bbBand: "middle" }), /bbBand/);
  assert.match(rejects("bollinger", { bbMaType: "hma" }), /bbMaType/);

  // A bounded oscillator can never cross a level outside its own range.
  assert.equal(validateCondition(read("stochastic", { target: "level", stochLevel: 20 })), null);
  assert.match(
    validateCondition(read("stochastic", { target: "level", stochLevel: 120 })) ?? "",
    /between 0 and 100/);
  assert.match(validateCondition(read("adx", { adxLevel: 0 })) ?? "", /between 0 and 100/);
  assert.match(validateCondition(read("adx", { adxLevel: 100 })) ?? "", /between 0 and 100/);

  // The oscillator families watch a crossing, which has exactly two directions.
  assert.match(rejects("stochastic", { mode: "touch" }), /cross_up or cross_down/);
  assert.match(rejects("adx", { mode: "near_above" }), /cross_up or cross_down/);
  // A Bollinger band is a price line, so it takes the full level vocabulary.
  assert.equal(read("bollinger", { mode: "touch" }).kind, "bollinger");
  assert.equal(read("bollinger", { mode: "near_above" }).kind, "bollinger");
});

// ── evaluation ─────────────────────────────────────────────────────────────

test("a Bollinger alert compares price against the band the runner resolved", () => {
  const touch = read("bollinger", { mode: "touch" });
  // The bar's range contains the band.
  const hit = evaluateCondition(touch, sample({ high: 105, low: 99, refValue: 102 }), null);
  assert.equal(hit.triggered, true);
  assert.equal(hit.reference, 102);
  // It does not.
  assert.equal(
    evaluateCondition(touch, sample({ high: 101, low: 99, refValue: 110 }), null).triggered, false);
});

test("an unwarmed band leaves the stored side alone rather than inventing a cross", () => {
  const cross = read("bollinger", { mode: "cross_up" });
  const unwarmed = evaluateCondition(cross, sample({ refValue: undefined }), "below");
  assert.equal(unwarmed.triggered, false);
  assert.equal(unwarmed.side, "below", "the stored side must survive an unwarmed bar");
  assert.ok(Number.isNaN(unwarmed.reference));
});

test("the first evaluation of a cross seeds its side and stays quiet", () => {
  // Arming "ADX rises through 25" while ADX is already 30 must not fire.
  const adx = read("adx", { mode: "cross_up", adxLevel: 25 });
  const first = evaluateCondition(adx, sample({ indicatorValue: 30, indicatorReference: 25 }), null);
  assert.equal(first.triggered, false, "no previous side is known, so nothing has crossed");
  assert.equal(first.side, "above");

  // And it fires on the bar that genuinely crosses.
  const below = evaluateCondition(adx, sample({ indicatorValue: 20, indicatorReference: 25 }), null);
  assert.equal(below.side, "below");
  const crossed = evaluateCondition(
    adx, sample({ indicatorValue: 26, indicatorReference: 25 }), below.side);
  assert.equal(crossed.triggered, true);
});

test("an oscillator's distance is in its own points, never a percentage of price", () => {
  const stoch = read("stochastic", { mode: "cross_down", target: "signal" });
  const out = evaluateCondition(
    stoch, sample({ close: 64_000, indicatorValue: 78, indicatorReference: 82 }), "above");
  assert.equal(out.triggered, true);
  assert.equal(out.distancePct, -4,
    "78 against 82 is four stochastic points; expressing that as a percentage " +
    "of 82 would read as a market move to anyone glancing at the notification");
});

test("gates apply to the new families, because they apply to every family", () => {
  const gated = read("adx", {
    mode: "cross_up", adxLevel: 25,
    filterRsi: true, filterRsiLength: 14, filterRsiLevel: 50, filterRsiSide: "above",
  });
  const below: Side = "below";
  const open = evaluateCondition(
    gated, sample({ indicatorValue: 26, indicatorReference: 25, filterRsiValue: 60 }), below);
  assert.equal(open.triggered, true, "the gate is open, so the event notifies");
  const shut = evaluateCondition(
    gated, sample({ indicatorValue: 26, indicatorReference: 25, filterRsiValue: 40 }), below);
  assert.equal(shut.triggered, false, "the gate is shut, so it does not");
  assert.equal(shut.side, "above", "and the side is still tracked, so the next cross is real");
});

// ── the round trip ─────────────────────────────────────────────────────────

test("request -> condition -> columns -> row -> condition is lossless", () => {
  const bodies: [Parameters<typeof readCondition>[0], Record<string, unknown>][] = [
    ["bollinger", { bbLength: 30, bbMult: 2.5, bbBand: "lower", bbMaType: "ema", mode: "near_below", nearMinPct: 0.15, nearMaxPct: 0.6 }],
    ["stochastic", { stochKLength: 21, stochKSmooth: 3, stochDSmooth: 5, target: "level", stochLevel: 80, mode: "cross_down" }],
    ["adx", { adxDiLength: 20, adxSmoothing: 10, adxLevel: 30, mode: "cross_up" }],
  ];
  for (const [kind, body] of bodies) {
    const condition = read(kind, body);
    const columns = toColumns(condition);
    const rebuilt = conditionFromRow({
      ...columns,
      nearMinPct: columns.nearMinPct, nearMaxPct: columns.nearMaxPct,
    } as Parameters<typeof conditionFromRow>[0]);
    assert.ok(rebuilt, `${kind} did not survive the column round trip`);
    assert.deepEqual(rebuilt, condition, `${kind} changed on the way through storage`);
  }
});

test("an incomplete row is refused rather than evaluated against NaN", () => {
  const base = toColumns(read("bollinger", {})) as unknown as Record<string, unknown>;
  for (const missing of ["bbLength", "bbMult", "bbBand", "bbMaType", "mode"]) {
    const row = { ...base, [missing]: null } as Parameters<typeof conditionFromRow>[0];
    assert.equal(conditionFromRow(row), null,
      `a bollinger row with no ${missing} is not evaluable and must not be built`);
  }
  const stoch = toColumns(read("stochastic", {})) as unknown as Record<string, unknown>;
  for (const missing of ["stochKLength", "stochKSmooth", "stochDSmooth", "indicatorTarget"]) {
    assert.equal(
      conditionFromRow({ ...stoch, [missing]: null } as Parameters<typeof conditionFromRow>[0]),
      null, `a stochastic row with no ${missing} must not be built`);
  }
});

// ── what the user reads ────────────────────────────────────────────────────

test("descriptions name the line, and hide default inputs as noise", () => {
  assert.equal(describeCondition(read("bollinger", { mode: "touch" })),
    "touches the upper Bollinger band");
  assert.equal(describeCondition(read("bollinger", { mode: "cross_down", bbBand: "lower" })),
    "crosses below the lower Bollinger band");
  assert.match(describeCondition(read("bollinger", { mode: "touch", bbLength: 50 })),
    /\(50, 2\)/, "a non-default input is the only thing separating two alerts in a list");
  assert.equal(describeCondition(read("bollinger", { mode: "touch", bbBand: "basis" })),
    "touches the Bollinger basis");

  assert.equal(describeCondition(read("stochastic", { mode: "cross_up" })),
    "Stochastic %K crosses above its %D");
  assert.equal(
    describeCondition(read("stochastic", { mode: "cross_up", target: "level", stochLevel: 20 })),
    "Stochastic %K crosses above 20");
  assert.match(
    describeCondition(read("stochastic", { mode: "cross_up", stochKLength: 21 })),
    /Stochastic %K 21\/1\/3/);

  assert.equal(describeCondition(read("adx", { mode: "cross_up" })),
    "ADX rises through 25");
  assert.equal(describeCondition(read("adx", { mode: "cross_down", adxLevel: 20 })),
    "ADX falls through 20");
  assert.match(describeCondition(read("adx", { mode: "cross_up", adxDiLength: 20 })),
    /ADX 20\/14/);
});

test("a notification says what happened, on the right scale", () => {
  const alert = {
    id: "a1", symbol: "BTCUSDT", timeframe: "1h",
    frequency: "once_per_bar_close" as const,
    nearMinPct: 0.2, nearMaxPct: 0.5,
  };
  const bar = { close: 64_100 };

  const band = formatAlertPush(
    alert, read("bollinger", { mode: "touch" }), bar, 64_000, 0.16, false);
  assert.match(band.title, /Bollinger upper band/);
  assert.match(band.body, /64,?100|64100/, "the last price is in the body");
  assert.match(band.body, /64,?000|64000/, "and so is where the band was");

  const stoch = formatAlertPush(
    alert, read("stochastic", { mode: "cross_down" }), bar, 82, -4, false);
  assert.match(stoch.title, /Stochastic/);
  assert.match(stoch.body, /%K 78\.00 vs %D 82\.00/,
    "an oscillator reports its own reading, not a price");
  assert.doesNotMatch(stoch.body, /64,?100/, "the market price is not the subject");

  const adx = formatAlertPush(alert, read("adx", { mode: "cross_up" }), bar, 25, 1, false);
  assert.match(adx.title, /ADX/);
  assert.match(adx.body, /strengthening/);
});

// ── the migration ──────────────────────────────────────────────────────────

test("migration 027 widens the kind check and refuses an unfireable row", () => {
  const sql = fs.readFileSync(path.join(
    __dirname, "..", "src", "db", "migrations",
    "027_bollinger_stochastic_adx_alerts.sql"), "utf8");

  // Every kind the application knows must be admitted, or the UI saves a row
  // the database refuses.
  for (const kind of CONDITION_KINDS) {
    assert.ok(sql.includes(`'${kind}'`), `${kind} is not admitted by the widened CHECK`);
  }

  // The mode branches spell out IS NOT NULL, which 025 found is load-bearing:
  // a CHECK passes when it evaluates to NULL, so a branch written without it
  // accepts exactly the row it was written to reject.
  for (const kind of ["stochastic", "adx"]) {
    assert.match(sql, new RegExp(`condition_kind = '${kind}'\\s*\\n?\\s*AND mode IS NOT NULL`),
      `${kind}'s shape branch must test mode IS NOT NULL explicitly`);
  }

  // Bounds that stop an alert being armed at something it can never reach.
  assert.match(sql, /bb_length IS NOT NULL AND bb_length >= 2/);
  assert.match(sql, /stoch_level > 0 AND stoch_level < 100/);
  assert.match(sql, /adx_level > 0 AND adx_level < 100/);

  // Additive: no column or table is dropped, and no row is rewritten.
  const statements = sql.replace(/^\s*--.*$/gm, "");
  for (const forbidden of [/DROP TABLE/i, /DROP COLUMN/i, /DELETE FROM/i, /TRUNCATE/i,
                           /UPDATE ma_alerts SET/i]) {
    assert.doesNotMatch(statements, forbidden, `${forbidden} would not be additive`);
  }
});

// ── warm-up ────────────────────────────────────────────────────────────────

/**
 * The bug this file's header promised was closed, and was not.
 *
 * An unresolved reference used to evaluate to `side: prevSide ?? "above"`, and
 * `stateAfterPlan` persists whatever side the plan reports. So an alert whose
 * indicator had not warmed up recorded "above" it had never been on, and the
 * first bar that produced a real reading below the reference looked exactly
 * like a downward cross. ADX at its defaults needs 28 bars; a newly listed
 * symbol, a backfill that came up short, or a user-chosen length long enough to
 * outrun the history window all reach it.
 *
 * Run through the real `planAlert`/`stateAfterPlan` rather than the evaluator
 * alone, because it is the PERSISTENCE of the invented side that does the
 * damage.
 */
test("an unwarmed indicator records no side, so the first real reading cannot be a cross", () => {
  for (const [kind, key] of [["stochastic", "stochastic"], ["adx", "adx"]] as const) {
    const condition = read(kind, { mode: "cross_down" });
    const spec: AlertSpec = {
      id: "a1", symbol: "BTCUSDT", timeframe: "1h", enabled: true,
      condition, frequency: "once_per_bar_close", lastSide: null,
      fireState: initialFireState(0), lastBarTime: null,
    };
    const feed = (resolved: { value: number; reference: number } | undefined, barTime: number) => ({
      symbol: "BTCUSDT", timeframe: "1h", barTime, isClosedBar: true,
      high: 101, low: 99, close: 100,
      series: () => undefined,
      [key]: () => resolved,
    }) as unknown as FeedSample;

    // Warm-up: the runner has no reading to give.
    const warm = planAlert(spec, feed(undefined, 1_000), 1_000);
    assert.ok(warm.act);
    if (!warm.act) return;
    assert.equal(warm.side, null, `${kind} invented a side during warm-up`);
    const after = stateAfterPlan(spec, warm, { barTime: 1_000, now: 1_000, delivered: false });
    assert.equal(after.lastSide, null, `${kind} persisted an invented side`);

    // First computable bar, below the reference. Nothing crossed: the alert
    // has never seen this indicator above anything.
    const armed: AlertSpec = { ...spec, lastSide: after.lastSide, lastBarTime: 1_000 };
    const first = planAlert(armed, feed({ value: 10, reference: 20 }, 2_000), 2_000);
    assert.ok(first.act);
    if (!first.act) return;
    assert.equal(first.side, "below");
    assert.equal(first.triggered, false, `${kind} fired on its first computable bar`);

    // And a genuine crossing, seeded above then falling through, still fires.
    const seeded = planAlert(
      { ...armed, lastSide: "below", lastBarTime: 2_000 },
      feed({ value: 30, reference: 20 }, 3_000), 3_000);
    assert.ok(seeded.act);
    if (!seeded.act) return;
    assert.equal(seeded.side, "above");
    const crossing = planAlert(
      { ...armed, lastSide: seeded.side, lastBarTime: 3_000 },
      feed({ value: 10, reference: 20 }, 4_000), 4_000);
    assert.ok(crossing.act);
    if (!crossing.act) return;
    assert.equal(crossing.triggered, true, `${kind} missed a real crossing`);
  }
});

test("a Bollinger cross is subject to the same rule", () => {
  const condition = read("bollinger", { mode: "cross_down", band: "upper" });
  const spec: AlertSpec = {
    id: "a2", symbol: "BTCUSDT", timeframe: "1h", enabled: true,
    condition, frequency: "once_per_bar_close", lastSide: null,
    fireState: initialFireState(0), lastBarTime: null,
  };
  const feed = (band: { price: number; label: string } | undefined, close: number, barTime: number) =>
    ({
      symbol: "BTCUSDT", timeframe: "1h", barTime, isClosedBar: true,
      high: close + 1, low: close - 1, close,
      series: () => undefined,
      bollinger: () => band,
    }) as unknown as FeedSample;

  const warm = planAlert(spec, feed(undefined, 100, 1_000), 1_000);
  assert.ok(warm.act);
  if (!warm.act) return;
  assert.equal(warm.side, null);
  assert.equal(
    stateAfterPlan(spec, warm, { barTime: 1_000, now: 1_000, delivered: false }).lastSide, null);

  const first = planAlert(
    { ...spec, lastBarTime: 1_000 },
    feed({ price: 110, label: "upper band" }, 100, 2_000), 2_000);
  assert.ok(first.act);
  if (!first.act) return;
  assert.equal(first.triggered, false, "a first reading below the band is not a cross down");
});
