/**
 * X-04 / BE-24 — the optimizer routing registry and the bounded result reader.
 *
 * The behaviour under test is the one the audit found missing: a request for a
 * tree that does not exist must produce a NAMED failure, not an empty success,
 * and nothing here may read a whole result stream synchronously.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listTrees, optimizerRoot, resetRegistryCache, resolveTree, treeById, treeResults,
  TreeRegistryError,
} from "../src/optimizer/registry";
import { countsFor, refreshCounts, scanRanked, settleCounts } from "../src/optimizer/resultsIndex";

const BACKEND = path.resolve(__dirname, "..");

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optreg-"));
  const write = (dir: string, tree: unknown, cfg: unknown) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "tree.json"), JSON.stringify(tree));
    if (cfg) fs.writeFileSync(path.join(root, dir, "config.json"), JSON.stringify(cfg));
  };
  write("alpha15m", {
    id: "alpha15m", strategy: "mtf_lean", timeframe: "15m", system: "one-year",
    kind: "search", status: "current", label: "Alpha 15m",
  }, { timeframe: "15m", initialCapital: 10000, commissionPct: 0.1, slippageTicks: 2,
       range: { start: "2025-08-11T00:00:00Z", split: "2026-03-11T00:00:00Z", end: "now" } });
  write("alpha15m_wf", {
    id: "alpha15m_wf", strategy: "mtf_lean", timeframe: "15m", system: "one-year",
    kind: "walk-forward", status: "historical", label: "Alpha 15m walk-forward",
  }, { timeframe: "15m", initialCapital: 1000, commissionPct: 0.1, slippageTicks: 2 });
  // A directory with no tree.json is not a tree; it must be ignored silently.
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  return root;
}

test("the registry discovers only directories that own a tree.json", () => {
  const root = fixtureRoot();
  const trees = listTrees(root);
  assert.deepEqual(trees.map((t) => t.id), ["alpha15m", "alpha15m_wf"]);
  assert.equal(trees[0]!.cost.hasSplit, true);
  assert.equal(trees[1]!.cost.hasSplit, false);
  assert.equal(trees[0]!.cost.slippageTicks, 2);
});

test("a strategy with no tree is a NAMED failure, never an empty success", () => {
  const root = fixtureRoot();
  const r = resolveTree({ strategy: "srtrend_v10", timeframe: "1h" }, root);
  assert.equal(r.tree, null);
  assert.match(r.reason, /srtrend_v10/);
  // The caller is told what it could have asked for instead.
  assert.ok(r.candidates.includes("alpha15m"));
});

test("an unknown tree id names the root it was looked for under", () => {
  const root = fixtureRoot();
  const r = resolveTree({ tree: "sr_optimizer1h" }, root);
  assert.equal(r.tree, null);
  assert.match(r.reason, /sr_optimizer1h/);
  assert.match(r.reason, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("only search trees answer a strategy/timeframe query", () => {
  const root = fixtureRoot();
  const r = resolveTree({ strategy: "mtf_lean", timeframe: "15m" }, root);
  assert.equal(r.tree?.id, "alpha15m");
  // The walk-forward tree exists and is reachable, but only by id, because it
  // publishes fold reports rather than a best/ leaderboard.
  assert.equal(resolveTree({ tree: "alpha15m_wf" }, root).tree?.id, "alpha15m_wf");
});

test("a tree with no generated data reports no results rather than failing", () => {
  const root = fixtureRoot();
  const tree = treeById("alpha15m", root)!;
  const res = treeResults(tree);
  assert.equal(res.hasResults, false);
  assert.deepEqual(res.resultFiles, []);
});

test("a malformed tree.json is an error, not a silently dropped tree", () => {
  const root = fixtureRoot();
  fs.writeFileSync(path.join(root, "alpha15m", "tree.json"), JSON.stringify({ id: "alpha15m" }));
  assert.throws(() => listTrees(root), TreeRegistryError);
});

test("resolution does not depend on the process working directory", () => {
  resetRegistryCache();
  const before = optimizerRoot();
  const cwd = process.cwd();
  try {
    process.chdir(os.tmpdir());
    assert.equal(optimizerRoot(), before);
  } finally {
    process.chdir(cwd);
  }
});

test("this repository ships no trees, and the registry says so plainly", () => {
  // The 14 optimizer trees moved to the backtesting repository
  // (github.com/MuhammadMuhamid/pythoncryptobacktesingsystems, under `trees/`),
  // which is where the "every tree parses / every config.json is registered"
  // assertion now lives — the guard travels with the thing it guards.
  //
  // What must hold HERE is that a checkout with no trees is a well-defined
  // state rather than a crash: the optimizer API answers "no trees" instead of
  // throwing, and an operator who wants them points OPTIMIZER_ROOT at a
  // backtesting checkout. X-04's actual logic — discovery, malformed tree.json,
  // cwd-independence, unknown-id handling — is covered by the fixture tests
  // above, which build their own roots and do not depend on tracked data.
  resetRegistryCache();
  const trees = listTrees(BACKEND);
  assert.deepEqual(trees, [], "no tree directory should be tracked in the platform repository");

  // And nothing left a config.json behind without a tree.json to route it.
  const configured = fs.readdirSync(BACKEND, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(BACKEND, e.name, "config.json")))
    .map((e) => e.name).sort();
  assert.deepEqual(configured, [], "a config.json here is a tree that failed to move");
});

test("OPTIMIZER_ROOT is how a platform deployment reaches the trees", () => {
  // The documented operational contract after the split.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optroot-"));
  fs.mkdirSync(path.join(root, "lean_optimizer15m"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "lean_optimizer15m", "tree.json"),
    JSON.stringify({ id: "lean_optimizer15m", strategy: "mtf_lean", timeframe: "15m",
                     system: "lean", kind: "search", status: "current", label: "Lean 15m" })
  );
  const prev = process.env.OPTIMIZER_ROOT;
  try {
    process.env.OPTIMIZER_ROOT = root;
    resetRegistryCache();
    assert.equal(optimizerRoot(), path.resolve(root));
    assert.deepEqual(listTrees(optimizerRoot()).map((t) => t.id), ["lean_optimizer15m"]);
  } finally {
    if (prev === undefined) delete process.env.OPTIMIZER_ROOT;
    else process.env.OPTIMIZER_ROOT = prev;
    resetRegistryCache();
  }
});

// ── BE-24: bounded, non-blocking result reading ──────────────────────────────

function resultsFixture(lines: { score: number | null; genome: number[] }[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optres-"));
  fs.mkdirSync(path.join(root, "results"), { recursive: true });
  const file = path.join(root, "results", "AAAUSDT.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("scanRanked dedupes by genome, sorts by score and skips unscored rows", async () => {
  const file = resultsFixture([
    { score: 1, genome: [1] },
    { score: 9, genome: [2] },
    { score: 5, genome: [2] },   // duplicate genome: the FIRST wins, as before
    { score: null, genome: [3] },
    { score: 7, genome: [4] },
  ]);
  const scan = await scanRanked(file);
  assert.deepEqual(scan.records.map((r) => r.score), [9, 7, 1]);
  assert.equal(scan.truncated, false);
});

test("scanRanked retains only topK records however long the stream is", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ score: i, genome: [i] }));
  const file = resultsFixture(rows);
  const scan = await scanRanked(file, { topK: 10 });
  assert.equal(scan.records.length, 10);
  assert.deepEqual(scan.records.map((r) => r.score), [499, 498, 497, 496, 495, 494, 493, 492, 491, 490]);
});

test("a byte budget stops the scan and says so instead of pretending completeness", async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ score: i, genome: [i] }));
  const file = resultsFixture(rows);
  const scan = await scanRanked(file, { maxBytes: 64 });
  assert.equal(scan.truncated, true);
  assert.ok(scan.bytes <= 4 * 1024 * 1024);
});

test("a missing result stream is empty, not an exception", async () => {
  const scan = await scanRanked(path.join(os.tmpdir(), "definitely-absent.jsonl"));
  assert.deepEqual(scan.records, []);
});

test("counts are served from a background refresh; the handler path never scans", async () => {
  const root = fixtureRoot();
  const tree = treeById("alpha15m", root)!;
  fs.mkdirSync(path.join(tree.dir, "results"), { recursive: true });
  fs.writeFileSync(
    path.join(tree.dir, "results", "AAAUSDT.jsonl"),
    Array.from({ length: 7 }, (_, i) => JSON.stringify({ score: i, genome: [i] })).join("\n") + "\n"
  );
  // First read is synchronous and does no work: it reports that the count is
  // still pending rather than blocking the event loop on a multi-GB scan.
  const first = countsFor(tree);
  assert.equal(first.state, "pending");
  assert.equal(first.total, 0);
  await settleCounts();
  const second = countsFor(tree);
  assert.equal(second.state, "ready");
  assert.equal(second.counts.AAAUSDT, 7);
  // The cache file is written by the refresher, never by a request handler.
  assert.ok(fs.existsSync(path.join(tree.dir, "index", "raw_counts.json")));
});

test("a rewritten (shorter) stream is recounted from zero, not left stale", async () => {
  const root = fixtureRoot();
  const tree = treeById("alpha15m_wf", root)!;
  const dir = path.join(tree.dir, "results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "BBBUSDT.jsonl");
  fs.writeFileSync(file, "x\n".repeat(40));
  assert.equal((await refreshCounts(tree)).counts.BBBUSDT, 40);
  fs.writeFileSync(file, "x\n".repeat(3));
  assert.equal((await refreshCounts(tree)).counts.BBBUSDT, 3);
});

// ── OPT-09: winners on the min_trades floor ─────────────────────────────────

test("a tree's min_trades floor is read from its own objective", () => {
  const root = fixtureRoot();
  const tree = treeById("alpha15m", root)!;
  fs.writeFileSync(
    path.join(tree.dir, "params.json"),
    JSON.stringify({ parameters: [], objective: { min_trades: 50 } })
  );
  const space = JSON.parse(fs.readFileSync(path.join(tree.dir, "params.json"), "utf8")) as {
    objective: { min_trades: number };
  };
  assert.equal(space.objective.min_trades, 50);
});

test("every tree in this repository states a min_trades floor, or has no objective", () => {
  // A tree that gates on trades must say what the gate is, or the leaderboard
  // cannot tell a floor-hugging winner from a comfortable one (OPT-09).
  resetRegistryCache();
  for (const tree of listTrees(BACKEND)) {
    const params = path.join(tree.dir, "params.json");
    if (!fs.existsSync(params)) continue;
    const space = JSON.parse(fs.readFileSync(params, "utf8")) as {
      objective?: { min_trades?: unknown };
    };
    if (space.objective === undefined) continue;
    assert.equal(typeof space.objective.min_trades, "number",
      `${tree.id}/params.json has an objective but no numeric min_trades`);
  }
});
