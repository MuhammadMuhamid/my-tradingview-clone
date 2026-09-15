/**
 * Editing many alerts with one change.
 *
 * "Every 15m support alert, all at once" — add a MACD gate to all of them,
 * change their cadence, put one note on each.
 *
 * The property this file exists to pin: **validate everything, then write
 * anything**. A bulk edit that writes until it hits a bad row leaves the user
 * with a set that is half changed and no way to tell which half. So every
 * selected row is planned first, and any refusal fails the whole request with
 * nothing written.
 *
 * The rules themselves are NOT re-implemented here — `planAlertPatch` is the
 * same function the single-alert route uses, so a field refused on one alert
 * is refused on a hundred, by construction rather than by agreement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { bulkEditHandler, MAX_BULK_ALERTS } from "../src/api/routes/maAlerts";
import { AlertConflictError } from "../src/repositories/maAlerts";
import type { MaAlertRow } from "../src/types/maAlerts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const BASE: MaAlertRow = {
  id: A, symbol: "BTCUSDT", timeframe: "15m", conditionKind: "sr_zone",
  maType: null, maLength: null, mode: "near_above", ma2Type: null, ma2Length: null,
  targetPrice: null, priceDirection: null,
  srSide: "support", srPivotLength: 15, srInvalidation: "close",
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
  filters: [],
  nearMinPct: 0.2, nearMaxPct: 0.5, enabled: true,
  frequency: "once_per_bar_close", cooldownMin: 0, note: null,
  lastSide: "below", lastFiredAt: null, lastFiredBarTime: null,
  lastBarTime: null, completedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};

const sr = (id: string, symbol: string): MaAlertRow => ({ ...BASE, id, symbol });
const rsiRow = (id: string): MaAlertRow => ({
  ...BASE, id, symbol: "XRPUSDT", conditionKind: "rsi",
  srSide: null, srPivotLength: null, srInvalidation: null,
  rsiLength: 14, rsiLevel: 70, rsiMaLength: 14,
  indicatorTarget: "level", mode: "cross_up",
});

interface Call { id: string; patch: Record<string, unknown> }

async function edit(
  body: Record<string, unknown>,
  rows: MaAlertRow[],
  onUpdate?: (id: string) => MaAlertRow | null | never,
) {
  const calls: Call[] = [];
  const app = Fastify({ logger: false });
  app.post("/api/ma-alerts/bulk-edit", bulkEditHandler({
    getAlert: async (id) => rows.find((r) => r.id === id) ?? null,
    listAlertsByIds: async (ids) => rows.filter((r) => ids.includes(r.id)),
    updateAlert: async (id, patch) => {
      calls.push({ id, patch: patch as Record<string, unknown> });
      if (onUpdate) return onUpdate(id);
      return rows.find((r) => r.id === id) ?? null;
    },
  }));
  const response = await app.inject({
    method: "POST", url: "/api/ma-alerts/bulk-edit", payload: body,
  });
  await app.close();
  return { response, calls };
}

// ── the happy path ─────────────────────────────────────────────────────────

test("one set of gates is applied to every selected alert", async () => {
  const rows = [sr(A, "BTCUSDT"), sr(B, "ETHUSDT"), sr(C, "SOLUSDT")];
  const { response, calls } = await edit({
    ids: [A, B, C],
    patch: {
      filters: [
        { kind: "macd", timeframe: "1h", side: "below" },
        { kind: "macd", timeframe: "4h", side: "above" },
      ],
    },
  }, rows);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { updatedIds: [A, B, C], updated: 3 });
  assert.equal(calls.length, 3, "one write per alert");
  for (const call of calls) {
    const filters = call.patch.filters as Array<Record<string, unknown>>;
    assert.equal(filters.length, 2);
    assert.equal(filters[0]!.timeframe, "1h");
    assert.equal(filters[0]!.side, "below");
    assert.equal(filters[1]!.side, "above");
  }
});

test("ids are deduplicated, so a double-selected row is written once", async () => {
  const { calls } = await edit(
    { ids: [A, A, B], patch: { cooldownMin: 30 } }, [sr(A, "BTCUSDT"), sr(B, "ETHUSDT")]
  );
  assert.deepEqual(calls.map((c) => c.id), [A, B]);
});

test("only the named fields are written; the rest of the condition is restated", async () => {
  const { calls } = await edit(
    { ids: [A], patch: { frequency: "once_per_bar" } }, [sr(A, "BTCUSDT")]
  );
  assert.equal(calls[0]!.patch.frequency, "once_per_bar");
  assert.equal(calls[0]!.patch.note, undefined, "a field nobody named is not written");
});

// ── validate everything, then write anything ───────────────────────────────

test("a field foreign to ONE selected alert fails the whole request, writing nothing", async () => {
  const rows = [sr(A, "BTCUSDT"), sr(B, "ETHUSDT"), rsiRow(C)];
  const { response, calls } = await edit(
    { ids: [A, B, C], patch: { srSide: "resistance" } }, rows
  );

  assert.equal(response.statusCode, 400);
  assert.equal(calls.length, 0, "NOTHING was written — not even the two rows that would have passed");
  const body = response.json();
  assert.match(String(body.error), /do not apply to 1 of the 3 selected alerts/);
  assert.equal(body.rejectedCount, 1);
  assert.equal(body.rejected[0].id, C);
  assert.equal(body.rejected[0].kind, "rsi");
  assert.match(String(body.rejected[0].reason), /not editable on a rsi alert/);
  assert.deepEqual(body.updatedIds, []);
});

test("an unsatisfiable condition is refused before any alert moves", async () => {
  const rows = [sr(A, "BTCUSDT"), sr(B, "ETHUSDT")];
  const { response, calls } = await edit({
    ids: [A, B],
    // Two identical gates are the same question twice — the create route
    // refuses it, so an edit must too.
    patch: {
      filters: [
        { kind: "macd", timeframe: "1h", side: "above" },
        { kind: "macd", timeframe: "1h", side: "above" },
      ],
    },
  }, rows);
  assert.equal(response.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.match(String(response.json().rejected[0].reason), /identical/);
});

test("the alert family can never be part of a bulk patch", async () => {
  const { response, calls } = await edit(
    { ids: [A], patch: { conditionKind: "rsi" } }, [sr(A, "BTCUSDT")]
  );
  assert.equal(response.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.match(String(response.json().rejected[0].reason), /type cannot be changed/);
});

test("runner-owned state is refused, not silently dropped", async () => {
  for (const field of ["lastFiredAt", "lastSide", "completedAt"]) {
    const { response, calls } = await edit(
      { ids: [A], patch: { [field]: null } }, [sr(A, "BTCUSDT")]
    );
    assert.equal(response.statusCode, 400, field);
    assert.equal(calls.length, 0, field);
  }
});

// ── shape of the request ───────────────────────────────────────────────────

test("an empty patch is refused rather than reported as a successful no-op", async () => {
  const { response } = await edit({ ids: [A], patch: {} }, [sr(A, "BTCUSDT")]);
  assert.equal(response.statusCode, 400);
  assert.match(String(response.json().error), /at least one field/);
});

test("malformed and oversized requests are refused", async () => {
  const rows = [sr(A, "BTCUSDT")];
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ patch: { cooldownMin: 1 } }, /ids must be a non-empty array/],
    [{ ids: [], patch: { cooldownMin: 1 } }, /must not be empty/],
    [{ ids: ["not-a-uuid"], patch: { cooldownMin: 1 } }, /must be a UUID/],
    [{ ids: [A] }, /patch must be an object/],
    [{ ids: [A], patch: [] }, /patch must be an object/],
    [{ ids: Array.from({ length: MAX_BULK_ALERTS + 1 }, () => A), patch: { cooldownMin: 1 } },
      new RegExp(`at most ${MAX_BULK_ALERTS}`)],
  ];
  for (const [body, expected] of cases) {
    const { response } = await edit(body, rows);
    assert.equal(response.statusCode, 400, JSON.stringify(body).slice(0, 60));
    assert.match(String(response.json().error), expected);
  }
});

test("an id that no longer exists fails the request before anything is written", async () => {
  const { response, calls } = await edit(
    { ids: [A, B], patch: { cooldownMin: 5 } }, [sr(A, "BTCUSDT")]
  );
  assert.equal(response.statusCode, 409);
  assert.equal(calls.length, 0);
  assert.deepEqual(response.json().missingIds, [B]);
});

// ── the failure that validation cannot prevent ─────────────────────────────

test("a conflict mid-write reports which alerts were already changed", async () => {
  /*
   * The writes are per row, not one transaction, so a unique-index conflict
   * can still appear once earlier rows have moved. It cannot be prevented
   * here — but a caller that believed the whole set moved would be wrong about
   * the ones that did not, so the ids that landed are named.
   */
  const rows = [sr(A, "BTCUSDT"), sr(B, "ETHUSDT"), sr(C, "SOLUSDT")];
  const { response, calls } = await edit(
    { ids: [A, B, C], patch: { invalidation: "wick" } }, rows,
    (id) => { if (id === C) throw new AlertConflictError(); return rows.find((r) => r.id === id)!; }
  );
  assert.equal(response.statusCode, 409);
  assert.equal(calls.length, 3, "it stopped at the row that conflicted");
  const body = response.json();
  assert.deepEqual(body.updatedIds, [A, B]);
  assert.equal(body.failedId, C);
  assert.match(String(body.error), /2 of 3 alerts were already updated/);
});

// ── the collision the dry run can see ──────────────────────────────────────

test("a change that would merge two selected alerts is refused, not half applied", async () => {
  /*
   * Two alerts on the same line differing ONLY by their gates. Giving both the
   * same gates collapses them onto one unique key — the second write would
   * conflict AFTER the first had already been made. The dry run computes the
   * post-patch key from the same column list Postgres infers its arbiter index
   * from, so the whole request is refused with nothing written.
   */
  const rows = [
    { ...sr(A, "BTCUSDT"), filters: [{ kind: "macd", timeframe: "1h", side: "below" }] },
    { ...sr(B, "BTCUSDT"), filters: [{ kind: "rsi", timeframe: "4h", length: 50, level: 50, side: "above" }] },
  ] as MaAlertRow[];

  const { response, calls } = await edit({
    ids: [A, B],
    patch: { filters: [{ kind: "macd", timeframe: "4h", side: "above" }] },
  }, rows);

  assert.equal(response.statusCode, 400);
  assert.equal(calls.length, 0, "not one write — the first would have succeeded and been kept");
  assert.match(String(response.json().rejected[0].reason), /would make 2 of the selected alerts identical/);
});

test("alerts that stay distinct after the patch are untouched by that check", async () => {
  // Same gates, but different symbols — different keys, so no collision.
  const rows = [sr(A, "BTCUSDT"), sr(B, "ETHUSDT")];
  const { response, calls } = await edit({
    ids: [A, B],
    patch: { filters: [{ kind: "macd", timeframe: "4h", side: "above" }] },
  }, rows);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 2);
});
