import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import {
  effectiveShariahStatus, assertValidShariahRecordInput, isClassification, isLifecycle, isPolicyVersion,
} from "../src/shariah/policy";
import {
  qualifyingBaseAssets, syncShariahUniverse, type BinanceSpotSymbolMeta, type ShariahDbClient,
} from "../src/shariah/sync";

/**
 * In-memory stand-in for the three shariah_* tables, mirroring the exact
 * queries src/shariah/sync.ts issues. There is no Postgres test database
 * available in this environment (tests/test.env points at 127.0.0.1:5433,
 * which nothing is listening on here) — this fake is what lets the sync
 * boundary's idempotency/discovery/delisting behavior be verified without one.
 */
class FakeShariahDb implements ShariahDbClient {
  nextAssetId = 1;
  assets = new Map<string, { projectName: string | null }>(); // assetId -> row
  mappings = new Map<string, { assetId: string; binanceAvailable: boolean }>(); // baseAsset -> row
  records = new Map<string, { classification: string; lifecycle: string; policyVersion: string }>(); // assetId -> row

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const one = (rows: QueryResultRow[]): QueryResult<T> =>
      ({ rows: rows as T[], rowCount: rows.length, command: "", oid: 0, fields: [] });

    if (sql.startsWith("SELECT asset_id, binance_available FROM shariah_asset_binance_mappings")) {
      const row = this.mappings.get(String(values[0]));
      return one(row ? [{ asset_id: row.assetId, binance_available: row.binanceAvailable }] : []);
    }
    if (sql.startsWith("UPDATE shariah_asset_binance_mappings SET binance_available = true")) {
      const baseAsset = String(values[0]);
      const row = this.mappings.get(baseAsset);
      if (row) row.binanceAvailable = true;
      return one([]);
    }
    if (sql.startsWith("INSERT INTO shariah_assets DEFAULT VALUES")) {
      const assetId = String(this.nextAssetId++);
      this.assets.set(assetId, { projectName: null });
      return one([{ asset_id: assetId }]);
    }
    if (sql.startsWith("INSERT INTO shariah_asset_binance_mappings")) {
      const [assetId, baseAsset] = values as [string, string];
      this.mappings.set(baseAsset, { assetId, binanceAvailable: true });
      return one([]);
    }
    if (sql.startsWith("INSERT INTO shariah_records")) {
      const [assetId] = values as [string];
      if (!this.records.has(assetId)) {
        this.records.set(assetId, { classification: "REVIEW", lifecycle: "UNSCREENED", policyVersion: "TS_SHARIAH_V1" });
      }
      return one([]);
    }
    if (sql.startsWith("UPDATE shariah_asset_binance_mappings SET binance_available = false")) {
      const [qualifying] = values as [string[]];
      const stillQualifying = new Set(qualifying);
      const deactivated: { base_asset: string }[] = [];
      for (const [baseAsset, row] of this.mappings) {
        if (row.binanceAvailable && !stillQualifying.has(baseAsset)) {
          row.binanceAvailable = false;
          deactivated.push({ base_asset: baseAsset });
        }
      }
      return one(deactivated);
    }
    if (sql.startsWith("UPDATE shariah_records SET lifecycle = 'STALE'")) {
      const [assetId] = values as [string];
      const record = this.records.get(assetId);
      if (record && record.lifecycle === "SCREENED") record.lifecycle = "STALE";
      return one([]);
    }
    throw new Error(`FakeShariahDb: unhandled query: ${sql}`);
  }
}

const sym = (over: Partial<BinanceSpotSymbolMeta>): BinanceSpotSymbolMeta => ({
  symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", ...over,
});

test("qualifying Spot USDT symbols supported by Trading Scene are admitted", () => {
  const bases = qualifyingBaseAssets(
    [sym({ symbol: "BTCUSDT", baseAsset: "BTC" })],
    new Set(["BTCUSDT"])
  );
  assert.deepEqual(bases, ["BTC"]);
});

test("non-TRADING status symbols are not admitted", () => {
  const bases = qualifyingBaseAssets(
    [sym({ symbol: "BTCUSDT", baseAsset: "BTC", status: "BREAK" })],
    new Set(["BTCUSDT"])
  );
  assert.deepEqual(bases, []);
});

test("symbols Trading Scene does not support are not admitted", () => {
  const bases = qualifyingBaseAssets(
    [sym({ symbol: "XYZUSDT", baseAsset: "XYZ" })],
    new Set(["BTCUSDT"])
  );
  assert.deepEqual(bases, []);
});

test("non-USDT quote symbols are not admitted", () => {
  const bases = qualifyingBaseAssets(
    [sym({ symbol: "ETHBTC", baseAsset: "ETH", quoteAsset: "BTC" })],
    new Set(["ETHBTC"])
  );
  assert.deepEqual(bases, []);
});

test("multiple qualifying symbols for one base asset reduce to a single base asset", () => {
  const bases = qualifyingBaseAssets(
    [sym({ symbol: "BTCUSDT", baseAsset: "BTC" }), sym({ symbol: "BTCUSDT", baseAsset: "BTC" })],
    new Set(["BTCUSDT"])
  );
  assert.deepEqual(bases, ["BTC"]);
});

test("a newly discovered asset is created UNSCREENED and effectively REVIEW", async () => {
  const db = new FakeShariahDb();
  const result = await syncShariahUniverse(db, ["BTC"]);
  assert.deepEqual(result.created, ["BTC"]);

  const mapping = db.mappings.get("BTC")!;
  const record = db.records.get(mapping.assetId)!;
  assert.equal(record.lifecycle, "UNSCREENED");
  assert.equal(record.classification, "REVIEW");
  assert.equal(
    effectiveShariahStatus({ classification: record.classification as never, lifecycle: record.lifecycle as never }),
    "REVIEW"
  );
});

test("repeated sync with identical input is idempotent: no duplicate assets or mappings", async () => {
  const db = new FakeShariahDb();
  const first = await syncShariahUniverse(db, ["BTC", "ETH"]);
  assert.deepEqual(first.created.sort(), ["BTC", "ETH"]);
  const btcAssetId = db.mappings.get("BTC")!.assetId;

  const second = await syncShariahUniverse(db, ["BTC", "ETH"]);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.reactivated, []);
  assert.equal(db.assets.size, 2);
  assert.equal(db.mappings.get("BTC")!.assetId, btcAssetId);
});

test("delisting marks availability inactive without deleting asset or Shariah history", async () => {
  const db = new FakeShariahDb();
  await syncShariahUniverse(db, ["BTC", "ETH"]);
  const ethAssetId = db.mappings.get("ETH")!.assetId;

  const result = await syncShariahUniverse(db, ["BTC"]);
  assert.deepEqual(result.deactivated, ["ETH"]);
  assert.equal(db.mappings.get("ETH")!.binanceAvailable, false);
  assert.ok(db.assets.has(ethAssetId), "asset row must survive delisting");
  assert.ok(db.records.has(ethAssetId), "Shariah record must survive delisting");

  const relisted = await syncShariahUniverse(db, ["BTC", "ETH"]);
  assert.deepEqual(relisted.created, []);
  assert.deepEqual(relisted.reactivated, ["ETH"]);
  assert.equal(db.mappings.get("ETH")!.assetId, ethAssetId, "relisting must reuse the stable asset_id");
});

test("ticker reuse fails closed: reactivating a delisted base symbol demotes a SCREENED record to STALE, never silently ELIGIBLE", async () => {
  const db = new FakeShariahDb();
  await syncShariahUniverse(db, ["XYZ"]);
  const assetId = db.mappings.get("XYZ")!.assetId;
  db.records.set(assetId, { classification: "ELIGIBLE", lifecycle: "SCREENED", policyVersion: "TS_SHARIAH_V1" });

  await syncShariahUniverse(db, []); // delisted
  assert.equal(db.records.get(assetId)!.lifecycle, "SCREENED", "delisting alone must not touch a published classification");

  // Binance later lists a genuinely unrelated project under the same base symbol.
  const reused = await syncShariahUniverse(db, ["XYZ"]);
  assert.deepEqual(reused.reactivated, ["XYZ"]);
  assert.equal(db.mappings.get("XYZ")!.assetId, assetId, "SH-1 v1 does not distinguish ticker reuse from the same project returning");
  assert.equal(db.records.get(assetId)!.lifecycle, "STALE", "reactivation after a delist must force re-review, not keep the old published classification");
  const record = db.records.get(assetId)!;
  assert.equal(
    effectiveShariahStatus({ classification: record.classification as "ELIGIBLE", lifecycle: record.lifecycle as "STALE" }),
    "REVIEW",
    "a reused ticker must never silently resolve to the prior project's ELIGIBLE status"
  );
});

test("UNSCREENED and STALE never resolve to ELIGIBLE even if a stray classification value is stored", () => {
  assert.equal(effectiveShariahStatus({ classification: "ELIGIBLE", lifecycle: "UNSCREENED" }), "REVIEW");
  assert.equal(effectiveShariahStatus({ classification: "ELIGIBLE", lifecycle: "STALE" }), "REVIEW");
  assert.equal(effectiveShariahStatus(null), "REVIEW");
});

test("a SCREENED record resolves to its published classification", () => {
  assert.equal(effectiveShariahStatus({ classification: "ELIGIBLE", lifecycle: "SCREENED" }), "ELIGIBLE");
  assert.equal(effectiveShariahStatus({ classification: "EXCLUDED", lifecycle: "SCREENED" }), "EXCLUDED");
  assert.equal(effectiveShariahStatus({ classification: "REVIEW", lifecycle: "SCREENED" }), "REVIEW");
});

test("invalid classification/lifecycle/policy_version/category values are rejected", () => {
  assert.throws(() => assertValidShariahRecordInput({
    classification: "HALAL", lifecycle: "UNSCREENED", policyVersion: "TS_SHARIAH_V1",
  }));
  assert.throws(() => assertValidShariahRecordInput({
    classification: "REVIEW", lifecycle: "PENDING", policyVersion: "TS_SHARIAH_V1",
  }));
  assert.throws(() => assertValidShariahRecordInput({
    classification: "REVIEW", lifecycle: "UNSCREENED", policyVersion: "TS_SHARIAH_V2",
  }));
  assert.throws(() => assertValidShariahRecordInput({
    classification: "EXCLUDED", lifecycle: "SCREENED", policyVersion: "TS_SHARIAH_V1",
    reason: "x", prohibitedCategories: ["MEME_COIN"],
  }));
  assert.ok(!isClassification("HALAL"));
  assert.ok(!isLifecycle("PENDING"));
  assert.ok(!isPolicyVersion("TS_SHARIAH_V2"));
});

test("a published EXCLUDED classification requires a reason and a prohibited category", () => {
  assert.throws(() => assertValidShariahRecordInput({
    classification: "EXCLUDED", lifecycle: "SCREENED", policyVersion: "TS_SHARIAH_V1",
  }), /reason/);
  assert.throws(() => assertValidShariahRecordInput({
    classification: "EXCLUDED", lifecycle: "SCREENED", policyVersion: "TS_SHARIAH_V1", reason: "x",
  }), /prohibited category/);
  assert.doesNotThrow(() => assertValidShariahRecordInput({
    classification: "EXCLUDED", lifecycle: "SCREENED", policyVersion: "TS_SHARIAH_V1",
    reason: "Directly issues interest-bearing lending products.",
    prohibitedCategories: ["RIBA_INTEREST_BASED_FINANCE"],
  }));
});
