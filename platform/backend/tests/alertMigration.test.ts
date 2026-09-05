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
  // 018 belongs to a concurrent mission while alert delivery observability was
  // explicitly assigned 019. Permit only that reserved integration gap on an
  // isolated mission branch; once 018 is present, this is contiguous again.
  const reservedConcurrent = new Set(["018"]);
  const lastNumber = Number(numbers[numbers.length - 1]);
  const throughLast = Array.from(
    { length: lastNumber }, (_, i) => String(i + 1).padStart(3, "0")
  );
  const missing = throughLast.filter((number) => !numbers.includes(number));
  assert.deepEqual(
    missing.filter((number) => !reservedConcurrent.has(number)),
    [],
    "migration numbers may omit only an explicitly reserved concurrent migration"
  );
  // This suite is about 010 specifically; pin its position rather than the end
  // of the list, so adding a migration does not require editing this test.
  assert.equal(files[9], "010_alert_frequencies.sql");
});

/**
 * The NULL-mode hole in `ma_alerts_shape_ck`.
 *
 * A CHECK constraint ACCEPTS a row when it evaluates to NULL. The constraint is
 * a chain of ORs, and 016 wrote each cross family's branch as
 * `condition_kind = 'x' AND mode IN ('cross_up','cross_down')` — so with a NULL
 * mode that branch is `TRUE AND NULL` = NULL, every other branch is FALSE, and
 * `FALSE OR NULL` is NULL. The row was stored by exactly the constraint written
 * to reject it.
 *
 * That row is the failure this table's shape rules exist to prevent:
 * `conditionFromRow` refuses to build a condition from it, so the runner logs
 * "alert row is not evaluable" and skips it forever — an alert that looks armed
 * and can never fire.
 *
 * Found by executing 025 against a real PostgreSQL 16 and running the
 * accept/reject matrix by hand, which is the second time that exercise has
 * caught a NULL-logic defect reading the SQL did not (see 017). Pinned here
 * because the tempting way to write a new cross family's branch is the wrong
 * one, and it fails silently.
 */
test("every cross family's shape rule guards against a NULL mode explicitly", () => {
  const effective = fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql")).sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8"))
    .join("\n");
  // The LAST definition is the one the database enforces.
  const definitions = [...effective.matchAll(
    /ADD CONSTRAINT ma_alerts_shape_ck CHECK \(([\s\S]*?)\)\s*(?:NOT VALID)?;/g
  )];
  assert.ok(definitions.length > 0, "no shape constraint found");
  const shape = definitions[definitions.length - 1]![1]!.replace(/\s+/g, " ");

  for (const kind of ["ma_vs_ma", "rsi", "macd", "supertrend"]) {
    const branch = shape.match(new RegExp(`condition_kind = '${kind}'[^)]*\\)*`));
    assert.ok(branch, `no branch for ${kind}`);
    assert.match(
      branch[0]!,
      /mode IS NOT NULL AND mode IN/,
      `${kind} tests \`mode IN (...)\` without \`mode IS NOT NULL\`. ` +
      "With a NULL mode that branch evaluates to NULL, and a CHECK passes on " +
      "NULL — so a row with no mode is accepted and can never fire."
    );
  }
});

/**
 * Tightening a CHECK re-validates every existing row, and this runner applies
 * migrations on BOOT. A plain `ADD CONSTRAINT` that any legacy row failed would
 * abort the migration and leave the backend refusing to start — trading a
 * silent data defect for an outage.
 */
test("the tightened shape constraint cannot abort a deploy on legacy rows", () => {
  const sql025 = fs.readFileSync(
    path.join(MIGRATIONS, "025_supertrend_alerts.sql"), "utf8"
  ).replace(/\s+/g, " ");
  assert.match(sql025, /ADD CONSTRAINT ma_alerts_shape_ck CHECK \(.*?\) NOT VALID;/);
  // ...and it is still checked against existing rows, reporting rather than failing.
  assert.match(sql025, /VALIDATE CONSTRAINT ma_alerts_shape_ck/);
  assert.match(sql025, /EXCEPTION WHEN check_violation THEN/);
  assert.match(sql025, /RAISE WARNING/);
});

/** 025 lifts 017's restriction; the constraint must be gone, not widened. */
test("gates are no longer confined to the two level families", () => {
  const sql025 = fs.readFileSync(
    path.join(MIGRATIONS, "025_supertrend_alerts.sql"), "utf8"
  );
  assert.match(sql025, /DROP CONSTRAINT IF EXISTS ma_alerts_filter_kind_ck/);
  assert.doesNotMatch(sql025, /ADD CONSTRAINT ma_alerts_filter_kind_ck/);
});
