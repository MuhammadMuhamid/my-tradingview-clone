/**
 * Chart state: the version rule, and the schema it rests on.
 *
 * ── What is being protected ────────────────────────────────────────────────
 *
 * Moving a user's drawings from the browser to the server introduces exactly
 * one new way to lose work: two devices, one stale. Everything here is about
 * that. The rule is deliberately one sentence — a write carries the version it
 * last read, and a stale one is refused with what is actually stored — because
 * a rule nobody can state is a rule nobody can debug, and this product is not
 * getting a CRDT.
 *
 * The version arithmetic itself is executed against a real PostgreSQL in the
 * mission's validation pass and recorded there. What runs here without a
 * database is the SHAPE the rule depends on: the SQL that stores it, and the
 * repository's decision function separated from its I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MAX_ITEMS, isConflict } from "../src/repositories/chartState";

const MIGRATIONS = path.join(__dirname, "..", "src", "db", "migrations");
const sql = fs.readFileSync(path.join(MIGRATIONS, "029_chart_state.sql"), "utf8");
const flat = sql.replace(/\s+/g, " ");

// ── the schema ─────────────────────────────────────────────────────────────

test("both tables carry a monotonic version, which is the whole conflict rule", () => {
  for (const table of ["chart_drawings", "chart_pane_studies"]) {
    assert.match(flat, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }
  // A version that could be absent or reset would let a stale device look
  // current, which is the one failure this design exists to prevent.
  assert.equal((flat.match(/version bigint NOT NULL DEFAULT 1/g) ?? []).length, 2,
    "each table needs its own non-null version, defaulted so a first row has one");
});

test("a payload that is not a list is refused by the database, not only by the API", () => {
  // `jsonb` accepts `{}` and `5` quite happily, and either would break every
  // reader. The API checks it too; this is the check that cannot be bypassed
  // by a future writer that forgets.
  assert.match(flat, /CHECK \(jsonb_typeof\(drawings\) = 'array'\)/);
  assert.match(flat, /CHECK \(jsonb_typeof\(pine\) = 'array' AND jsonb_typeof\(native\) = 'array'\)/);
});

test("drawings are keyed by instrument and studies by pane, which is the existing semantics", () => {
  // Not an inconsistency: a trendline belongs to BTCUSDT and every pane showing
  // BTCUSDT shows it, while a pane's studies stay put when its symbol changes.
  // Keying studies by instrument would silently swap a pane's studies out from
  // under it on every symbol change — a product change Wave C did not ask for.
  assert.match(flat, /PRIMARY KEY \(venue, symbol\)/);
  assert.match(flat, /scope text NOT NULL PRIMARY KEY/);
  // The venue comes from Wave A's canonical identity, so the day a second
  // venue exists one exchange's levels cannot be drawn on another's chart.
  assert.match(flat, /venue text NOT NULL DEFAULT 'BINANCE'/);
  assert.match(flat, /chart_drawings_venue_ck/);
});

test("the migration is additive: it creates and never drops or rewrites", () => {
  const statements = sql.replace(/^\s*--.*$/gm, "");
  for (const forbidden of [/DROP TABLE/i, /DROP COLUMN/i, /DELETE FROM/i, /TRUNCATE/i,
                           /ALTER TABLE \w+ ALTER COLUMN/i]) {
    assert.doesNotMatch(statements, forbidden, `${forbidden} would not be additive`);
  }
  // `DROP CONSTRAINT IF EXISTS` immediately before `ADD CONSTRAINT` is the
  // re-runnable idiom every migration here uses, and is not a drop of data.
  assert.match(flat, /DROP CONSTRAINT IF EXISTS chart_drawings_array_ck; ALTER TABLE chart_drawings ADD CONSTRAINT/);
});

test("a pane scope cannot be an arbitrary string in the database either", () => {
  // The repository rejects one too. Two checks because this key reaches a
  // primary key and a URL path, and a scope like "../etc" should never depend
  // on one layer remembering to look.
  assert.match(flat, /chart_pane_studies_scope_ck CHECK \(scope ~ '\^\[a-z\]/);
});

// ── the decision, without the database ─────────────────────────────────────

test("a conflict is distinguishable from a state, by shape rather than by guessing", () => {
  const state = { scope: "p1", pine: [], native: [], version: 3, updatedAt: "" };
  assert.equal(isConflict(state), false);
  assert.equal(isConflict({ conflict: true, current: state }), true);
  // A caller that read `.version` off a conflict would silently write against
  // the version it just failed against, so the two must not be confusable.
  assert.equal(isConflict({ ...state, conflict: false } as never), false);
});

test("there is a bound on how much one row may hold", () => {
  // Not politeness: the payload is opaque JSON in one row, read whole on every
  // chart load. A list with no ceiling is a chart that eventually cannot open.
  assert.ok(MAX_ITEMS > 0 && MAX_ITEMS <= 10_000);
  assert.equal(MAX_ITEMS, 2_000);
});

// ── the route contract ─────────────────────────────────────────────────────

test("a stale write answers 409 with the CURRENT state, not with an error", () => {
  const route = fs.readFileSync(
    path.join(__dirname, "..", "src", "api", "routes", "chartState.ts"), "utf8");
  // A client that must make a second request to learn what happened is a
  // client that will sometimes not make it.
  assert.match(route, /reply\.code\(409\)\.send\(result\.current\)/);
  assert.equal((route.match(/reply\.code\(409\)/g) ?? []).length, 2,
    "both writers must answer a conflict the same way");
  // An absent baseVersion means "I believe nothing is stored", which is how a
  // first write and a one-time import both arrive — and both must then lose to
  // an existing row rather than flatten it.
  assert.match(route, /Number\.isFinite\(n\) && n > 0 \? Math\.floor\(n\) : 0/);
});
