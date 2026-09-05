/**
 * Editing an alert in place.
 *
 * Two questions are asked here, and they are different.
 *
 * The ROUND TRIP asks whether `alertRequestFromRow` really is the inverse of
 * `toColumns` for every family. If one key is misnamed — `pivotLevelName`
 * instead of `levelName`, `srPivotLength` instead of `pivotLength` — every save
 * silently resets that field to its default, and nothing else in the system
 * notices: the row is valid, the alert stays armed, and it simply watches
 * something the user did not ask for.
 *
 * The HTTP tests ask what the endpoint accepts and refuses, with a repository
 * fake, so the whole matrix is covered without a database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { alertPatchHandler } from "../src/api/routes/maAlerts";
import { AlertConflictError, type MaAlertPatch } from "../src/repositories/maAlerts";
import {
  alertRequestFromRow, EDITABLE_CONDITION_FIELDS, mergeConditionRequest,
} from "../src/alerts/alertEdit";
import { readCondition, toColumns } from "../src/alerts/alertRequest";
import { CONDITION_KINDS, type ConditionKind, type MaAlertRow } from "../src/types/maAlerts";

const ID = "11111111-1111-4111-8111-111111111111";

const BASE: MaAlertRow = {
  id: ID, symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
  maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
  targetPrice: 100, priceDirection: "either",
  srSide: null, srPivotLength: null, srInvalidation: null,
  pivotType: null, pivotLevelName: null, pivotAnchor: null,
  rsiLength: null, rsiLevel: null, rsiMaLength: null,
  macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: null,
  stPeriod: null, stMultiplier: null, stAtrMethod: null,
  bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
  stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
  adxDiLength: null, adxSmoothing: null, adxLevel: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null,
  filterStAtrMethod: null, filterStSide: null,
  nearMinPct: 0.2, nearMaxPct: 0.5, enabled: true,
  frequency: "once_per_bar_close", cooldownMin: 60, note: "keep me",
  lastSide: "below", lastFiredAt: "2026-08-01T00:00:00.000Z",
  lastFiredBarTime: "2026-08-01T00:00:00.000Z", lastBarTime: "2026-08-01T01:00:00.000Z",
  completedAt: null, createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/** One representative persisted row per family, with non-default values. */
const ROWS: Record<ConditionKind, MaAlertRow> = {
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
    filterMaType: "sma", filterMaLength: 100, filterMaSide: "below",
  },
  pivot_level: {
    ...BASE, conditionKind: "pivot_level", targetPrice: null, priceDirection: null,
    pivotType: "Camarilla", pivotLevelName: "R3", pivotAnchor: "4h",
    mode: "touch", nearMinPct: 0.2, nearMaxPct: 0.5,
  },
  rsi: {
    ...BASE, conditionKind: "rsi", targetPrice: null, priceDirection: null,
    rsiLength: 14, rsiLevel: 70, rsiMaLength: 9, indicatorTarget: "level", mode: "cross_down",
  },
  macd: {
    ...BASE, conditionKind: "macd", targetPrice: null, priceDirection: null,
    macdFast: 8, macdSlow: 21, macdSignal: 5, indicatorTarget: "zero", mode: "cross_up",
    // Carries a Supertrend gate, because gates are no longer a level-family
    // privilege and the round trip must prove an oscillator keeps one.
    filterStPeriod: 14, filterStMultiplier: 2, filterStAtrMethod: "sma",
    filterStSide: "below",
  },
  supertrend: {
    ...BASE, conditionKind: "supertrend", targetPrice: null, priceDirection: null,
    stPeriod: 14, stMultiplier: 2.5, stAtrMethod: "sma", mode: "cross_down",
  },
  bollinger: {
    ...BASE, conditionKind: "bollinger", targetPrice: null, priceDirection: null,
    bbLength: 30, bbMult: 2.5, bbBand: "lower", bbMaType: "ema",
    mode: "near_below", nearMinPct: 0.15, nearMaxPct: 0.6,
  },
  stochastic: {
    ...BASE, conditionKind: "stochastic", targetPrice: null, priceDirection: null,
    stochKLength: 21, stochKSmooth: 3, stochDSmooth: 5, stochLevel: 80,
    indicatorTarget: "level", mode: "cross_down",
    // A gate on an oscillator family, for the same reason `macd` carries one.
    filterMaType: "ema", filterMaLength: 200, filterMaSide: "above",
  },
  adx: {
    ...BASE, conditionKind: "adx", targetPrice: null, priceDirection: null,
    adxDiLength: 20, adxSmoothing: 10, adxLevel: 30, mode: "cross_up",
  },
};

/** The condition columns a row currently holds, in `toColumns` shape. */
function columnsOf(row: MaAlertRow): Record<string, unknown> {
  const read = readCondition(row.conditionKind, alertRequestFromRow(row));
  assert.ok(!("error" in read), `${row.conditionKind}: ${JSON.stringify(read)}`);
  return toColumns(read.condition) as unknown as Record<string, unknown>;
}

// ── The inverse ────────────────────────────────────────────────────────────

test("every family round-trips row -> request -> condition -> columns unchanged", () => {
  for (const kind of CONDITION_KINDS) {
    const row = ROWS[kind];
    const columns = columnsOf(row);
    assert.equal(columns.conditionKind, kind);
    for (const [key, value] of Object.entries(columns)) {
      if (key === "conditionKind") continue;
      assert.deepEqual(
        value, (row as unknown as Record<string, unknown>)[key],
        `${kind}.${key} was not preserved by the round trip`
      );
    }
  }
});

test("a body naming no condition field leaves the condition alone", () => {
  for (const kind of CONDITION_KINDS) {
    assert.equal(mergeConditionRequest(ROWS[kind], { enabled: false }), null);
  }
});

test("a level gate is added, changed and removed through the merged request", () => {
  const added = mergeConditionRequest(ROWS.pivot_level, { filterRsiLevel: 60 })!;
  assert.equal(added.filterRsi, true, "a bare gate value must switch the gate on");
  assert.equal(added.filterRsiLevel, 60);

  const changed = mergeConditionRequest(ROWS.sr_zone, { filterRsiLevel: 45 })!;
  assert.equal(changed.filterRsiLength, 21, "the untouched half of the gate is preserved");
  assert.equal(changed.filterRsiLevel, 45);

  const removed = mergeConditionRequest(ROWS.sr_zone, { filterRsi: false })!;
  assert.equal(removed.filterRsi, undefined);
  assert.equal(removed.filterRsiLength, undefined);
  assert.equal(removed.filterMa, true, "removing one gate must not remove the other");
});

// ── The endpoint ───────────────────────────────────────────────────────────

interface Call { id: string; patch: MaAlertPatch }

async function patch(
  body: Record<string, unknown>,
  row: MaAlertRow | null = ROWS.rsi,
  opts: { id?: string; conflict?: boolean } = {}
): Promise<{ status: number; body: Record<string, unknown>; call: Call | null }> {
  let call: Call | null = null;
  const app = Fastify({ logger: false });
  app.patch("/api/ma-alerts/:id", alertPatchHandler({
    getAlert: async () => row,
    updateAlert: async (id, p) => {
      call = { id, patch: p };
      if (opts.conflict) throw new AlertConflictError();
      return { ...(row as MaAlertRow), ...(p as Partial<MaAlertRow>) };
    },
  }));
  const response = await app.inject({
    method: "PATCH", url: `/api/ma-alerts/${opts.id ?? ID}`, payload: body,
  });
  await app.close();
  return { status: response.statusCode, body: response.json(), call };
}

test("editing one family field persists it and restates every other column", async () => {
  const { status, call } = await patch({ rsiLevel: 30 }, ROWS.rsi);
  assert.equal(status, 200);
  assert.equal(call!.id, ID);
  assert.equal(call!.patch.rsiLevel, 30);
  // Untouched halves of the same condition are written back as they were, not
  // dropped and not defaulted.
  assert.equal(call!.patch.rsiLength, 14);
  assert.equal(call!.patch.rsiMaLength, 9);
  assert.equal(call!.patch.indicatorTarget, "level");
  assert.equal(call!.patch.mode, "cross_down");
  // Nothing the request did not mention is touched.
  assert.equal(call!.patch.note, undefined);
  assert.equal(call!.patch.frequency, undefined);
  assert.equal(call!.patch.enabled, undefined);
});

test("each family's own fields are editable and land in the patch", async () => {
  const cases: Array<[ConditionKind, Record<string, unknown>, Record<string, unknown>]> = [
    ["price", { targetPrice: 70000, priceDirection: "cross_down" },
      { targetPrice: 70000, priceDirection: "cross_down" }],
    ["ma", { maType: "sma", maLength: 50, mode: "cross_up" },
      { maType: "sma", maLength: 50, mode: "cross_up" }],
    ["ma_vs_ma", { ma2Length: 100 }, { maLength: 50, ma2Length: 100, ma2Type: "sma" }],
    ["sr_zone", { srSide: "resistance", pivotLength: 12, invalidation: "close" },
      { srSide: "resistance", srPivotLength: 12, srInvalidation: "close" }],
    ["pivot_level", { pivotType: "Fibonacci", levelName: "S1", anchor: "1d" },
      { pivotType: "Fibonacci", pivotLevelName: "S1", pivotAnchor: "1d" }],
    ["rsi", { target: "sma", rsiMaLength: 21 },
      { indicatorTarget: "sma", rsiMaLength: 21, rsiLength: 14 }],
    ["macd", { macdFast: 12, macdSlow: 26, macdSignal: 9, target: "signal" },
      { macdFast: 12, macdSlow: 26, macdSignal: 9, indicatorTarget: "signal" }],
  ];
  for (const [kind, body, expected] of cases) {
    const { status, call } = await patch(body, ROWS[kind]);
    assert.equal(status, 200, `${kind}: ${JSON.stringify(body)}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(
        (call!.patch as Record<string, unknown>)[key], value, `${kind}.${key}`
      );
    }
  }
});

test("common fields are editable on every family", async () => {
  for (const kind of CONDITION_KINDS) {
    const { status, call } = await patch(
      { symbol: "ethusdt", timeframe: "4h", frequency: "once_only", cooldownMin: 0,
        note: "revised", enabled: false },
      ROWS[kind]
    );
    assert.equal(status, 200, kind);
    assert.equal(call!.patch.symbol, "ETHUSDT", `${kind}: symbol is normalised`);
    assert.equal(call!.patch.timeframe, "4h");
    assert.equal(call!.patch.frequency, "once_only");
    assert.equal(call!.patch.cooldownMin, 0);
    assert.equal(call!.patch.note, "revised");
    assert.equal(call!.patch.enabled, false);
  }
});

test("the alert's family cannot be changed", async () => {
  const { status, body } = await patch({ conditionKind: "macd" }, ROWS.rsi);
  assert.equal(status, 400);
  assert.match(String(body.error), /type cannot be changed/);
  // Naming its own kind is a harmless no-op, not an error.
  assert.equal((await patch({ conditionKind: "rsi", rsiLevel: 40 }, ROWS.rsi)).status, 200);
});

test("runner and delivery state are refused rather than ignored", async () => {
  for (const field of [
    "lastSide", "lastFiredAt", "lastFiredBarTime", "lastBarTime", "completedAt",
    "createdAt", "updatedAt", "id",
  ]) {
    const { status, body } = await patch({ [field]: "2026-01-01T00:00:00Z" }, ROWS.rsi);
    assert.equal(status, 400, field);
    assert.match(String(body.error), /maintained by the alert runner/);
  }
});

test("a field belonging to another family is refused, not dropped", async () => {
  const { status, body } = await patch({ rsiLevel: 40 }, ROWS.macd);
  assert.equal(status, 400);
  assert.match(String(body.error), /not editable on a macd alert/);
});

test("invalid family values are refused by the same rules creation uses", async () => {
  const cases: Array<[ConditionKind, Record<string, unknown>, RegExp]> = [
    ["price", { targetPrice: 0 }, /positive number/],
    ["price", { priceDirection: "sideways" }, /priceDirection must be one of/],
    ["ma", { maLength: 0 }, /between 1 and 1000/],
    ["ma", { maType: "wma" }, /maType must be sma or ema/],
    ["ma", { nearMinPct: 2, nearMaxPct: 1 }, /nearMaxPct must be greater/],
    ["ma_vs_ma", { ma2Type: "ema", ma2Length: 50 }, /must differ/],
    ["sr_zone", { pivotLength: 1 }, /between 2 and 100/],
    ["sr_zone", { srSide: "middle" }, /srSide must be one of/],
    ["sr_zone", { filterRsiLevel: 150 }, /between 0 and 100/],
    ["pivot_level", { pivotType: "Gann" }, /pivotType must be one of/],
    ["pivot_level", { pivotType: "Fibonacci", levelName: "R4" }, /has no level/],
    ["rsi", { rsiLevel: 150 }, /between 0 and 100/],
    ["rsi", { rsiLength: 0 }, /rsiLength must be an integer/],
    ["rsi", { mode: "touch" }, /cross_up or cross_down/],
    ["macd", { macdFast: 30 }, /macdFast must be less than macdSlow/],
    ["macd", { target: "histogram" }, /target must be one of/],
  ];
  for (const [kind, body, error] of cases) {
    const result = await patch(body, ROWS[kind]);
    assert.equal(result.status, 400, `${kind} ${JSON.stringify(body)}`);
    assert.match(String(result.body.error), error, `${kind} ${JSON.stringify(body)}`);
    assert.equal(result.call, null, "a refused edit must not reach the repository");
  }
});

test("invalid common values are refused", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ symbol: "BTC/USDT" }, /2-24 uppercase/],
    [{ timeframe: "7m" }, /invalid timeframe/],
    [{ frequency: "hourly" }, /frequency must be one of/],
    [{ cooldownMin: -5 }, /non-negative integer/],
  ];
  for (const [body, error] of cases) {
    const result = await patch(body, ROWS.rsi);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(String(result.body.error), error);
  }
});

test("the cross memory is cleared only when the reference moves", async () => {
  // Same reference, different direction: the side already recorded is still
  // the truth, so it is kept.
  assert.equal((await patch({ mode: "cross_up" }, ROWS.rsi)).call!.patch.resetLastSide, false);
  assert.equal((await patch({ note: "x" }, ROWS.rsi)).call!.patch.resetLastSide, false);
  assert.equal(
    (await patch({ frequency: "once_per_minute" }, ROWS.rsi)).call!.patch.resetLastSide, false
  );
  // A different level, series or symbol is a different comparison, so the
  // stored side would manufacture a cross on the next bar.
  assert.equal((await patch({ rsiLevel: 30 }, ROWS.rsi)).call!.patch.resetLastSide, true);
  assert.equal((await patch({ timeframe: "4h" }, ROWS.rsi)).call!.patch.resetLastSide, true);
  assert.equal((await patch({ symbol: "ETHUSDT" }, ROWS.rsi)).call!.patch.resetLastSide, true);
  assert.equal((await patch({ maLength: 100 }, ROWS.ma)).call!.patch.resetLastSide, true);
  assert.equal((await patch({ targetPrice: 1 }, ROWS.price)).call!.patch.resetLastSide, true);
  // The approach band is not the reference: it changes when the alert fires,
  // not which side of the line price is on.
  assert.equal(
    (await patch({ nearMinPct: 0.1, nearMaxPct: 0.4 }, ROWS.ma)).call!.patch.resetLastSide, false
  );
});

test("pausing writes only `enabled`, never the condition columns", async () => {
  const { status, call } = await patch({ enabled: false }, ROWS.sr_zone);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(call!.patch).sort(), ["enabled", "resetLastSide"]);
  assert.equal(call!.patch.enabled, false);
  assert.equal(call!.patch.resetLastSide, false);
});

test("a missing or malformed id is refused before the repository is asked to write", async () => {
  assert.equal((await patch({ note: "x" }, null)).status, 404);
  const malformed = await patch({ note: "x" }, ROWS.rsi, { id: "not-a-uuid" });
  assert.equal(malformed.status, 400);
  assert.match(String(malformed.body.error), /must be a UUID/);
});

test("an edit that collides with an existing alert is a conflict, not a merge", async () => {
  const { status, body } = await patch({ rsiLevel: 40 }, ROWS.rsi, { conflict: true });
  assert.equal(status, 409);
  assert.match(String(body.error), /already watches exactly this condition/);
});

test("every family exposes at least one editable field", () => {
  for (const kind of CONDITION_KINDS) {
    assert.ok(
      EDITABLE_CONDITION_FIELDS[kind].length > 0,
      `${kind} would open an editor with nothing in it`
    );
  }
});
