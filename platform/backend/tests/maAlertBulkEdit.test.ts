/**
 * Editing many alerts with one patch.
 *
 * The properties that matter, and that a naive loop gets wrong:
 *
 *  - nothing is written until every row has been planned, so a refusal costs
 *    nothing and the caller never has to work out which half landed;
 *  - a field belonging to one family is refused on a mixed selection, and the
 *    refusal says which alert refused it;
 *  - a patch that would make two SELECTED alerts identical is caught before the
 *    write, not by a unique-index violation halfway through;
 *  - gates replace rather than merge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { bulkEditHandler } from "../src/api/routes/maAlerts";
import type { MaAlertRow } from "../src/types/maAlerts";
import type { MaAlertPatch } from "../src/repositories/maAlerts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const ROW = (over: Partial<MaAlertRow> & { id: string }): MaAlertRow => ({
  symbol: "BTCUSDT", canonicalInstrumentId: null, providerId: null, priceBasis: null,
  timeframe: "1h", conditionKind: "ma",
  maType: "ema", maLength: 200, mode: "cross_up", ma2Type: null, ma2Length: null,
  targetPrice: null, priceDirection: null, patternId: null,
  patternDetectorId: null, patternDetectorVersion: null,
  patternSettingsHash: null, patternSettings: null,
  srSide: null, srPivotLength: null, srInvalidation: null,
  pivotType: null, pivotLevelName: null, pivotAnchor: null,
  rsiLength: null, rsiLevel: null, rsiMaLength: null,
  macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: null,
  stPeriod: null, stMultiplier: null, stAtrMethod: null,
  bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
  stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
  adxDiLength: null, adxSmoothing: null, adxLevel: null,
  filters: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null, filterStAtrMethod: null, filterStSide: null,
  nearMinPct: 0.2, nearMaxPct: 0.5,
  enabled: true, frequency: "once_per_bar_close", cooldownMin: 60, note: null,
  lastSide: null, lastBarTime: null, lastFiredAt: null, completedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
} as MaAlertRow);

async function request(body: Record<string, unknown>, rows: MaAlertRow[]) {
  const writes: { id: string; patch: MaAlertPatch }[] = [];
  const app = Fastify({ logger: false });
  app.post("/api/ma-alerts/bulk-edit", bulkEditHandler({
    getAlert: async (id) => rows.find((r) => r.id === id) ?? null,
    updateAlert: async (id, patch) => {
      writes.push({ id, patch });
      return rows.find((r) => r.id === id) ?? null;
    },
  }));
  const response = await app.inject({
    method: "POST", url: "/api/ma-alerts/bulk-edit", payload: body,
  });
  await app.close();
  return { response, writes };
}

test("one patch reaches every selected alert", async () => {
  const rows = [ROW({ id: A }), ROW({ id: B, timeframe: "4h" })];
  const { response, writes } = await request(
    { ids: [A, B], patch: { cooldownMin: 15 } }, rows
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(writes.length, 2);
  for (const w of writes) assert.equal(w.patch.cooldownMin, 15);
});

test("nothing is written when any row refuses the patch", async () => {
  // `rsiLevel` belongs to the RSI family. The MA alert in this selection cannot
  // take it, and the MACD one cannot either — so the whole request refuses.
  const rows = [ROW({ id: A }), ROW({ id: B, conditionKind: "rsi", rsiLength: 14, rsiLevel: 70, indicatorTarget: "level" })];
  const { response, writes } = await request(
    { ids: [A, B], patch: { rsiLevel: 60 } }, rows
  );
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /BTCUSDT 1h \(ma\)/, "the refusal names the alert");
  assert.equal(writes.length, 0, "a refused bulk edit must write nothing at all");
});

test("a patch that would make two selected alerts identical is refused", async () => {
  // Two alerts that differ ONLY by their gates, given the same gates. Without
  // the dry run this is a unique-index violation after the first write.
  const rows = [
    ROW({ id: A, filters: [{ kind: "rsi", length: 50, level: 50, side: "above" }] }),
    ROW({ id: B, filters: [{ kind: "rsi", length: 14, level: 30, side: "below" }] }),
  ];
  const { response, writes } = await request(
    { ids: [A, B], patch: { filters: [{ kind: "ma", type: "ema", length: 200, side: "above" }] } },
    rows
  );
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /two selected alerts identical/);
  assert.equal(writes.length, 0);
});

test("the same gates on alerts that still differ elsewhere is allowed", async () => {
  // Same patch as above, but the two alerts are on different timeframes — so
  // they stay distinct and the edit is legitimate.
  const rows = [
    ROW({ id: A, filters: [{ kind: "rsi", length: 50, level: 50, side: "above" }] }),
    ROW({ id: B, timeframe: "4h", filters: [{ kind: "rsi", length: 14, level: 30, side: "below" }] }),
  ];
  const { response, writes } = await request(
    { ids: [A, B], patch: { filters: [{ kind: "ma", type: "ema", length: 200, side: "above" }] } },
    rows
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(writes.length, 2);
});

test("gates REPLACE rather than merge", async () => {
  const rows = [ROW({
    id: A,
    filters: [{ kind: "rsi", length: 50, level: 50, side: "above" }],
  })];
  const { response, writes } = await request(
    { ids: [A], patch: { filters: [{ kind: "macd", fastLength: 12, slowLength: 26, signalLength: 9, target: "signal", side: "above" }] } },
    rows
  );
  assert.equal(response.statusCode, 200, response.body);
  const written = writes[0]!.patch.filters as unknown[];
  assert.equal(written.length, 1, "the old gate must not survive alongside the new one");
  assert.equal((written[0] as { kind: string }).kind, "macd");
});

test("an empty gate list removes the gates", async () => {
  const rows = [ROW({
    id: A, filters: [{ kind: "rsi", length: 50, level: 50, side: "above" }],
  })];
  const { response, writes } = await request({ ids: [A], patch: { filters: [] } }, rows);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(writes[0]!.patch.filters, null);
});

test("a missing alert stops the whole edit", async () => {
  const { response, writes } = await request(
    { ids: [A, B], patch: { cooldownMin: 15 } }, [ROW({ id: A })]
  );
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json().missingIds, [B]);
  assert.equal(writes.length, 0);
});

test("malformed requests are refused before anything is read", async () => {
  for (const [body, re] of [
    [{ patch: { cooldownMin: 1 } }, /ids must be a non-empty array/],
    [{ ids: [], patch: { cooldownMin: 1 } }, /must not be empty/],
    [{ ids: ["nope"], patch: { cooldownMin: 1 } }, /must be a UUID/],
    [{ ids: [A] }, /patch must be an object/],
    [{ ids: [A], patch: {} }, /at least one field/],
    [{ ids: [A], patch: [] }, /patch must be an object/],
  ] as const) {
    const { response, writes } = await request(body as Record<string, unknown>, [ROW({ id: A })]);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.match(response.json().error, re);
    assert.equal(writes.length, 0);
  }
});

test("ids are deduplicated, so one alert is not written twice", async () => {
  const { response, writes } = await request(
    { ids: [A, A], patch: { cooldownMin: 15 } }, [ROW({ id: A })]
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(writes.length, 1);
});
