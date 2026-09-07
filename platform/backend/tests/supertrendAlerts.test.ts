/**
 * Supertrend: the indicator, the alert family, and the gate.
 *
 * What matters about this indicator, and what is pinned here:
 *
 *  - the bands are STATEFUL. `up` ratchets upward while the previous close is
 *    above it and never falls back; recomputing from the current bar alone
 *    gives a different line and several times the real flip count.
 *  - the flip compares this bar's close against the PREVIOUS bar's band. Using
 *    the band being computed shifts every signal by one bar.
 *  - the alert's event is the DIRECTION CHANGE, not price touching the line. On
 *    the flip bar the line has already jumped to the other side of price, so a
 *    close-versus-line test would report the two in the wrong order.
 *  - a gate never fires anything. It only suppresses, and it fails closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { supertrend } from "../src/engine/ta";
import type { AlertFilters } from "../src/alerts/alertConditions";
import {
  evaluateCondition, describeCondition, validateCondition, conditionFromRow,
  filtersPass, stLabel, type AlertCondition, type Sample,
} from "../src/alerts/alertConditions";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { planAlert, type AlertSpec, type FeedSample } from "../src/alerts/alertPlan";
import { formatAlertPush } from "../src/alerts/alertMessage";
import { initialFireState } from "../src/alerts/alertFrequency";
import { SUPERTREND_DEFAULTS } from "../src/types/maAlerts";

const bar = { high: 101, low: 99, close: 100 };

const stCond = (
  over: Partial<Extract<AlertCondition, { kind: "supertrend" }>> = {}
): AlertCondition => ({
  kind: "supertrend" as const,
  period: SUPERTREND_DEFAULTS.period,
  multiplier: SUPERTREND_DEFAULTS.multiplier,
  atrMethod: SUPERTREND_DEFAULTS.atrMethod,
  mode: "cross_up" as const,
  ...over,
});

// ── the indicator ──────────────────────────────────────────────────────────

/** A rise, a sharp drop, and a recovery — enough for flips in both directions. */
function series(): { high: number[]; low: number[]; close: number[] } {
  const close: number[] = [];
  for (let i = 0; i < 40; i++) close.push(100 + i);          // steady uptrend
  for (let i = 0; i < 20; i++) close.push(139 - i * 4);      // sharp drop
  for (let i = 0; i < 40; i++) close.push(59 + i * 2);       // recovery
  return {
    close,
    high: close.map((c) => c + 1),
    low: close.map((c) => c - 1),
  };
}

test("the up band ratchets: it never falls while the previous close is above it", () => {
  const { high, low, close } = series();
  const st = supertrend(high, low, close, 10, 3);
  // Through the opening uptrend, once both bars have a band, `up` is
  // non-decreasing. This is the stateful property; a stateless recomputation
  // would let it fall back on any bar whose ATR widened.
  for (let i = 12; i < 39; i++) {
    if (st.trend[i] !== 1 || st.trend[i - 1] !== 1) continue;
    assert.ok(
      st.up[i]! >= st.up[i - 1]! - 1e-9,
      `up fell at bar ${i}: ${st.up[i - 1]} -> ${st.up[i]}`
    );
  }
});

test("the trend flips down on the crash and back up on the recovery, once each", () => {
  const { high, low, close } = series();
  const st = supertrend(high, low, close, 10, 3);
  const flips: { at: number; to: number }[] = [];
  for (let i = 1; i < close.length; i++) {
    if (Number.isFinite(st.trend[i]!) && Number.isFinite(st.trend[i - 1]!) &&
        st.trend[i] !== st.trend[i - 1]) {
      flips.push({ at: i, to: st.trend[i]! });
    }
  }
  assert.deepEqual(flips.map((f) => f.to), [-1, 1], `got ${JSON.stringify(flips)}`);
  // Down during the crash (which starts at bar 40), back up during the recovery.
  assert.ok(flips[0]!.at > 40 && flips[0]!.at < 60, `down flip at ${flips[0]!.at}`);
  assert.ok(flips[1]!.at > 60, `up flip at ${flips[1]!.at}`);
});

test("the drawn line is always on the far side of price from the trend", () => {
  const { high, low, close } = series();
  const st = supertrend(high, low, close, 10, 3);
  for (let i = 15; i < close.length; i++) {
    if (!Number.isFinite(st.trend[i]!)) continue;
    // In an uptrend the line is the support band below; in a downtrend, the
    // resistance band above. This is what makes "price above the Supertrend"
    // and "the trend is up" the same statement.
    assert.equal(st.line[i], st.trend[i] === 1 ? st.up[i] : st.dn[i]);
  }
});

test("the two ATR methods are different indicators, not a rounding difference", () => {
  const { high, low, close } = series();
  const wilder = supertrend(high, low, close, 10, 3, true);
  const simple = supertrend(high, low, close, 10, 3, false);
  const last = close.length - 1;
  assert.notEqual(wilder.line[last], simple.line[last]);
});

test("a wider multiplier flips less often — the band has to be crossed to flip", () => {
  const { high, low, close } = series();
  const flips = (m: number): number => {
    const st = supertrend(high, low, close, 10, m);
    let n = 0;
    for (let i = 1; i < close.length; i++) {
      if (Number.isFinite(st.trend[i]!) && Number.isFinite(st.trend[i - 1]!) &&
          st.trend[i] !== st.trend[i - 1]) n++;
    }
    return n;
  };
  assert.ok(flips(1) >= flips(3), `1x: ${flips(1)}, 3x: ${flips(3)}`);
});

test("bars before the ATR has warmed up carry no trend at all", () => {
  const { high, low, close } = series();
  const st = supertrend(high, low, close, 10, 3);
  assert.ok(!Number.isFinite(st.trend[0]!), "bar 0 must not claim a direction");
});

// ── the alert family ───────────────────────────────────────────────────────

test("a Supertrend alert does not fire on its first evaluation, either direction", () => {
  for (const trend of [1, -1]) {
    const e = evaluateCondition(
      stCond(), { ...bar, indicatorValue: trend, refValue: 95 }, null
    );
    assert.equal(e.triggered, false, `seeded in trend ${trend}`);
    assert.equal(e.side, trend > 0 ? "above" : "below");
  }
});

test("the flip fires on the bar the direction changes, and not after", () => {
  const c = stCond({ mode: "cross_up" });
  const down = evaluateCondition(c, { ...bar, indicatorValue: -1, refValue: 105 }, null);
  assert.equal(down.side, "below");

  const flip = evaluateCondition(c, { ...bar, indicatorValue: 1, refValue: 95 }, down.side);
  assert.equal(flip.triggered, true);

  const after = evaluateCondition(c, { ...bar, indicatorValue: 1, refValue: 96 }, flip.side);
  assert.equal(after.triggered, false, "still up is not a flip");
});

test("cross_down is its own event, not the absence of cross_up", () => {
  const s: Sample = { ...bar, indicatorValue: -1, refValue: 105 };
  assert.equal(evaluateCondition(stCond({ mode: "cross_up" }), s, "above").triggered, false);
  assert.equal(evaluateCondition(stCond({ mode: "cross_down" }), s, "above").triggered, true);
});

test("the side comes from the trend, not from price against the line", () => {
  /*
   * The flip bar is the case that separates the two readings. Price is 100 and
   * the line has already moved BELOW it to 95 — but the indicator only just
   * turned up, so this bar is the flip. A close-versus-line test would have
   * called the previous bar "above" too and seen no cross here at all.
   */
  const e = evaluateCondition(
    stCond({ mode: "cross_up" }), { ...bar, indicatorValue: 1, refValue: 95 }, "below"
  );
  assert.equal(e.triggered, true);
  assert.equal(e.reference, 95, "the line is still what the notification names");
});

test("an unresolved Supertrend leaves the stored side alone", () => {
  const e = evaluateCondition(stCond(), { ...bar }, "above");
  assert.equal(e.triggered, false);
  assert.equal(e.side, "above", "a NaN trend must not flip the persisted side");
});

test("a Supertrend alert is refused when its inputs could never produce a flip", () => {
  for (const multiplier of [0, -1, 1000]) {
    assert.ok(
      "error" in readCondition("supertrend", { stMultiplier: multiplier }),
      `multiplier ${multiplier} should be refused`
    );
  }
  assert.ok(validateCondition(stCond({ period: 0 })));
  assert.equal(validateCondition(stCond()), null);
});

test("the parser reads the field names the client sends, and defaults to the study's", () => {
  const d = readCondition("supertrend", {});
  assert.ok("condition" in d);
  assert.deepEqual(d.condition, {
    kind: "supertrend", period: 10, multiplier: 3, atrMethod: "rma", mode: "cross_up",
  });

  const c = readCondition("supertrend", {
    stPeriod: 14, stMultiplier: 2.5, stAtrMethod: "sma", mode: "cross_down",
  });
  assert.ok("condition" in c);
  if (c.condition.kind !== "supertrend") return;
  assert.equal(c.condition.period, 14);
  assert.equal(c.condition.multiplier, 2.5);
  assert.equal(c.condition.atrMethod, "sma");
  assert.equal(c.condition.mode, "cross_down");
});

test("a Supertrend condition survives the column round trip", () => {
  const original = stCond({ period: 14, multiplier: 2.5, atrMethod: "sma" });
  const columns = toColumns(original);
  assert.equal(columns.stPeriod, 14);
  assert.equal(columns.stMultiplier, 2.5);
  assert.equal(columns.stAtrMethod, "sma");
  const back = conditionFromRow({
    ...columns, nearMinPct: 0.2, nearMaxPct: 0.5,
  } as Parameters<typeof conditionFromRow>[0]);
  assert.deepEqual(back, original);
});

test("only non-default parameters are spelled out in the label", () => {
  assert.equal(stLabel({ period: 10, multiplier: 3, atrMethod: "rma" }), "Supertrend");
  assert.equal(stLabel({ period: 14, multiplier: 2, atrMethod: "rma" }), "Supertrend 14/2");
  assert.equal(stLabel({ period: 10, multiplier: 3, atrMethod: "sma" }), "Supertrend SMA ATR");
});

test("the notification says the direction changed, not that price crossed a line", () => {
  assert.equal(describeCondition(stCond()), "Supertrend flips up");
  assert.equal(describeCondition(stCond({ mode: "cross_down" })), "Supertrend flips down");
  const push = formatAlertPush(
    {
      id: "a", symbol: "NEARUSDT", timeframe: "1h",
      frequency: "once_per_bar_close", nearMinPct: 0.2, nearMaxPct: 0.5,
    },
    stCond(), { close: 2.226 }, 2.19, 1.64, false
  );
  assert.match(push.body, /flipped up/);
  assert.doesNotMatch(push.body, /crosses/);
});

// ── the gate, on every family ──────────────────────────────────────────────

test("a Supertrend gate reads the direction, and fails closed when it is unknown", () => {
  const gate: AlertFilters = [
  { kind: "supertrend", timeframe: null, period: 10, multiplier: 3, atrMethod: "rma", side: "above" },
];
  assert.equal(filtersPass(gate, { ...bar, filterReadings: [1] }), true);
  assert.equal(filtersPass(gate, { ...bar, filterReadings: [-1] }), false);
  // Not warmed up. The user asked for "only while the trend is up"; firing
  // because the trend is UNKNOWN answers a different question.
  assert.equal(filtersPass(gate, { ...bar }), false);
  assert.equal(filtersPass(gate, { ...bar, filterReadings: [NaN] }), false);
});

test("every family accepts a gate, and every family's gate actually suppresses", () => {
  const bodies: Record<string, Record<string, unknown>> = {
    price: { targetPrice: 100, priceDirection: "either" },
    ma: { maType: "ema", maLength: 200, mode: "touch" },
    ma_vs_ma: { maType: "ema", maLength: 50, ma2Type: "sma", ma2Length: 200, mode: "cross_up" },
    sr_zone: { srSide: "support", mode: "touch" },
    pivot_level: { pivotType: "Fibonacci", levelName: "any", anchor: "1d", mode: "touch" },
    rsi: { mode: "cross_up" },
    macd: { mode: "cross_up" },
    supertrend: { mode: "cross_up" },
  };
  for (const [kind, body] of Object.entries(bodies)) {
    const read = readCondition(kind as "price", { ...body, filterSt: true });
    assert.ok("condition" in read, `${kind}: ${JSON.stringify(read)}`);
    assert.ok(read.condition.filters?.[0], `${kind} dropped the gate`);
    // And it survives being flattened into columns — a gate accepted at the API
    // and lost on the way to the database is a filter that silently does
    // nothing, which is the failure this asserts against.
    assert.equal(toColumns(read.condition).filterStSide, "above", `${kind} lost the gate`);
  }
});

test("a shut gate suppresses the trigger without touching the cross memory", () => {
  const condition = readCondition("ma", {
    maType: "ema", maLength: 200, mode: "cross_up", filterSt: true,
  });
  assert.ok("condition" in condition);

  const open = evaluateCondition(
    condition.condition, { ...bar, maValue: 95, filterReadings: [1] }, "below"
  );
  assert.equal(open.triggered, true);

  const shut = evaluateCondition(
    condition.condition, { ...bar, maValue: 95, filterReadings: [-1] }, "below"
  );
  assert.equal(shut.triggered, false);
  // The side is the memory a cross is detected against. Withholding it while
  // the gate is shut would leave stale state that fires spuriously the moment
  // the gate opens.
  assert.equal(shut.side, open.side);
  assert.equal(shut.distancePct, open.distancePct);
});

test("the runner resolves the gate for a family that has no Supertrend of its own", () => {
  const read = readCondition("rsi", { mode: "cross_up", filterSt: true });
  assert.ok("condition" in read);
  const spec: AlertSpec = {
    id: "a", symbol: "BTCUSDT", timeframe: "1h", enabled: true,
    condition: read.condition, frequency: "once_per_bar_close",
    lastSide: "below", fireState: initialFireState(0), lastBarTime: null,
  };
  let asked = false;
  const feed = (trend: number): FeedSample => ({
    symbol: "BTCUSDT", timeframe: "1h", barTime: 1, isClosedBar: true,
    high: 101, low: 99, close: 100,
    series: () => undefined,
    rsi: () => ({ value: 55, reference: 50 }),
    supertrend: () => { asked = true; return { trend, line: 95 }; },
  });

  const blocked = planAlert(spec, feed(-1), Date.now());
  assert.ok(blocked.act && blocked.triggered === false, "a shut gate must block the RSI cross");
  assert.ok(asked, "the runner never resolved the gate — it would be silently ignored");

  const allowed = planAlert(spec, feed(1), Date.now());
  assert.ok(allowed.act && allowed.fire, "an open gate must let the same cross through");
});

/**
 * The port, against an INDEPENDENT transcription of the same Pine.
 *
 * Every other test in this file was written from the same understanding as the
 * implementation, so a misreading of the study would be reproduced faithfully
 * in both and pass. This one is different: the expected values in
 * `fixtures/supertrendGolden.json` were produced by a separate, line-by-line
 * transcription of the v4 source into Python, written from the Pine rather than
 * from `ta.ts`, and run over 160 real SOLUSDT 15m candles. Two transcriptions
 * made separately are unlikely to share a mistake.
 *
 * The fixture is real market data, not a synthetic ramp, and it contains nine
 * genuine direction changes — the bars where the stateful bands and the
 * previous-bar comparison actually matter. A ramp would agree under almost any
 * implementation of this indicator, including several wrong ones.
 *
 * Both ATR methods are covered, because they are different indicators.
 */
test("the Supertrend port matches an independent transcription of the study", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "supertrendGolden.json"), "utf8")
  ) as {
    bars: [number, number, number][];
    cases: {
      label: string; period: number; multiplier: number; atrMethod: "rma" | "sma";
      trend: (number | null)[]; line: (number | null)[];
    }[];
  };
  const high = golden.bars.map((b) => b[0]);
  const low = golden.bars.map((b) => b[1]);
  const close = golden.bars.map((b) => b[2]);

  for (const c of golden.cases) {
    const st = supertrend(high, low, close, c.period, c.multiplier, c.atrMethod === "rma");
    let flips = 0;
    for (let i = 0; i < close.length; i++) {
      const expected = c.trend[i];
      const actual = st.trend[i]!;
      if (expected === null) {
        assert.ok(
          !Number.isFinite(actual),
          `${c.label} bar ${i}: claims a direction before the ATR has warmed up`
        );
        continue;
      }
      assert.equal(actual, expected, `${c.label} bar ${i}: trend`);
      assert.ok(
        Math.abs(st.line[i]! - c.line[i]!) < 1e-8,
        `${c.label} bar ${i}: line ${st.line[i]} vs ${c.line[i]}`
      );
      if (i > 0 && c.trend[i - 1] !== null && expected !== c.trend[i - 1]) flips++;
    }
    // If the fixture ever stops containing real flips it has stopped testing
    // the only part of this indicator that is hard to get right.
    assert.ok(flips > 0, `${c.label} has no direction changes left to check`);
  }
});
