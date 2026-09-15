/**
 * `ON CONFLICT` must name exactly the columns the unique index has.
 *
 * ── Why this test exists ──────────────────────────────────────────────────
 *
 * Postgres INFERS the arbiter index from the column list in `ON CONFLICT
 * (...)`. There is no fallback: a list no index covers raises
 *
 *     there is no unique or exclusion constraint matching the
 *     ON CONFLICT specification
 *
 * on EVERY insert. Migration 036 added `filters` to all eleven per-kind unique
 * indexes; `CONFLICT_TARGET` was not updated in the same edit, and the create
 * route returned 500 for every alert of every kind until it was. The SQL-only
 * migration tests all passed, because nothing they did went through the
 * insert path the application uses.
 *
 * So the two lists are compared directly, by reading the migration. A static
 * check, so it runs in CI with no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CONFLICT_TARGET } from "../src/repositories/maAlerts";
import { CONDITION_KINDS } from "../src/types/maAlerts";

const MIGRATIONS = path.join(__dirname, "..", "src", "db", "migrations");

/** The newest migration that (re)defines the per-kind unique indexes. */
function indexDefiningMigration(): string {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const withIndexes = files.filter((f) =>
    /CREATE UNIQUE INDEX ma_alerts_\w+ ON ma_alerts/.test(
      fs.readFileSync(path.join(MIGRATIONS, f), "utf8")
    )
  );
  assert.ok(withIndexes.length > 0, "no migration defines the per-kind unique indexes");
  return fs.readFileSync(path.join(MIGRATIONS, withIndexes.at(-1)!), "utf8");
}

const columns = (spec: string): string[] => {
  const inside = spec.slice(spec.indexOf("(") + 1, spec.lastIndexOf(")"));
  return inside.split(",").map((c) => c.trim()).filter(Boolean);
};

test("every ON CONFLICT target names the same columns as its unique index", () => {
  const sql = indexDefiningMigration();

  // condition_kind = 'x' -> the index's column list
  const byKind = new Map<string, string[]>();
  for (const m of sql.matchAll(
    /CREATE UNIQUE INDEX \w+ ON ma_alerts \(([^)]*)\)[\s\S]*?condition_kind = '(\w+)'/g
  )) {
    byKind.set(m[2]!, m[1]!.split(",").map((c) => c.trim()).filter(Boolean));
  }

  assert.equal(
    byKind.size, CONDITION_KINDS.length,
    `the migration defines ${byKind.size} per-kind indexes but there are ` +
    `${CONDITION_KINDS.length} families — a family with no unique index can be armed twice`
  );

  for (const kind of CONDITION_KINDS) {
    const fromIndex = byKind.get(kind);
    assert.ok(fromIndex, `no unique index for ${kind}`);
    assert.deepEqual(
      columns(CONFLICT_TARGET[kind]), fromIndex,
      `ON CONFLICT for "${kind}" does not match its index. Postgres infers the ` +
      "arbiter from these columns and there is NO fallback: a mismatch makes " +
      "every insert of this kind fail with 42P10."
    );
  }
});

test("every conflict target is scoped to its own kind", () => {
  for (const kind of CONDITION_KINDS) {
    assert.match(
      CONFLICT_TARGET[kind], new RegExp(`WHERE condition_kind = '${kind}'$`),
      // A partial index only arbitrates rows its predicate admits, so the
      // WHERE clause is part of what identifies the index, not decoration.
      `${kind}'s target must carry the same partial predicate as its index`
    );
  }
});

test("filters is part of every key, so gates distinguish two alerts", () => {
  for (const kind of CONDITION_KINDS) {
    const cols = columns(CONFLICT_TARGET[kind]);
    assert.ok(cols.includes("filters"), `${kind} ignores gates when deciding "same alert"`);
    assert.equal(cols.at(-1), "filters", `${kind} should carry filters last`);
    assert.ok(cols.includes("symbol") && cols.includes("timeframe"), kind);
  }
});
