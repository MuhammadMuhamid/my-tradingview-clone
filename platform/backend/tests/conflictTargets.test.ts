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
 * reads the migrations and compares the two lists directly.
 *
 * EVERY migration is read, in order, and the LATEST definition of each
 * family's index wins. It used to read 045 alone and expect twelve: a family
 * added later (fib_level, 049) would have been invisible to it — its index
 * never compared to its ON CONFLICT list, which is precisely the drift this
 * file exists to catch.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { CONFLICT_TARGETS_FOR_TEST } from "../src/repositories/maAlerts";
import { CONDITION_KINDS } from "../src/types/maAlerts";

const MIGRATIONS = path.join(__dirname, "..", "src", "db", "migrations");

/** Every per-kind unique index statement, in migration order. */
function indexStatements(): { kind: string; columns: string; statement: string }[] {
  const out: { kind: string; columns: string; statement: string }[] = [];
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    const re =
      /CREATE UNIQUE INDEX IF NOT EXISTS \w+\s*\n\s*ON ma_alerts \(([^)]*)\)([\s\S]*?)WHERE condition_kind = '(\w+)';/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      out.push({ kind: m[3]!, columns: m[1]!.split(",").map((c) => c.trim()).join(", "),
        statement: m[0] });
    }
  }
  return out;
}

/** kind -> the column list its LATEST unique index is built on. */
function indexedColumnsByKind(): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of indexStatements()) out.set(s.kind, s.columns);
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
  assert.equal(indexes.size, CONDITION_KINDS.length, "one unique index per condition kind");

  for (const [kind, target] of Object.entries(CONFLICT_TARGETS_FOR_TEST)) {
    const parsed = parseTarget(target);
    assert.equal(parsed.kind, kind, `${kind}: target names a different kind`);
    const indexed = indexes.get(kind);
    assert.ok(indexed, `${kind}: no unique index in any migration`);
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
  const latest = new Map<string, string>();
  for (const s of indexStatements()) latest.set(s.kind, s.statement);
  assert.equal(latest.size, CONDITION_KINDS.length, "one index per condition kind");
  for (const [kind, statement] of latest) {
    assert.match(
      statement, /NULLS NOT DISTINCT/,
      `${kind}: its unique index is missing NULLS NOT DISTINCT`
    );
  }
});
