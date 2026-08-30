/**
 * EXISTING ALERTS MIGRATE TO once_per_bar_close, UNCHANGED.
 *
 * ── What this test can and cannot prove ────────────────────────────────────
 *
 * No PostgreSQL server is available in this workspace, so the migration has NOT
 * been executed and this is not an execution test. What it pins is the property
 * the migration's safety rests on and which a later edit could silently reverse:
 * every column an existing row gains is added with a default that describes what
 * that row already did, so applying 010 cannot change any alert's behaviour.
 *
 * Executing 010 against a populated database remains outstanding, and is
 * recorded as such in docs/REMEDIATION-LEDGER.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ALERT_FREQUENCY, ALERT_FREQUENCIES } from "../src/alerts/alertFrequency";
import { CONDITION_KINDS, PRICE_DIRECTIONS } from "../src/types/maAlerts";

const MIGRATIONS = path.join(__dirname, "..", "src", "db", "migrations");
const sql = fs.readFileSync(path.join(MIGRATIONS, "010_alert_frequencies.sql"), "utf8");
/** Whitespace-insensitive, so reformatting the SQL does not fail the test. */
const flat = sql.replace(/\s+/g, " ");

test("frequency arrives with the bar-close default, so no existing alert speeds up", () => {
  assert.match(
    flat,
    /ADD COLUMN IF NOT EXISTS frequency text NOT NULL DEFAULT 'once_per_bar_close'/
  );
  assert.equal(DEFAULT_ALERT_FREQUENCY, "once_per_bar_close",
    "the code default and the migration default must be the same value");
});

test("condition_kind defaults to 'ma' — every existing row IS a moving-average alert", () => {
  assert.match(flat, /ADD COLUMN IF NOT EXISTS condition_kind text NOT NULL DEFAULT 'ma'/);
});

test("every new column is either nullable or defaulted, so the backfill cannot fail", () => {
  const added = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+) ([^,;\n]+)/g)];
  assert.ok(added.length >= 8, `expected the new columns, found ${added.length}`);
  for (const [, name, rest] of added) {
    if (/NOT NULL/.test(rest!)) {
      assert.match(rest!, /DEFAULT/, `${name} is NOT NULL with no default — the backfill would fail`);
    }
  }
});

test("the MA columns become nullable, because a price alert names no moving average", () => {
  for (const col of ["ma_type", "ma_length", "mode"]) {
    assert.match(flat, new RegExp(`ALTER COLUMN ${col} DROP NOT NULL`));
  }
});

test("the CHECK vocabularies match the code exactly", () => {
  // The EFFECTIVE vocabulary, not 010's. A later migration may widen a CHECK —
  // `condition_kind` gained two kinds in 015 — so the last definition across
  // the whole migration set is what the database actually enforces.
  const quoted = (v: readonly string[]): string => v.map((s) => `'${s}'`).join(",");
  const allSql = fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql")).sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8"))
    .join("\n")
    .replace(/\s+/g, " ")
    .replace(/,\s+/g, ",");

  const lastVocabulary = (column: string): string | null => {
    const hits = [...allSql.matchAll(new RegExp(`${column} IN \\(([^)]*)\\)`, "g"))];
    return hits.length ? hits[hits.length - 1]![1]!.trim() : null;
  };

  assert.equal(lastVocabulary("frequency"), quoted(ALERT_FREQUENCIES));
  assert.equal(lastVocabulary("condition_kind"), quoted(CONDITION_KINDS));
  assert.equal(lastVocabulary("price_direction"), quoted(PRICE_DIRECTIONS));
});

test("a half-specified row cannot be stored for any kind", () => {
  // An alert missing the columns its own kind needs would be accepted, then
  // silently never fire — the worst failure mode an alert has.
  assert.match(flat, /CONSTRAINT ma_alerts_shape_ck CHECK \(/);
  assert.match(flat, /condition_kind = 'price' AND target_price IS NOT NULL AND target_price > 0 AND price_direction IS NOT NULL/);
  assert.match(flat, /NOT \(ma_type = ma2_type AND ma_length = ma2_length\)/);
});

test("uniqueness is preserved per kind — re-arming edits, it never duplicates", () => {
  assert.match(flat, /DROP INDEX IF EXISTS ma_alerts_unique/);
  for (const idx of ["ma_alerts_ma_unique", "ma_alerts_price_unique", "ma_alerts_ma2_unique"]) {
    assert.match(flat, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx}`));
  }
  // The MA key is byte-for-byte the one 007 used, so an existing pair of alerts
  // that coexisted then still coexists now.
  assert.match(flat, /ma_alerts_ma_unique ON ma_alerts \(symbol, timeframe, ma_type, ma_length, mode\)/);
});

test("a retired once_only alert leaves the runner's feed set", () => {
  assert.match(flat, /ma_alerts_feed_idx ON ma_alerts \(symbol, timeframe\) WHERE enabled AND completed_at IS NULL/);
});

test("every constraint is added idempotently, so a re-run cannot fail the boot", () => {
  const constraints = [...sql.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]!);
  assert.ok(constraints.length > 0);
  for (const name of constraints) {
    assert.match(
      flat,
      new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_constraint WHERE conname = '${name}'\\)`),
      `${name} is added without an existence guard`
    );
  }
});

test("the migration is additive: it drops no column and no table", () => {
  assert.doesNotMatch(flat, /DROP COLUMN|DROP TABLE|TRUNCATE|DELETE FROM/);
});

test("migration filenames stay ordered and unique — they are applied by sort order", () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const numbers = files.map((f) => f.slice(0, 3));
  assert.deepEqual(numbers, [...new Set(numbers)], "two migrations share a number");
  // Contiguous from 001, so sort order is application order with no gap that
  // would let a later migration run before an earlier one on a fresh database.
  assert.deepEqual(
    numbers,
    numbers.map((_, i) => String(i + 1).padStart(3, "0")),
    "migration numbers must be contiguous from 001"
  );
  // This suite is about 010 specifically; pin its position rather than the end
  // of the list, so adding a migration does not require editing this test.
  assert.equal(files[9], "010_alert_frequencies.sql");
});
