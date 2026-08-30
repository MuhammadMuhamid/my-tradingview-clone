import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionFromRow, evaluateCondition, validateCondition } from "../src/alerts/alertConditions";
import { planAlert, type AlertSpec, type FeedSample } from "../src/alerts/alertPlan";
import { formatAlertPush } from "../src/alerts/alertMessage";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { initialFireState } from "../src/alerts/alertFrequency";

const base = { high: 101, low: 99, close: 100 };

// ── sr_zone ────────────────────────────────────────────────────────────────

test("an sr_zone alert fires inside its band and names the timeframe", () => {
  const parsed = readCondition("sr_zone", {
    srSide: "support", mode: "near_above",
    nearMinPct: 0.2, nearMaxPct: 0.5,
  });
  assert.ok("condition" in parsed, `parse failed: ${JSON.stringify(parsed)}`);
  const condition = parsed.condition;
  assert.equal(validateCondition(condition), null);

  // Support at 99.7 with price at 100 → +0.30% above, inside 0.2–0.5%.
  const ev = evaluateCondition(condition, { ...base, refValue: 99.7, refLabel: "1h support" }, null);
  assert.equal(ev.triggered, true);
  assert.ok(Math.abs(ev.distancePct - 0.3009) < 0.01);

  const msg = formatAlertPush(
    { id: "a", symbol: "SOLUSDT", timeframe: "1h", frequency: "once_per_bar_close",
      nearMinPct: 0.2, nearMaxPct: 0.5 },
    condition, { close: 100 }, 99.7, ev.distancePct, false, "1h support"
  );
  assert.match(msg.body, /0\.30% above/, "the notification must say how near");
  assert.match(msg.body, /the 1h support/, "and which timeframe's zone");
  assert.doesNotMatch(msg.body, /1h 1h/, "the timeframe must not be repeated");
});

test("an sr_zone alert with no live zone does not fire and keeps its cross state", () => {
  const parsed = readCondition("sr_zone", {
    srSide: "support", mode: "near_above",
  });
  assert.ok("condition" in parsed);
  // refValue undefined: no zone is knowable yet.
  const ev = evaluateCondition(parsed.condition, base, "below");
  assert.equal(ev.triggered, false);
  assert.equal(ev.side, "below", "an unresolved reference must not rewrite the side");
});

// ── pivot_level ────────────────────────────────────────────────────────────

test("a pivot alert defaults to Fibonacci and the nearest level", () => {
  const parsed = readCondition("pivot_level", {});
  assert.ok("condition" in parsed, `parse failed: ${JSON.stringify(parsed)}`);
  const c = parsed.condition;
  assert.equal(c.kind, "pivot_level");
  if (c.kind !== "pivot_level") return;
  assert.equal(c.pivotType, "Fibonacci");
  assert.equal(c.levelName, "any");
  assert.equal(c.anchor, "1d");
});

test("a level the chosen type does not define is refused, not stored", () => {
  const parsed = readCondition("pivot_level", {
    pivotType: "Fibonacci", levelName: "R4",
  });
  assert.ok("condition" in parsed);
  const err = validateCondition(parsed.condition);
  assert.match(String(err), /Fibonacci has no level "R4"/);
});

test("a pivot notification names the level it fired on", () => {
  const parsed = readCondition("pivot_level", {
    pivotType: "Fibonacci", levelName: "any",
    mode: "near_above", nearMinPct: 0.2, nearMaxPct: 0.5,
  });
  assert.ok("condition" in parsed);
  const msg = formatAlertPush(
    { id: "b", symbol: "BTCUSDT", timeframe: "15m", frequency: "once_per_bar",
      nearMinPct: 0.2, nearMaxPct: 0.5 },
    parsed.condition, { close: 100 }, 99.7, 0.3009, false, "S1"
  );
  assert.match(msg.body, /S1/, "an 'any' alert must say which level matched");
  assert.match(msg.body, /0\.30% above/);
  assert.match(msg.body, /1d pivots/, "and which anchor period the levels came from");
});

// ── round trip ─────────────────────────────────────────────────────────────

test("both kinds survive the column round trip", () => {
  for (const body of [
    { conditionKind: "sr_zone", srSide: "resistance", mode: "touch" },
    { conditionKind: "pivot_level", pivotType: "Fibonacci", levelName: "S2", anchor: "4h", mode: "near_below" },
  ]) {
    const parsed = readCondition(body.conditionKind as never, body);
    assert.ok("condition" in parsed, `parse failed for ${body.conditionKind}`);
    const cols = toColumns(parsed.condition);
    const back = conditionFromRow({
      conditionKind: cols.conditionKind,
      maType: cols.maType, maLength: cols.maLength, mode: cols.mode,
      ma2Type: cols.ma2Type, ma2Length: cols.ma2Length,
      targetPrice: cols.targetPrice, priceDirection: cols.priceDirection,
      nearMinPct: cols.nearMinPct, nearMaxPct: cols.nearMaxPct,
      srSide: cols.srSide, srPivotLength: cols.srPivotLength,
      srInvalidation: cols.srInvalidation,
      pivotType: cols.pivotType, pivotLevelName: cols.pivotLevelName,
      pivotAnchor: cols.pivotAnchor,
    });
    assert.deepEqual(back, parsed.condition, `${body.conditionKind} did not round trip`);
  }
});

test("the plan resolves an sr_zone reference through the feed sample", () => {
  const parsed = readCondition("sr_zone", {
    srSide: "support", mode: "near_above",
    nearMinPct: 0.2, nearMaxPct: 0.5,
  });
  assert.ok("condition" in parsed);
  const spec: AlertSpec = {
    id: "x", symbol: "SOLUSDT", timeframe: "1h", enabled: true,
    condition: parsed.condition, frequency: "once_per_bar_close",
    lastSide: null, fireState: initialFireState(0), lastBarTime: null,
  };
  const sample: FeedSample = {
    symbol: "SOLUSDT", timeframe: "1h", barTime: 1, isClosedBar: true,
    high: 101, low: 99, close: 100,
    series: () => undefined,
    srZone: () => ({ price: 99.7, label: "1h support" }),
  };
  const plan = planAlert(spec, sample, Date.now());
  assert.equal(plan.act, true);
  if (!plan.act) return;
  assert.equal(plan.fire, true);
  assert.equal(plan.label, "1h support", "the matched zone must reach the notification");
});
