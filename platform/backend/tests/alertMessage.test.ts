/**
 * The notification an alert produces, and the request shapes the API accepts.
 *
 * Both are pure, so both are pinned here without a push service or a database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAlertPush, frequencyWarning } from "../src/alerts/alertMessage";
import { formatMaAlertPush } from "../src/alerts/maEvaluator";
import { INTRABAR_WARNING, ALERT_FREQUENCIES } from "../src/alerts/alertFrequency";
import { MAX_PUSH_PAYLOAD_BYTES } from "../src/alerts/webPush";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import type { AlertCondition } from "../src/alerts/alertConditions";

const alert = {
  id: "11111111-2222-3333-4444-555555555555",
  symbol: "APTUSDT", timeframe: "15m",
  frequency: "once_per_bar_close" as const,
  nearMinPct: 0.2, nearMaxPct: 0.5,
};

const maCondition: AlertCondition = {
  kind: "ma", maType: "ema", maLength: 200, mode: "cross_up", nearMinPct: 0.2, nearMaxPct: 0.5,
};

// ── The existing notification must not change ───────────────────────────────

test("AN MA ALERT'S NOTIFICATION IS BYTE-IDENTICAL TO THE ONE IT PRODUCED BEFORE", () => {
  // A user who has learned to read these at a glance should not have to relearn
  // them because the system grew two more condition kinds.
  const before = formatMaAlertPush(
    { ...alert, maType: "ema", maLength: 200, mode: "cross_up" },
    { close: 12.3456 }, 12.0, 2.88
  );
  const after = formatAlertPush(alert, maCondition, { close: 12.3456 }, 12.0, 2.88, false);
  assert.deepEqual(after, before);
});

test("a notification from a forming candle says so", () => {
  const closed = formatAlertPush(alert, maCondition, { close: 12.3456 }, 12.0, 2.88, false);
  const forming = formatAlertPush(alert, maCondition, { close: 12.3456 }, 12.0, 2.88, true);
  assert.equal(forming.body, `${closed.body} · bar still forming`);
  assert.equal(forming.title, closed.title);
  assert.equal(forming.tag, closed.tag, "it still collapses onto the same notification");
});

// ── The new kinds ───────────────────────────────────────────────────────────

test("a price alert names the level in the title and the last price in the body", () => {
  const msg = formatAlertPush(
    alert, { kind: "price", targetPrice: 12.5, direction: "cross_up" },
    { close: 12.61 }, 12.5, 0.88, false
  );
  assert.equal(msg.title, "APTUSDT 15m — 12.5");
  assert.equal(msg.body, "Price crosses above 12.5 (last 12.61)");
  assert.equal(msg.url, "/chart?symbol=APTUSDT&interval=15m");
});

test("an MA-versus-MA alert names both lines", () => {
  const msg = formatAlertPush(
    alert, { kind: "ma_vs_ma", maType: "ema", maLength: 50, ma2Type: "sma", ma2Length: 200, mode: "cross_up" },
    { close: 12.6 }, 11.9, 1.68, false
  );
  assert.equal(msg.title, "APTUSDT 15m — EMA 50/SMA 200");
  assert.match(msg.body, /^EMA 50 crosses above the SMA 200 \(EMA 50 \+1\.68% vs SMA 200 11\.9\)$/);
});

test("every kind stays far inside the 4 KB Web Push payload limit", () => {
  const long = { ...alert, symbol: "1000000BABYDOGEUSDT", timeframe: "1d" };
  const conditions: AlertCondition[] = [
    { kind: "ma", maType: "sma", maLength: 200, mode: "near_below", nearMinPct: 0.2, nearMaxPct: 0.5 },
    { kind: "price", targetPrice: 0.000001234, direction: "either" },
    { kind: "ma_vs_ma", maType: "ema", maLength: 200, ma2Type: "sma", ma2Length: 1000, mode: "cross_down" },
  ];
  for (const condition of conditions) {
    for (const intrabar of [false, true]) {
      const msg = formatAlertPush(long, condition, { close: 0.000001234 }, 0.000001311, -5.87, intrabar);
      const bytes = Buffer.byteLength(JSON.stringify(msg), "utf8");
      assert.ok(bytes < MAX_PUSH_PAYLOAD_BYTES, `${condition.kind} payload was ${bytes} bytes`);
      assert.ok(bytes < 400, `${condition.kind} should be a few hundred bytes, was ${bytes}`);
    }
  }
});

// ── The warning ─────────────────────────────────────────────────────────────

test("EXACTLY THE TWO INTRABAR MODES CARRY THE WARNING, VERBATIM", () => {
  const warned = ALERT_FREQUENCIES.filter((f) => frequencyWarning(f) !== null);
  assert.deepEqual(warned, ["once_per_bar", "once_per_minute"]);
  for (const f of warned) assert.equal(frequencyWarning(f), INTRABAR_WARNING);
  assert.equal(
    INTRABAR_WARNING,
    "May trigger before the candle closes. The condition can become false again before bar close."
  );
});

// ── What the API accepts ────────────────────────────────────────────────────

test("an MA request without conditionKind is read exactly as it always was", () => {
  const read = readCondition("ma", { maType: "ema", maLength: 200, mode: "cross_up" });
  assert.deepEqual(read, {
    condition: { kind: "ma", maType: "ema", maLength: 200, mode: "cross_up", nearMinPct: 0.2, nearMaxPct: 0.5 },
  });
});

test("a price request defaults to `either` — the direction a dragged line implies", () => {
  const read = readCondition("price", { targetPrice: 64000 });
  assert.deepEqual(read, { condition: { kind: "price", targetPrice: 64000, direction: "either" } });
});

test("each kind rejects the fields it needs and did not get", () => {
  assert.match((readCondition("price", {}) as { error: string }).error, /targetPrice/);
  assert.match((readCondition("price", { targetPrice: 1, priceDirection: "sideways" }) as { error: string }).error, /priceDirection/);
  assert.match((readCondition("ma", { maLength: 15, mode: "touch" }) as { error: string }).error, /maType/);
  assert.match((readCondition("ma", { maType: "sma", maLength: 15.5, mode: "touch" }) as { error: string }).error, /maLength/);
  assert.match((readCondition("ma", { maType: "sma", maLength: 15, mode: "wiggle" }) as { error: string }).error, /mode/);
  assert.match(
    (readCondition("ma_vs_ma", { maType: "sma", maLength: 50, mode: "touch", ma2Type: "sma", ma2Length: 200 }) as { error: string }).error,
    /cross_up or cross_down/
  );
  assert.match((readCondition("ma_vs_ma", { maType: "sma", maLength: 50, mode: "cross_up" }) as { error: string }).error, /ma2Type/);
});

test("the column shape a condition flattens to leaves the other kinds' columns null", () => {
  const price = toColumns({ kind: "price", targetPrice: 100, direction: "either" });
  assert.equal(price.conditionKind, "price");
  assert.equal(price.targetPrice, 100);
  for (const k of ["maType", "maLength", "mode", "ma2Type", "ma2Length"] as const) {
    assert.equal(price[k], null, `${k} should be null for a price alert`);
  }

  const ma = toColumns({ kind: "ma", maType: "sma", maLength: 15, mode: "touch", nearMinPct: 1, nearMaxPct: 2 });
  assert.equal(ma.targetPrice, null);
  assert.equal(ma.priceDirection, null);
  assert.equal(ma.nearMinPct, 1, "an MA alert keeps its own band");

  const cross = toColumns({ kind: "ma_vs_ma", maType: "ema", maLength: 50, ma2Type: "sma", ma2Length: 200, mode: "cross_down" });
  assert.equal(cross.ma2Length, 200);
  assert.equal(cross.targetPrice, null);
});
