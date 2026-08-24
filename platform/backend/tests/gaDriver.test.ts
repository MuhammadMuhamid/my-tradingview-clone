/**
 * Characterization of the shared GA driver against the implementation it
 * replaced (`OPT-06`, `OPT-07`, and the consolidation rule).
 *
 * `Driver`, `loadDriver`, `seedDone` and `scoreMetrics` were byte-identical in
 * all five search trees. Consolidation is only safe if it is provably
 * behaviour-preserving, so the ORIGINAL implementation is reproduced verbatim
 * below and the shared one is required to agree with it — candidate for
 * candidate, score for score.
 *
 * If a future change to the shared driver is intended to change search
 * behaviour, these tests are supposed to fail. That is the point: a silent
 * change to how configurations are chosen is a change to which configurations
 * reach real money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Driver, coinSeed, resumeFromResults, restoreRngState, saveRngState, scoreMetrics,
  type ParamDef,
} from "../src/optimizer/gaDriver";

// ── The ORIGINAL, copied verbatim from lean_optimizer15m/optimizer.ts ────────

class OriginalDriver {
  space: ParamDef[];
  pop: number; mut: number;
  seen = new Set<string>();
  scored: [number[], number][] = [];
  private rng: () => number;

  constructor(space: ParamDef[], cfg: Record<string, number | string>, seed: number) {
    this.space = space;
    this.pop = Number(cfg.ga_population ?? 14);
    this.mut = Number(cfg.ga_mutation_rate ?? 0.18);
    let s = seed >>> 0;
    this.rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  }

  genomeToParams(g: number[]): Record<string, number | boolean> {
    const out: Record<string, number | boolean> = {};
    this.space.forEach((p, k) => { out[p.name] = p.values[g[k]!]!; });
    return out;
  }

  private rand(): number[] {
    return this.space.map((p) => Math.floor(this.rng() * p.values.length));
  }

  private tournament(k = 3): number[] {
    let best: [number[], number] | null = null;
    for (let i = 0; i < k; i++) {
      const c = this.scored[Math.floor(this.rng() * this.scored.length)]!;
      if (!best || c[1] > best[1]) best = c;
    }
    return best![0];
  }

  ask(): number[] | null {
    for (let attempt = 0; attempt < 200; attempt++) {
      let g: number[];
      if (this.scored.length < this.pop) g = this.rand();
      else {
        const a = this.tournament(), b = this.tournament();
        g = a.map((v, i) => (this.rng() < 0.5 ? v : b[i]!));
        g = g.map((v, i) =>
          this.rng() < this.mut ? Math.floor(this.rng() * this.space[i]!.values.length) : v);
      }
      if (!this.seen.has(g.join(","))) return g;
    }
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const g = this.rand();
      if (!this.seen.has(g.join(","))) return g;
    }
    return null;
  }

  tell(g: number[], score: number | null): void {
    const s = score === null || Number.isNaN(score) ? -Infinity : score;
    this.seen.add(g.join(","));
    this.scored.push([g, s]);
    if (this.scored.length > 400) this.scored.splice(0, this.scored.length - 400);
  }
}

function originalScoreMetrics(
  m: Record<string, number | null>, obj: Record<string, number>
): number {
  const net = m.net_pct, dd = m.dd_pct, trades = m.trades;
  if (net === null || net === undefined || Number.isNaN(net)) return -Infinity;
  if ((trades ?? 0) < (obj.min_trades ?? 30)) return -Infinity;
  const pf = m.profit_factor;
  if ((obj.min_profit_factor ?? 0) > 0 && (pf ?? 0) < obj.min_profit_factor!) return -Infinity;
  const ddPen = (obj.dd_weight ?? 1) * Math.max(0, dd ?? 0);
  const overtrade = (obj.overtrade_weight ?? 0) * Math.max(0, (trades ?? 0) - (obj.trade_soft_cap ?? 1e9));
  return net - ddPen - overtrade;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const SPACE: ParamDef[] = [
  { name: "ma_len", id: "in_0", type: "int", values: [20, 50, 100, 200] },
  { name: "rr", id: "in_1", type: "float", values: [1.5, 2, 2.5, 3] },
  { name: "use_st", id: "in_2", type: "bool", values: [true, false] },
  { name: "lookback", id: "in_3", type: "int", values: [5, 10, 15, 20, 30, 50] },
];
const CFG = { ga_population: 14, ga_mutation_rate: 0.18, random_seed: 42 };

/** Deterministic pseudo-scores, so both drivers see the same feedback. */
const scoreFor = (g: number[], i: number): number =>
  ((g.reduce((a, b) => a * 7 + b, i) % 997) / 10) - 40;

// ── Equivalence ─────────────────────────────────────────────────────────────

test("the shared driver proposes the SAME candidate sequence as the original", () => {
  const shared = new Driver(SPACE, CFG, 42);
  const original = new OriginalDriver(SPACE, CFG, 42);
  for (let i = 0; i < 400; i += 1) {
    const a = shared.ask();
    const b = original.ask();
    assert.deepEqual(a, b, `candidate ${i} diverged`);
    if (!a) break;
    const s = scoreFor(a, i);
    shared.tell(a, s);
    original.tell(b!, s);
  }
  assert.equal(shared.seen.size, original.seen.size);
  assert.equal(shared.scored.length, original.scored.length);
});

test("null and NaN feedback are handled identically", () => {
  const shared = new Driver(SPACE, CFG, 7);
  const original = new OriginalDriver(SPACE, CFG, 7);
  for (let i = 0; i < 120; i += 1) {
    const a = shared.ask()!, b = original.ask()!;
    assert.deepEqual(a, b);
    const s = i % 5 === 0 ? null : i % 7 === 0 ? NaN : scoreFor(a, i);
    shared.tell(a, s);
    original.tell(b, s);
  }
  assert.deepEqual(shared.scored.map((x) => x[1]), original.scored.map((x) => x[1]));
});

test("the scored pool is capped at 400 in both", () => {
  const shared = new Driver(SPACE, CFG, 1);
  const original = new OriginalDriver(SPACE, CFG, 1);
  for (let i = 0; i < 500; i += 1) {
    const g = [i % 4, i % 4, i % 2, i % 6];
    shared.tell(g, i);
    original.tell(g, i);
  }
  assert.equal(shared.scored.length, 400);
  assert.equal(original.scored.length, 400);
  assert.deepEqual(shared.scored[0], original.scored[0]);
});

test("genomeToParams is unchanged", () => {
  const shared = new Driver(SPACE, CFG, 3);
  const original = new OriginalDriver(SPACE, CFG, 3);
  for (const g of [[0, 0, 0, 0], [3, 3, 1, 5], [1, 2, 0, 4]]) {
    assert.deepEqual(shared.genomeToParams(g), original.genomeToParams(g));
  }
});

test("the objective is unchanged across every branch", () => {
  const objectives = [
    {}, { min_trades: 30 }, { min_trades: 0, dd_weight: 2 },
    { min_profit_factor: 1.1 }, { overtrade_weight: 0.05, trade_soft_cap: 100 },
  ];
  const metrics: Record<string, number | null>[] = [
    { net_pct: 120, dd_pct: 8, trades: 55, profit_factor: 1.4 },
    { net_pct: -12, dd_pct: 30, trades: 29, profit_factor: 0.8 },
    { net_pct: 5, dd_pct: 0, trades: 400, profit_factor: 1.05 },
    { net_pct: null, dd_pct: 1, trades: 90, profit_factor: 2 },
    { net_pct: NaN, dd_pct: 1, trades: 90, profit_factor: 2 },
    { net_pct: 3, dd_pct: null, trades: null, profit_factor: null },
  ];
  for (const obj of objectives) {
    for (const m of metrics) {
      assert.equal(scoreMetrics(m, obj), originalScoreMetrics(m, obj),
        `${JSON.stringify(obj)} / ${JSON.stringify(m)}`);
    }
  }
});

test("the per-coin seed offset is unchanged", () => {
  const original = (coin: string, base: number) => {
    let h = 0;
    for (const ch of coin) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return base + (h % 1000);
  };
  for (const coin of ["DEXEUSDT", "ZECUSDT", "币安人生USDT", "A", ""]) {
    assert.equal(coinSeed(coin, 42), original(coin, 42), coin);
  }
});

// ── OPT-06: restart determinism ─────────────────────────────────────────────

test("OPT-06: `tell` does NOT advance the RNG — which is why resume needed a fix", () => {
  const driver = new Driver(SPACE, CFG, 42);
  const before = driver.rngState();
  for (let i = 0; i < 50; i += 1) driver.tell([0, 1, 0, 2], i);
  assert.equal(driver.rngState(), before,
    "replaying history leaves the RNG where it started; that is the defect");
});

test("OPT-06: a restored RNG state continues the sequence instead of restarting it", () => {
  const continuous = new Driver(SPACE, CFG, 42);
  const asked: (number[] | null)[] = [];
  for (let i = 0; i < 60; i += 1) {
    const g = continuous.ask()!;
    asked.push(g);
    continuous.tell(g, scoreFor(g, i));
  }

  // Rebuild the way a resume does: replay the history, then restore the state.
  const resumed = new Driver(SPACE, CFG, 42);
  asked.forEach((g, i) => resumed.tell(g!, scoreFor(g!, i)));
  assert.notEqual(resumed.rngState(), continuous.rngState(),
    "without the fix, a resumed run is at a different RNG state");
  resumed.setRngState(continuous.rngState());

  for (let i = 60; i < 80; i += 1) {
    const a = continuous.ask()!;
    const b = resumed.ask()!;
    assert.deepEqual(b, a, `resumed run diverged at candidate ${i}`);
    continuous.tell(a, scoreFor(a, i));
    resumed.tell(b, scoreFor(b, i));
  }
});

test("the RNG state round-trips through disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ga-"));
  const driver = new Driver(SPACE, CFG, 42);
  for (let i = 0; i < 30; i += 1) driver.ask();
  const state = driver.rngState();
  saveRngState(dir, "DEXEUSDT", driver);

  const fresh = new Driver(SPACE, CFG, 42);
  assert.equal(restoreRngState(dir, "DEXEUSDT", fresh), true);
  assert.equal(fresh.rngState(), state);
  // A coin with no saved state is reported as such, not silently zeroed.
  assert.equal(restoreRngState(dir, "NEVERSEEN", fresh), false);
  assert.equal(fresh.rngState(), state);
});

// ── OPT-07: one streaming pass ──────────────────────────────────────────────

test("OPT-07: replay and the seed-key set come from ONE pass over the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ga-results-"));
  const file = path.join(dir, "DEXEUSDT.jsonl");
  const rows = Array.from({ length: 250 }, (_, i) => ({
    genome: [i % 4, (i * 3) % 4, i % 2, i % 6],
    score: i % 11 === 0 ? null : i,
    ...(i % 20 === 0 ? { context: { ctx: { hhTf: "5" } } } : {}),
  }));
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const driver = new Driver(SPACE, CFG, 42);
  const { replayed, done } = resumeFromResults(file, driver);
  assert.equal(replayed, 250);
  assert.equal(driver.scored.length, 250);
  // The key shape the trees compare seeds against, unchanged.
  assert.ok(done.has(`${rows[0]!.genome.join(",")}|{"ctx":{"hhTf":"5"}}`));
  assert.ok(done.has(`${rows[1]!.genome.join(",")}|{}`));
  assert.equal(done.size, new Set(rows.map((r) =>
    r.genome.join(",") + "|" + JSON.stringify(r.context ?? {}))).size);
});

test("a truncated or corrupt trailing line is skipped, not fatal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ga-results-"));
  const file = path.join(dir, "X.jsonl");
  fs.writeFileSync(file,
    `${JSON.stringify({ genome: [1, 1, 1, 1], score: 3 })}\n` +
    `{"genome":[2,2,1,2],"sco\n` +
    `${JSON.stringify({ genome: [0, 0, 0, 0], score: 5 })}\n` +
    `{"genome":[3,3`);
  const driver = new Driver(SPACE, CFG, 42);
  const { replayed } = resumeFromResults(file, driver);
  assert.equal(replayed, 2);
});

test("a missing result file resumes as empty rather than throwing", () => {
  const driver = new Driver(SPACE, CFG, 42);
  const { replayed, done } = resumeFromResults(path.join(os.tmpdir(), "absent.jsonl"), driver);
  assert.equal(replayed, 0);
  assert.equal(done.size, 0);
});

test("a chunk boundary in the middle of a line does not lose or duplicate a row", () => {
  // Rows large enough that 4 MiB chunks split them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ga-results-"));
  const file = path.join(dir, "BIG.jsonl");
  const pad = "x".repeat(2000);
  const rows = Array.from({ length: 6000 }, (_, i) => ({
    genome: [i % 4, i % 4, i % 2, i % 6], score: i, note: pad,
  }));
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const driver = new Driver(SPACE, CFG, 42);
  const { replayed } = resumeFromResults(file, driver);
  assert.equal(replayed, 6000, "a row was lost or duplicated at a chunk boundary");
});
