/**
 * The ON CONFLICT column lists must name real unique indexes.
 *
 * Postgres infers the arbiter for `ON CONFLICT (...)` FROM THE COLUMN LIST,
 * and there is no fallback: if the list does not match an existing unique
 * index exactly, every insert of that kind fails with 42P10 — not at deploy
 * time, not in a migration, but on the first real create.
 *
 * That failure mode is invisible to SQL-only tests, because the drift is
 * between the SQL and the TypeScript rather than inside either one. So this
 * reads migration 045 and compares the two lists directly.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { CONFLICT_TARGETS_FOR_TEST } from "../src/repositories/maAlerts";

const MIGRATION = path.join(
  __dirname, "..", "src", "db", "migrations", "045_alert_gate_list.sql"
);

/** kind -> the column list its unique index is actually built on. */
function indexedColumnsByKind(): Map<string, string> {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const out = new Map<string, string>();
  const re =
    /CREATE UNIQUE INDEX IF NOT EXISTS \w+\s*\n\s*ON ma_alerts \(([^)]*)\)\s*\n\s*NULLS NOT DISTINCT\s*\n\s*WHERE condition_kind = '(\w+)';/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.set(m[2]!, m[1]!.split(",").map((c) => c.trim()).join(", "));
  }
  return out;
}

/** "(a, b) WHERE condition_kind = 'k'" -> { kind, columns } */
function parseTarget(target: string): { kind: string; columns: string } {
  const m = /^\((.*)\)\s*WHERE condition_kind = '(\w+)'$/.exec(target.trim());
  assert.ok(m, `conflict target is not in the expected shape: ${target}`);
  return {
    kind: m![2]!,
    columns: m![1]!.split(",").map((c) => c.trim()).join(", "),
  };
}

test("every conflict target names an index the migration actually creates", () => {
  const indexes = indexedColumnsByKind();
  assert.equal(indexes.size, 12, "migration 045 should build one index per kind");

  for (const [kind, target] of Object.entries(CONFLICT_TARGETS_FOR_TEST)) {
    const parsed = parseTarget(target);
    assert.equal(parsed.kind, kind, `${kind}: target names a different kind`);
    const indexed = indexes.get(kind);
    assert.ok(indexed, `${kind}: no unique index in migration 045`);
    assert.equal(
      parsed.columns, indexed,
      `${kind}: ON CONFLICT columns drifted from the index — this is a 42P10 ` +
      `on every insert of this kind`
    );
  }
});

test("gates are part of every key, so two alerts may differ by gates alone", () => {
  for (const [kind, target] of Object.entries(CONFLICT_TARGETS_FOR_TEST)) {
    assert.ok(
      parseTarget(target).columns.split(", ").includes("filters"),
      `${kind}: two alerts differing only in their gates would collide`
    );
  }
});

test("ungated alerts still cannot be armed twice", () => {
  // `filters` is NULL for an ungated alert, and under the default rule two
  // NULLs never conflict — which would let the same ungated alert be inserted
  // repeatedly. Every index carrying `filters` must therefore say so.
  const sql = fs.readFileSync(MIGRATION, "utf8");
  // Split on the statement keyword so prose in the header cannot be counted as
  // an index that has the rule.
  const statements = sql.split("CREATE UNIQUE INDEX").slice(1);
  assert.equal(statements.length, 12, "one rebuilt index per condition kind");
  for (const statement of statements) {
    const body = statement.slice(0, statement.indexOf(";"));
    assert.match(
      body, /NULLS NOT DISTINCT/,
      `a rebuilt unique index is missing NULLS NOT DISTINCT: ${body.split("\n")[0]}`
    );
  }
});
