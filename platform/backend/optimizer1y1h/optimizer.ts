/**
 * Local optimizer — replaces the TradingView CDP autotuner with the in-process
 * backtest engine. Same search space (params.json), same seeds (seeds.json),
 * same objective and result formats as tv_autotuner, ~1000× the eval rate.
 *
 * This is the 1-hour instance: same strategy/engine/search space as the 15m
 * opt-results system, but config.timeframe = "1h". Histories are separate.
 *
 *   npx tsx optimizer1h/optimizer.ts --batch 200        # N evals per coin, once
 *   npx tsx optimizer1h/optimizer.ts --daemon           # loop until stopped
 *   npx tsx optimizer1h/optimizer.ts --round 50         # evals per coin per round
 *   npx tsx optimizer1h/optimizer.ts --coins DEXEUSDT,ZECUSDT
 *
 * Output: optimizer1h/results/<coin>.jsonl, optimizer1h/best/<coin>.json,
 * optimizer1h/SUMMARY.json — identical shape to tv_autotuner so the same
 * leaderboard tooling works.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ParamDef } from "../src/optimizer/gaDriver";
import {
  Driver, coinSeed, resumeFromResults, restoreRngState, saveRngState, scoreMetrics,
} from "../src/optimizer/gaDriver";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Prevent launchd and manual commands from writing the same histories at once.
const PROCESS_LOCK = path.join(HERE, ".optimizer.pid");
function acquireProcessLock(): void {
  try {
    fs.writeFileSync(PROCESS_LOCK, `${process.pid}\n`, { flag: "wx" });
  } catch {
    const prior = Number(fs.readFileSync(PROCESS_LOCK, "utf8").trim());
    let alive = false;
    try { process.kill(prior, 0); alive = true; } catch { /* stale lock */ }
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

interface Space { parameters: ParamDef[]; objective: Record<string, number>; search: Record<string, number | string> }


// ── objective (identical to tv_autotuner score_metrics) ───────────────────────

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
      win_rate: metrics.win_rate, trades: metrics.trades,
      profit_factor: metrics.profit_factor, sharpe: null,
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
    console.log(`[${coin}] ★ NEW BEST score=${score.toFixed(2)} net=${metrics.net_pct}% dd=${metrics.dd_pct}% trades=${metrics.trades}`);
  }
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
      // OPT-06 / OPT-07: one streaming pass over the history produces BOTH the
      // replayed driver and the set of seeds already evaluated, and the RNG
      // state is restored so a resumed run continues rather than restarting.
      const d = new Driver(space, search, coinSeed(coin, Number(search.random_seed ?? 42)));
      const resumed = resumeFromResults(path.join(RESULTS, `${coin}.jsonl`), d);
      if (resumed.replayed > 0) console.log(`[${coin}] resumed ${resumed.replayed} prior evaluations`);
      restoreRngState(HERE, coin, d);
      const done = resumed.done;
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
        saveRngState(HERE, coin, d);
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
