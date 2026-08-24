/**
 * Local optimizer — replaces the TradingView CDP autotuner with the in-process
 * backtest engine. Same search space (params.json), same seeds (seeds.json),
 * same objective and result formats as tv_autotuner, ~1000× the eval rate.
 *
 *   npx tsx optimizer/optimizer.ts --batch 200        # N evals per coin, once
 *   npx tsx optimizer/optimizer.ts --daemon           # loop until stopped
 *   npx tsx optimizer/optimizer.ts --round 50         # evals per coin per round
 *   npx tsx optimizer/optimizer.ts --coins DEXEUSDT,ZECUSDT
 *
 * Output: optimizer/results/<coin>.jsonl, optimizer/best/<coin>.json,
 * optimizer/SUMMARY.json — identical shape to tv_autotuner so the same
 * leaderboard tooling works.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Prevent launchd and manual commands from writing the same histories at once.
const PROCESS_LOCK = path.join(HERE, ".optimizer.pid");
function acquireProcessLock(): void {
  try {
    fs.writeFileSync(PROCESS_LOCK, `${process.pid}\n`, { flag: "wx" });
  } catch {
    const prior = Number(fs.readFileSync(PROCESS_LOCK, "utf8").trim());
    // `process.kill(pid, 0)` alone is NOT enough: the OS recycles PIDs, so a
    // dead optimizer's PID can later belong to an unrelated process (this fired
    // on 2026-08-21, when the stale PID had been reused by the frontend's
    // next-server and the tree refused to start). Confirm the PID is actually
    // THIS optimizer before believing the lock.
    let alive = false;
    try {
      process.kill(prior, 0);
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(prior)], { encoding: "utf8" });
      alive = cmd.includes("optimizer1y15m");
    } catch { /* stale lock */ }
    if (alive) throw new Error(`optimizer already running as PID ${prior}`);
    fs.unlinkSync(PROCESS_LOCK);
    fs.writeFileSync(PROCESS_LOCK, `${process.pid}\n`, { flag: "wx" });
  }
}
function releaseProcessLock(): void {
  try {
    if (Number(fs.readFileSync(PROCESS_LOCK, "utf8").trim()) === process.pid) fs.unlinkSync(PROCESS_LOCK);
  } catch { /* already removed */ }
}
acquireProcessLock();
process.on("exit", releaseProcessLock);

interface ParamDef { name: string; id: string; type: string; values: (number | boolean)[] }
interface Space { parameters: ParamDef[]; objective: Record<string, number>; search: Record<string, number | string> }

// ── GA driver (port of tv_autotuner Driver) ────────────────────────────────────
class Driver {
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

// ── objective (identical to tv_autotuner score_metrics) ───────────────────────
function scoreMetrics(m: Record<string, number | null>, obj: Record<string, number>): number {
  const net = m.net_pct, dd = m.dd_pct, trades = m.trades;
  if (net === null || net === undefined || Number.isNaN(net)) return -Infinity;
  if ((trades ?? 0) < (obj.min_trades ?? 30)) return -Infinity;
  const pf = m.profit_factor;
  if ((obj.min_profit_factor ?? 0) > 0 && (pf ?? 0) < obj.min_profit_factor!) return -Infinity;
  let s = net - (obj.dd_weight ?? 1) * Math.abs(dd ?? 0);
  s -= (obj.overtrade_penalty ?? 0) * Math.max(0, (trades ?? 0) - (obj.overtrade_cap ?? 600));
  return s;
}

// ── seed handling (params + in_XX context via idmap) ──────────────────────────
function loadSeeds(coin: string, space: ParamDef[], idmap: Record<string, string>):
  { genome: number[]; extraParams: Record<string, unknown>; note: string }[] {
  const f = path.join(HERE, "seeds.json");
  if (!fs.existsSync(f)) return [];
  const all = JSON.parse(fs.readFileSync(f, "utf8"));
  const entries = all[coin] ?? [];
  const out: { genome: number[]; extraParams: Record<string, unknown>; note: string }[] = [];
  for (const e of entries) {
    const pIn = e.params ?? {};
    const genome = space.map((p) => {
      const v = pIn[p.name];
      if (v === undefined) return 0;
      if (p.type === "bool") {
        const idx = p.values.indexOf(Boolean(v));
        return idx >= 0 ? idx : 0;
      }
      let bi = 0, bd = Infinity;
      p.values.forEach((pv, i) => {
        const d = Math.abs(Number(pv) - Number(v));
        if (d < bd) { bd = d; bi = i; }
      });
      return bi;
    });
    // context: in_XX static overrides → engine param names
    const extraParams: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(e.context ?? {})) {
      const name = idmap[id];
      if (name) extraParams[name] = v;
    }
    out.push({ genome, extraParams, note: e.note ?? "" });
  }
  return out;
}

// ── result persistence (same shapes as tv_autotuner) ──────────────────────────
const RESULTS = path.join(HERE, "results");
const BEST = path.join(HERE, "best");

function record(coin: string, genome: number[], params: Record<string, unknown>,
  metrics: Record<string, number | null>, score: number, space: ParamDef[],
  extra?: Record<string, unknown>): void {
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString().slice(0, 19) + "+00:00",
    symbol: coin, genome, params,
    metrics: {
      net_pct: metrics.net_pct, net_usdt: metrics.net_usdt, dd_pct: metrics.dd_pct,
      // `trades` = distinct ENTRIES (evalWorker). `legs` = closed exit legs, which
      // is far higher when partial TPs are on. The min_trades gate reads `trades`.
      win_rate: metrics.win_rate, trades: metrics.trades, legs: metrics.legs ?? null,
      leg_win_rate: metrics.leg_win_rate ?? null,
      profit_factor: metrics.profit_factor, sharpe: null,
      // Exit-reason tally, counted per ENTRY not per leg (partial TPs close one
      // entry as several legs, which would inflate a leg-based rate).
      // "Stop filled" != "trade lost": a trailing/break-even stop books a
      // PROFITABLE exit as SL, so the tally is split by the stopped portion's P&L.
      sl_hit: metrics.sl_hit ?? null, sl_rate: metrics.sl_rate ?? null,
      sl_loss: metrics.sl_loss ?? null, sl_loss_rate: metrics.sl_loss_rate ?? null,
      sl_profit: metrics.sl_profit ?? null, sl_profit_rate: metrics.sl_profit_rate ?? null,
      tp_hit: metrics.tp_hit ?? null,
      // Out-of-sample: never seen by the search, carried so a curve-fitted
      // config shows up as an IS/OOS collapse on the leaderboard.
      oos_net_pct: metrics.oos_net_pct ?? null, oos_dd_pct: metrics.oos_dd_pct ?? null,
      oos_win_rate: metrics.oos_win_rate ?? null, oos_trades: metrics.oos_trades ?? null,
      oos_profit_factor: metrics.oos_profit_factor ?? null,
      oos_sl_hit: metrics.oos_sl_hit ?? null, oos_sl_rate: metrics.oos_sl_rate ?? null,
      oos_sl_loss: metrics.oos_sl_loss ?? null, oos_sl_loss_rate: metrics.oos_sl_loss_rate ?? null,
      oos_sl_profit: metrics.oos_sl_profit ?? null, oos_sl_profit_rate: metrics.oos_sl_profit_rate ?? null,
      oos_tp_hit: metrics.oos_tp_hit ?? null,
      full_net_pct: metrics.full_net_pct ?? null, full_dd_pct: metrics.full_dd_pct ?? null,
    },
    score: Number.isFinite(score) ? Math.round(score * 1000) / 1000 : null,
    ...(extra ?? {}),
  };
  fs.appendFileSync(path.join(RESULTS, `${coin}.jsonl`), JSON.stringify(rec) + "\n");

  const bestF = path.join(BEST, `${coin}.json`);
  let cur: { score?: number } | null = null;
  if (fs.existsSync(bestF)) { try { cur = JSON.parse(fs.readFileSync(bestF, "utf8")); } catch { cur = null; } }
  if (Number.isFinite(score) && (!cur || score > (cur.score ?? -Infinity))) {
    const inputs: Record<string, unknown> = {};
    space.forEach((p, k) => { inputs[p.id] = p.values[genome[k]!]; });
    rec.inputs_to_apply = inputs;
    fs.writeFileSync(bestF, JSON.stringify(rec, null, 1));
    console.log(`[${coin}] ★ NEW BEST score=${score.toFixed(2)} net=${metrics.net_pct}% dd=${metrics.dd_pct}% trades=${metrics.trades} | OOS net=${metrics.oos_net_pct}% dd=${metrics.oos_dd_pct}%`);
  }
}

function loadDriver(coin: string, space: ParamDef[], search: Record<string, number | string>): Driver {
  let h = 0;
  for (const ch of coin) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const d = new Driver(space, search, Number(search.random_seed ?? 42) + (h % 1000));
  const f = path.join(RESULTS, `${coin}.jsonl`);
  if (fs.existsSync(f)) {
    let n = 0;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        d.tell(r.genome, r.score ?? null);
        n++;
      } catch { /* skip bad line */ }
    }
    if (n > 0) console.log(`[${coin}] resumed ${n} prior evaluations`);
  }
  return d;
}

function seedDone(coin: string): Set<string> {
  const done = new Set<string>();
  const f = path.join(RESULTS, `${coin}.jsonl`);
  if (!fs.existsSync(f)) return done;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      done.add(r.genome.join(",") + "|" + JSON.stringify(r.context ?? {}));
    } catch { /* ignore */ }
  }
  return done;
}

// ── worker pool ────────────────────────────────────────────────────────────────
interface Job {
  coin: string; genome: number[]; params: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] ?? "" : null;
  };
  const daemon = argv.includes("--daemon");
  const roundSize = Number(flag("--round") ?? flag("--batch") ?? 50);

  const spaceFile: Space = JSON.parse(fs.readFileSync(path.join(HERE, "params.json"), "utf8"));
  const space = spaceFile.parameters;
  const objective = spaceFile.objective as Record<string, number>;
  const search = spaceFile.search as Record<string, number | string>;
  const idmap: Record<string, string> = JSON.parse(fs.readFileSync(path.join(HERE, "idmap.json"), "utf8"));
  const base: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(HERE, "base_params.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));

  const coinsArg = flag("--coins");
  const coins = (coinsArg
    ? coinsArg.split(",")
    : fs.readFileSync(path.join(HERE, "coins.txt"), "utf8").split("\n"))
    .map((l) => l.trim().toUpperCase().replace(/^BINANCE:/, ""))
    .filter((l) => l && !l.startsWith("#"));

  const nWorkers = Math.max(1, Number(config.workers) || os.cpus().length - 2);
  console.log(`optimizer: ${coins.length} coins, ${nWorkers} workers, round=${roundSize}, daemon=${daemon}`);

  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const waiting: ((w: Worker) => void)[] = [];
  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker(path.join(HERE, "evalWorker.boot.mjs"), {
      workerData: { config },
    });
    workers.push(w);
    idle.push(w);
  }
  const acquire = (): Promise<Worker> =>
    new Promise((res) => {
      const w = idle.pop();
      if (w) res(w); else waiting.push(res);
    });
  const release = (w: Worker): void => {
    const next = waiting.shift();
    if (next) next(w); else idle.push(w);
  };

  const runJob = (w: Worker, job: Job): Promise<Record<string, number | null>> =>
    new Promise((resolve, reject) => {
      const onMsg = (msg: { ok: boolean; metrics?: Record<string, number | null>; error?: string }): void => {
        w.off("message", onMsg);
        w.off("error", onErr);
        if (msg.ok) resolve(msg.metrics!); else reject(new Error(msg.error));
      };
      const onErr = (err: Error): void => {
        w.off("message", onMsg);
        w.off("error", onErr);
        reject(err);
      };
      w.on("message", onMsg);
      w.on("error", onErr);
      w.postMessage(job);
    });

  let stop = false;
  process.on("SIGINT", () => { stop = true; console.log("stopping after current evals…"); });
  process.on("SIGTERM", () => { stop = true; });

  let round = 0;
  do {
    round++;
    console.log(`════ ROUND ${round} (${roundSize} evals/coin) ════`);
    const t0 = Date.now();
    let evals = 0;

    // Per-coin sequential GA, coins in parallel across the pool.
    const coinTask = async (coin: string): Promise<void> => {
      const d = loadDriver(coin, space, search);
      const done = seedDone(coin);
      const seeds = loadSeeds(coin, space, idmap).filter((s) => {
        const key = s.genome.join(",") + "|" + JSON.stringify(
          Object.keys(s.extraParams).length > 0 ? { ctx: s.extraParams } : {});
        return !done.has(key);
      });
      const w = await acquire();
      try {
        for (let k = 0; k < roundSize && !stop; k++) {
          const seed = seeds.shift();
          const genome = seed ? seed.genome : d.ask();
          if (!genome) break;
          const tunables = new Driver(space, search, 0).genomeToParams(genome);
          const params = { ...base, ...tunables, ...(seed?.extraParams ?? {}) };
          const job: Job = { coin, genome, params };
          try {
            const m = await runJob(w, job);
            const s = scoreMetrics(m, objective);
            const extra: Record<string, unknown> = {};
            if (seed) {
              extra.seed = true;
              extra.note = seed.note;
              if (Object.keys(seed.extraParams).length > 0) extra.context = { ctx: seed.extraParams };
            }
            record(coin, genome, tunables, m, s, space, extra);
            d.tell(genome, Number.isFinite(s) ? s : null);
            evals++;
          } catch (err) {
            console.error(`[${coin}] eval failed: ${(err as Error).message}`);
            d.tell(genome, null);
          }
        }
      } finally {
        release(w);
      }
    };

    await Promise.all(coins.map(coinTask));

    // summary
    const rows: Record<string, unknown>[] = [];
    for (const coin of coins) {
      const f = path.join(BEST, `${coin}.json`);
      if (!fs.existsSync(f)) continue;
      const b = JSON.parse(fs.readFileSync(f, "utf8"));
      rows.push({ symbol: coin, score: b.score, ...(b.metrics ?? {}), params: b.params });
    }
    rows.sort((a, b) => ((b.score as number) ?? -1e18) - ((a.score as number) ?? -1e18));
    fs.writeFileSync(path.join(HERE, "SUMMARY.json"), JSON.stringify({
      generated_utc: new Date().toISOString(), timeframe: config.timeframe, leaderboard: rows,
    }, null, 1));
    const dt = (Date.now() - t0) / 1000;
    console.log(`round ${round} done: ${evals} evals in ${dt.toFixed(0)}s (${(evals / dt).toFixed(1)}/s)`);
  } while (daemon && !stop);

  for (const w of workers) await w.terminate();
}

main().catch((err) => { console.error(err); releaseProcessLock(); process.exit(1); });
