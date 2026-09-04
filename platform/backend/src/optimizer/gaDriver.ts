/**
 * The genetic-algorithm driver and objective the search trees share.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * `Driver`, `loadDriver`, `seedDone` and `scoreMetrics` were **byte-identical**
 * in all five search trees' `optimizer.ts` — verified by hashing each function
 * across the five files before this module was created. `tests/gaDriver.test.ts`
 * keeps a verbatim copy of the original implementation and asserts the shared
 * one produces the same candidate sequence and preserves every objective
 * branch outside explicitly tested contract repairs.
 *
 * Two defects are fixed here, in one place instead of five:
 *
 * `OPT-06` — the GA was not deterministic across restarts. Resuming replays the
 * whole history through `tell()`, which does not advance the RNG, so a process
 * that resumed at evaluation 10,000 started from the same RNG state as a fresh
 * one, while a process that had run continuously to 10,000 was somewhere else
 * entirely. The documented `random_seed: 42` therefore did not make runs
 * reproducible. The RNG state is now persisted beside the results and restored
 * on resume, so a resumed run continues exactly where it stopped.
 *
 * `OPT-07` — round startup read every coin's full result history TWICE
 * (`loadDriver` and `seedDone` each did `readFileSync(...).split("\n")`), for
 * all 19 coins concurrently: 38 whole-file string reads per round against files
 * the docs describe as reaching multiple gigabytes. It is now one chunked
 * streaming pass that produces both.
 */
import fs from "node:fs";
import path from "node:path";

export interface ParamDef {
  name: string;
  id: string;
  type: string;
  values: (number | boolean)[];
}

/**
 * Ask/tell genetic driver.
 *
 * Preserved exactly: population, mutation rate, tournament size, the
 * crossover/mutation order, the 200-attempt dedupe loop, the 10,000-attempt
 * random fallback, and the 400-entry cap on the scored pool. The only addition
 * is the ability to read and restore the RNG state.
 */
export class Driver {
  space: ParamDef[];
  pop: number;
  mut: number;
  seen = new Set<string>();
  scored: [number[], number][] = [];
  private s: number;
  private rng: () => number;

  constructor(space: ParamDef[], cfg: Record<string, number | string>, seed: number) {
    this.space = space;
    this.pop = Number(cfg.ga_population ?? 14);
    this.mut = Number(cfg.ga_mutation_rate ?? 0.18);
    this.s = seed >>> 0;
    this.rng = () => {
      this.s = (this.s * 1664525 + 1013904223) >>> 0;
      return this.s / 2 ** 32;
    };
  }

  /** OPT-06: the RNG state, so a resumed run continues where it stopped. */
  rngState(): number {
    return this.s;
  }

  setRngState(state: number): void {
    this.s = state >>> 0;
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
    // A mature GA can converge so tightly that every crossover/mutation attempt
    // is already in `seen`, even though the full parameter space is enormous.
    // Fall back to broad random exploration so daemon rounds keep producing new
    // evaluations instead of silently completing with zero work.
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

/** The one objective shared by every optimizer tree. */
export function scoreMetrics(
  m: Record<string, number | null>,
  obj: Record<string, number>
): number {
  const net = m.net_pct, dd = m.dd_pct, trades = m.trades;
  if (net === null || net === undefined || Number.isNaN(net)) return -Infinity;
  if ((trades ?? 0) < (obj.min_trades ?? 30)) return -Infinity;
  const pf = m.profit_factor;
  if ((obj.min_profit_factor ?? 0) > 0 && (pf ?? 0) < obj.min_profit_factor!) return -Infinity;
  const ddPen = (obj.dd_weight ?? 1) * Math.max(0, dd ?? 0);
  const overtrade = (obj.overtrade_penalty ?? 0) * Math.max(0, (trades ?? 0) - (obj.overtrade_cap ?? 1e9));
  return net - ddPen - overtrade;
}

/** The deterministic per-coin seed offset the trees have always used. */
export function coinSeed(coin: string, baseSeed: number): number {
  let h = 0;
  for (const ch of coin) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return baseSeed + (h % 1000);
}

export interface ResumeResult {
  /** Number of prior evaluations replayed into the driver. */
  replayed: number;
  /** Seed keys already evaluated, so a seed is not re-run. */
  done: Set<string>;
}

const CHUNK = 4 * 1024 * 1024;

/**
 * Replay a coin's history into a driver and collect its seed keys in ONE pass.
 *
 * `OPT-07`: `loadDriver` and `seedDone` each read the whole `.jsonl` into a
 * string and split it, for every coin, concurrently. This reads in 4 MiB chunks
 * and never holds the file in memory.
 */
export function resumeFromResults(file: string, driver: Driver): ResumeResult {
  const done = new Set<string>();
  let replayed = 0;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { replayed, done };
  }
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = "";
    let offset = 0;
    const take = (line: string): void => {
      if (!line.trim()) return;
      let r: { genome?: number[]; score?: number | null; context?: unknown };
      try {
        r = JSON.parse(line);
      } catch {
        return; // skip a bad or partially written line
      }
      if (!r.genome) return;
      driver.tell(r.genome, r.score ?? null);
      replayed += 1;
      done.add(r.genome.join(",") + "|" + JSON.stringify(r.context ?? {}));
    };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (!n) break;
      offset += n;
      const text = carry + buf.toString("utf8", 0, n);
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
    if (carry) take(carry);
  } finally {
    fs.closeSync(fd);
  }
  return { replayed, done };
}

/**
 * Where a coin's RNG state lives. Beside the index rather than in `results/`,
 * because it is derived state and must be rebuildable by deleting it.
 */
function rngFile(treeDir: string, coin: string): string {
  return path.join(treeDir, "index", "rng", `${coin}.json`);
}

/** OPT-06: restore the RNG so a resumed run is not a fresh one. */
export function restoreRngState(treeDir: string, coin: string, driver: Driver): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(rngFile(treeDir, coin), "utf8")) as { state?: number };
    if (typeof raw.state !== "number") return false;
    driver.setRngState(raw.state);
    return true;
  } catch {
    return false;
  }
}

export function saveRngState(treeDir: string, coin: string, driver: Driver): void {
  const file = rngFile(treeDir, coin);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ state: driver.rngState(), savedAt: new Date().toISOString() }));
    fs.renameSync(tmp, file);
  } catch {
    // A tree on a read-only mount still runs; it just loses restart determinism.
  }
}

// ── OPT-08: make a result traceable to the inputs that produced it ───────────

/**
 * `OPT-08`: none of the reported results were reproducible or auditable from
 * the repository. `results/`, `best/`, `index/`, `archive/`, `SUMMARY.json` and
 * `seeds.json` are gitignored — correctly, they run to tens of gigabytes — so
 * every eval count in `BACKTESTING_SYSTEMS.md` was unverifiable, and
 * `PARAMETER_REDUCTION.md` cites an archive that is not in the repository at
 * all. Compounded by the trees having no Git history of their own.
 *
 * What is fixable here is the other half: making a stored result traceable to
 * the exact inputs that produced it. Every round writes a manifest recording
 * the content hash of every input file, the objective, the search settings, the
 * coin list, the engine revision and the runtime — and every result record
 * carries that manifest's id. A number from a run whose manifest is present can
 * be tied to its search space; one from before this change cannot, and the
 * absence of a `run` field says so.
 */
export interface RunManifest {
  id: string;
  tree: string;
  startedAt: string;
  /** sha256 of each input file, so a changed search space is visible. */
  inputs: Record<string, string | null>;
  objective: Record<string, number>;
  search: Record<string, number | string>;
  coins: string[];
  roundSize: number;
  engine: { node: string; revision: string | null };
}

function sha256File(file: string): string | null {
  try {
    // Loaded lazily: this module is imported by the API, which has no reason to
    // pull in crypto for a code path only the optimizer trees use.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

/** The checked-out revision, read from `.git` without shelling out. */
export function repoRevision(fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  for (let up = 0; up < 8; up += 1) {
    const gitDir = path.join(dir, ".git");
    try {
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (head.startsWith("ref: ")) {
        const ref = head.slice(5).trim();
        try {
          return fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
        } catch {
          // A packed ref; the HEAD name is still better than nothing.
          return ref;
        }
      }
      return head;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function buildRunManifest(
  treeDir: string,
  info: {
    objective: Record<string, number>;
    search: Record<string, number | string>;
    coins: string[];
    roundSize: number;
    startedAt?: string;
  }
): RunManifest {
  const inputs: Record<string, string | null> = {};
  for (const name of ["params.json", "base_params.json", "config.json", "coins.txt", "idmap.json", "seeds.json", "evalWorker.ts"]) {
    const file = path.join(treeDir, name);
    inputs[name] = fs.existsSync(file) ? sha256File(file) : null;
  }
  const manifest: Omit<RunManifest, "id"> = {
    tree: path.basename(treeDir),
    startedAt: info.startedAt ?? new Date().toISOString(),
    inputs,
    objective: info.objective,
    search: info.search,
    coins: info.coins,
    roundSize: info.roundSize,
    engine: { node: process.version, revision: repoRevision(treeDir) },
  };
  // The id covers everything EXCEPT the timestamp, so two runs over identical
  // inputs share an id and a changed search space produces a different one.
  const { startedAt: _ignored, ...identity } = manifest;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const id = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
  return { id, ...manifest };
}

/** Append the manifest to the tree's run log. Returns its id. */
export function recordRunManifest(treeDir: string, manifest: RunManifest): string {
  const file = path.join(treeDir, "index", "runs.jsonl");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(manifest) + "\n");
  } catch {
    // A read-only tree still runs; it just cannot record its provenance.
  }
  return manifest.id;
}
