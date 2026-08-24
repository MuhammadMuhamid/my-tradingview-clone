/**
 * Characterization of the EXISTING MA alert behaviour, which later work must
 * preserve as the default.
 *
 * The runner (`engine/maAlertRunner.ts`) evaluates only on a websocket
 * `barClose` event, computes the MA over closed bars, and calls
 * `evaluateMaAlert` + `cooldownElapsed` once per alert per bar. This test
 * replays that exact composition over a candle fixture, so the "one decision
 * per closed candle" property is pinned independently of the database and the
 * websocket.
 *
 * Intrabar ticks are not represented here on purpose: today there is no code
 * path that feeds one to an MA alert.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cooldownElapsed, evaluateMaAlert, type MaAlertSpec, type Side } from "../src/alerts/maEvaluator";
import { sma } from "../src/engine/ta";
import { INTERVAL_MS, type Candle } from "../src/types/market";

interface Fire { barTime: number; maValue: number }

/** Exactly the decision the runner makes, per closed bar. */
function replay(
  bars: Candle[],
  spec: MaAlertSpec & { maLength: number; cooldownMin: number },
  startSide: Side | null = null
): { fires: Fire[]; evaluations: number } {
  const fires: Fire[] = [];
  let side = startSide;
  let lastFiredAt: string | null = null;
  let evaluations = 0;

  for (let i = 0; i < bars.length; i++) {
    const window = bars.slice(0, i + 1);
    const ma = sma(window.map((b) => b.close), spec.maLength);
    const value = ma[ma.length - 1];
    if (value === undefined || !Number.isFinite(value)) continue;
    evaluations++;

    const bar = bars[i]!;
    const now = bar.closeTime + 1;
    const result = evaluateMaAlert(spec, bar, value, side);
    if (result.triggered && cooldownElapsed(lastFiredAt, spec.cooldownMin, now)) {
      fires.push({ barTime: bar.openTime, maValue: value });
      lastFiredAt = new Date(now).toISOString();
    }
    side = result.side;
  }
  return { fires, evaluations };
}

function bars(closes: number[], interval: "15m" = "15m"): Candle[] {
  const step = INTERVAL_MS[interval];
  return closes.map((close, i) => {
    const openTime = i * step;
    return {
      symbol: "TESTUSDT", interval, openTime,
      open: close, high: close + 0.5, low: close - 0.5, close,
      volume: 1, closeTime: openTime + step - 1,
    } satisfies Candle;
  });
}

const spec = (over: Partial<MaAlertSpec & { maLength: number; cooldownMin: number }> = {}) => ({
  mode: "cross_up" as const, nearMinPct: 0.2, nearMaxPct: 0.5,
  maLength: 3, cooldownMin: 0, ...over,
});

test("an MA alert is evaluated at most once per closed bar", () => {
  const series = bars([10, 10, 10, 10, 10, 10]);
  const { evaluations } = replay(series, spec({ mode: "touch" }));
  // First two bars cannot seed a 3-period MA, so four decisions for six bars.
  assert.equal(evaluations, 4);
});

test("a cross fires once, on the bar whose CLOSE completes the cross", () => {
  //                        MA(3) rises through the closes; the cross is at index 4.
  const series = bars([10, 10, 10, 9, 12, 12.5]);
  const { fires } = replay(series, spec({ mode: "cross_up" }));
  assert.equal(fires.length, 1);
  assert.equal(fires[0]!.barTime, series[4]!.openTime);
});

test("a wick through the MA that closes back does NOT cross — only `touch` sees it", () => {
  const series = bars([10, 10, 10, 10.4, 10.2]);
  // Push a deep wick into the final bar without moving its close.
  series[4] = { ...series[4]!, low: 5 };
  const crossOnly = replay(series, spec({ mode: "cross_down" })).fires;
  assert.equal(crossOnly.length, 0, "close stayed above the MA, so there is no cross");
  const touched = replay(series, spec({ mode: "touch" })).fires;
  assert.ok(touched.length > 0, "touch is the mode that catches the wick");
});

test("repeated true bars keep firing when the cooldown is zero — today's default behaviour", () => {
  const series = bars([10, 10, 10, 10, 10, 10, 10]);
  const { fires } = replay(series, spec({ mode: "touch", cooldownMin: 0 }));
  assert.equal(fires.length, 5, "every closed bar containing the MA fires");
});

test("the cooldown window, not the candle, is what suppresses repeats today", () => {
  const series = bars([10, 10, 10, 10, 10, 10, 10]);
  // 15m bars; a 30-minute cooldown permits one fire every other bar.
  const { fires } = replay(series, spec({ mode: "touch", cooldownMin: 30 }));
  assert.equal(fires.length, 3);
  const gaps = fires.slice(1).map((f, i) => f.barTime - fires[i]!.barTime);
  for (const g of gaps) assert.ok(g >= 30 * 60_000, `gap ${g} must clear the cooldown`);
});

test("a cross alert with no stored side seeds quietly rather than firing on the current side", () => {
  const series = bars([10, 10, 10, 20]);
  const { fires } = replay(series, spec({ mode: "cross_up" }), null);
  // Bar 2 seeds "above" without firing; bar 3 is already above, so no cross.
  assert.equal(fires.length, 0);
});

test("MA values come from closed bars only — the last value equals the SMA of the closes", () => {
  const closes = [1, 2, 3, 4, 5];
  const series = bars(closes);
  const ma = sma(series.map((b) => b.close), 3);
  assert.equal(ma[ma.length - 1], (3 + 4 + 5) / 3);
});
