/**
 * Installing the shipped Pine library without overwriting anyone's work.
 *
 * ── What was wrong before ──────────────────────────────────────────────────
 *
 * The old seed was idempotent, and that is exactly what made it destructive:
 * `ON CONFLICT (lower(name)) DO UPDATE SET source = …` meant a user who tuned
 * "Bollinger Bands" lost that work the next time the library was seeded.
 * Silently, with nothing to say it had happened — and now it runs on every
 * boot, so "the next time" is every restart.
 *
 * The rule that replaced it is four lines long and every line of it is a case
 * somebody's work depends on:
 *
 *   absent                                     → install
 *   present, origin 'builtin', source == hash  → update (a version bump)
 *   present, origin 'builtin', source != hash  → SKIP; the user edited it
 *   present, origin 'user'                     → SKIP; it is not ours
 *
 * The full sequence runs against a real PostgreSQL in the mission's validation
 * pass. What runs here without a database is the shape the rule rests on: the
 * migration that stores ownership, the hash that answers "has this changed",
 * and the boot path's refusal to be fatal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sourceHash, LIBRARY_VERSION } from "../src/pine/librarySeed";
import { INDICATOR_LIBRARY } from "../src/pine/library";
import { PineInterpreter } from "../src/pine/interpreter";

const ROOT = path.join(__dirname, "..");
const sql = fs.readFileSync(
  path.join(ROOT, "src", "db", "migrations", "030_pine_library_ownership.sql"), "utf8");
const flat = sql.replace(/\s+/g, " ");

test("every pre-existing script defaults to 'user', which is the safe direction", () => {
  // A row installed before this migration has no recorded owner. Defaulting it
  // to 'builtin' would let the next seed overwrite a script somebody wrote.
  assert.match(flat, /ADD COLUMN IF NOT EXISTS origin\s+text NOT NULL DEFAULT 'user'/);
  assert.match(flat, /CHECK \(origin IN \('user', 'builtin'\)\)/);
});

test("a builtin row must say what it shipped as, or the rule cannot be applied", () => {
  // Without the hash, "has the user edited this" would have to be guessed from
  // a timestamp — and a re-seed would look exactly like an edit.
  assert.match(flat,
    /origin <> 'builtin' OR \(builtin_version IS NOT NULL AND builtin_hash IS NOT NULL\)/);
});

test("the migration adds columns and nothing else", () => {
  const statements = sql.replace(/^\s*--.*$/gm, "");
  for (const forbidden of [/DROP TABLE/i, /DROP COLUMN/i, /DELETE FROM/i, /TRUNCATE/i,
                           /UPDATE pine_scripts SET/i]) {
    assert.doesNotMatch(statements, forbidden, `${forbidden} would not be additive`);
  }
});

test("the hash answers 'is this still what we shipped', and only that", () => {
  const source = "//@version=5\nindicator(\"x\")\nplot(close)";
  assert.equal(sourceHash(source), sourceHash(source), "the same source hashes the same");
  assert.notEqual(sourceHash(source), sourceHash(source + "\n// edit"),
    "a one-comment edit must be visible, because that is an edit");
  // Whitespace is NOT normalised away: a user who reformatted a script has
  // changed it, and silently overwriting their formatting is still overwriting
  // their work.
  assert.notEqual(sourceHash(source), sourceHash(source.replace("\n", "\n\n")));
  // Short enough to store, long enough that a collision is not a real concern
  // for a library of a few dozen scripts.
  assert.equal(sourceHash(source).length, 32);
});

test("the library version is recorded, so a build can say what an install is behind", () => {
  assert.match(LIBRARY_VERSION, /^\d+$/);
  const seed = fs.readFileSync(path.join(ROOT, "src", "pine", "librarySeed.ts"), "utf8");
  assert.match(seed, /builtinVersion: LIBRARY_VERSION/);
});

test("every shipped script compiles, because the picker is not the place to find out", () => {
  // A library entry that does not parse would sit in the browser and fail only
  // when somebody put it on a chart.
  for (const entry of INDICATOR_LIBRARY) {
    const { errors } = PineInterpreter.compile(entry.source);
    assert.equal(errors.length, 0,
      `${entry.name} does not compile: ${errors[0]?.message ?? ""}`);
  }
  assert.ok(INDICATOR_LIBRARY.length > 0);
  const names = INDICATOR_LIBRARY.map((e) => e.name.trim().toLowerCase());
  assert.equal(new Set(names).size, names.length,
    "two entries with one name would fight over the same row forever");
});

/** Source with comments removed — the code, not the prose about the code. */
const codeOf = (file: string): string =>
  fs.readFileSync(path.join(ROOT, ...file.split("/")), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("seeding on boot can never stop the backend starting", () => {
  const boot = codeOf("src/index.ts");
  const at = boot.indexOf("await seedIndicatorLibrary(");
  assert.ok(at > 0, "the library must be seeded on boot, not by a step somebody remembers");
  // A library that cannot be installed is a missing convenience; a backend
  // that will not start because of one is an outage.
  const around = boot.slice(Math.max(0, at - 200), at + 900);
  assert.match(around, /try \{/);
  assert.match(around, /catch \(cause\) \{[\s\S]*?app\.log\.error/);
});

test("only the seed may claim a script as the library's", () => {
  const repo = codeOf("src/repositories/pineScripts.ts");
  // `upsertScript` is what a user's save goes through, and it must not set
  // `origin` — otherwise saving under a shipped name would hand the script to
  // the library, and the next seed would overwrite it.
  const userUpsert = repo.slice(repo.indexOf("export async function upsertScript"),
    repo.indexOf("export async function upsertBuiltinScript"));
  assert.doesNotMatch(userUpsert, /origin/,
    "a user's save must never mark a script as the library's");
  assert.match(repo, /origin = 'builtin'/, "and the builtin path must set it explicitly");
});
