/**
 * Walk-forward validation driver.
 *
 * For each fold and each eligible coin:
 *   1. Run a FRESH genetic search over the training window only (no state, no
 *      seeds, no carry-over from other folds or from optimizer1y1h).
 *   2. Pick a config from the training pool under three competing selection
 *      rules — this is the point of the exercise: we are testing the SELECTION
 *      RULE, not the coin.
 *        A "peak"      best optimizer score (net - dd), i.e. what runs today
 *        B "plateau"   the trained config agreeing with the most modal parameter
 *                      values across the training top-200 (plateau centre)
 *        C "multi"     Pareto-front best over net / dd / win% / pf / rr / risk
 *   3. Score all three, frozen, on the untouched test window.
 *
 * Nothing from step 3 ever feeds back into step 1 or 2.
 *
 *   npx tsx optimizer1y1h_wf/wf.ts                  # all folds, all coins
 *   npx tsx optimizer1y1h_wf/wf.ts --folds F5       # one fold (smoke test)
 *   npx tsx optimizer1y1h_wf/wf.ts --coins DEXEUSDT,NEARUSDT --evals 2000
 *
 * Completed (fold, coin) pairs are skipped on restart, so the run is resumable.
 * Output: folds/<foldId>/<coin>.json  (+ .jsonl of every training eval)
 */
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
// The driver and the objective are the SHARED ones. They were byte-identical
// here and in the five search trees apart from a comment and a type alias;
// tests/gaDriver.test.ts pins the shared implementation to the original
// candidate sequence and the original scores.
import type { ParamDef } from "../src/optimizer/gaDriver";
import { Driver, scoreMetrics } from "../src/optimizer/gaDriver";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PROCESS_LOCK = path.join(HERE, ".wflean.pid");
function acquireProcessLock(): void {
  try {
    fs.writeFileSync(PROCESS_LOCK, `${process.pid}\n`, { flag: "wx" });
  } catch {
    const prior = Number(fs.readFileSync(PROCESS_LOCK, "utf8").trim());
    let alive = false;
    try { process.kill(prior, 0); alive = true; } catch { /* stale */ }
    if (alive) throw new Error(`lean walk-forward already running as PID ${prior}`);
    fs.unlinkSync(PROCESS_LOCK);
    fs.writeFileSync(PROCESS_LOCK, `${process.pid}\n`, { flag: "wx" });
  }
}
function releaseProcessLock(): void {
  try {
    if (Number(fs.readFileSync(PROCESS_LOCK, "utf8").trim()) === process.pid) fs.unlinkSync(PROCESS_LOCK);
  } catch { /* gone */ }
}
acquireProcessLock();
process.on("exit", releaseProcessLock);

interface Space { parameters: ParamDef[]; objective: Record<string, number>; search: Record<string, number | string> }
interface Fold { id: string; trainStart: string; trainEnd: string; testStart: string; testEnd: string }
type Metrics = Record<string, number | null>;



/**
 * Average loss on a losing trade, as % of equity, implied by the compounding
 * identity (1 + kL)^wins * (1 - L)^losses = 1 + net/100, where the observed
 * win/loss size ratio k = pf * losses / wins. Same estimator as the analysis.
 */
function riskPerTrade(m: Metrics): number | null {
  const net = m.net_pct ?? 0, trades = m.trades ?? 0, wr = m.win_rate ?? 0, pf = m.profit_factor ?? 0;
  const w = Math.round(trades * wr / 100), l = trades - w;
  if (w <= 0 || l <= 0 || pf <= 0) return null;
  const M = 1 + net / 100;
  if (M <= 0) return null;
  const k = pf * l / w;
  const tgt = Math.log(M);
  const f = (L: number): number => (L >= 0.999 ? 1e9 : w * Math.log(1 + k * L) + l * Math.log(1 - L) - tgt);
  let lo = 1e-7, hi = 0.95;
  if (f(lo) * f(hi) > 0) {
    let best = 0, bv = Infinity;
    for (let i = 1; i < 1900; i++) {
      const L = i / 2000, v = Math.abs(f(L));
      if (v < bv) { bv = v; best = L; }
    }
    return best * 100;
  }
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2 * 100;
}

interface Trial { genome: number[]; params: Record<string, number | boolean>; metrics: Metrics; score: number }

/** Rule B: config agreeing with the most modal parameter values in the top-200. */
function plateauPick(pool: Trial[], space: ParamDef[]): Trial {
  const top = pool.slice(0, Math.min(200, pool.length));
  const modal: Record<string, string> = {};
  for (const p of space) {
    const c = new Map<string, number>();
    for (const t of top) {
      const k = String(t.params[p.name]);
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    let bk = "", bn = -1;
    for (const [k, n] of c) if (n > bn) { bn = n; bk = k; }
    modal[p.name] = bk;
  }
  let best = top[0]!, bestAgree = -1;
  for (const t of top) {
    const a = space.reduce((n, p) => n + (String(t.params[p.name]) === modal[p.name] ? 1 : 0), 0);
    if (a > bestAgree || (a === bestAgree && t.score > best.score)) { bestAgree = a; best = t; }
  }
  return best;
}

/** Rule C: Pareto front over the six factors, then the weighted percentile best. */
function multiPick(pool: Trial[]): Trial {
  const top = pool.slice(0, Math.min(1000, pool.length))
    .map((t) => ({ t, risk: riskPerTrade(t.metrics) }))
    .filter((x): x is { t: Trial; risk: number } => x.risk !== null && x.t.metrics.profit_factor !== null);
  if (top.length === 0) return pool[0]!;
  const vec = (x: { t: Trial; risk: number }): number[] => [
    x.t.metrics.net_pct ?? 0, -(x.t.metrics.dd_pct ?? 0), x.t.metrics.win_rate ?? 0,
    x.t.metrics.profit_factor ?? 0, Number(x.t.params.rrRatio ?? 0), -x.risk,
  ];
  const V = top.map(vec);
  const front: number[] = [];
  for (let i = 0; i < V.length; i++) {
    let dominated = false;
    for (let j = 0; j < V.length && !dominated; j++) {
      if (i === j) continue;
      let ge = true, gt = false;
      for (let k = 0; k < 6; k++) {
        if (V[j]![k]! < V[i]![k]!) { ge = false; break; }
        if (V[j]![k]! > V[i]![k]!) gt = true;
      }
      if (ge && gt) dominated = true;
    }
    if (!dominated) front.push(i);
  }
  const rankOf = (vals: number[]): number[] => {
    const idx = vals.map((_, i) => i).sort((a, b) => vals[b]! - vals[a]!);
    const out = new Array<number>(vals.length).fill(0);
    idx.forEach((i, r) => { out[i] = vals.length > 1 ? 1 - r / (vals.length - 1) : 1; });
    return out;
  };
  const cols = [0, 1, 2, 3, 4, 5].map((k) => rankOf(V.map((v) => v[k]!)));
  const W = [0.18, 0.18, 0.15, 0.15, 0.12, 0.12];
  let best = front[0]!, bs = -Infinity;
  for (const i of front) {
    const s = W.reduce((acc, w, k) => acc + w * cols[k]![i]!, 0);
    if (s > bs) { bs = s; best = i; }
  }
  return top[best]!.t;
}

const MONTH_MS = 30.44 * 86_400_000;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | null => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] ?? "" : null;
  };

  const spaceFile: Space = JSON.parse(fs.readFileSync(path.join(HERE, "params.json"), "utf8"));
  const space = spaceFile.parameters;
  const objective = spaceFile.objective as Record<string, number>;
  const search = spaceFile.search as Record<string, number | string>;
  const base: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(HERE, "base_params.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));

  const evalsPerFold = Number(flag("--evals") ?? config.evalsPerCoinPerFold ?? 25000);
  const minTrainMs = Number(config.minTrainMonths ?? 4) * MONTH_MS;

  const foldFilter = flag("--folds");
  const folds: Fold[] = (config.folds as Fold[])
    .filter((f) => !foldFilter || foldFilter.split(",").includes(f.id));

  const coinsArg = flag("--coins");
  const coins = (coinsArg
    ? coinsArg.split(",")
    : fs.readFileSync(path.join(HERE, "coins.txt"), "utf8").split("\n"))
    .map((l) => l.trim().replace(/^BINANCE:/, ""))
    .filter((l) => l && !l.startsWith("#"));

  const nWorkers = Math.max(1, Number(flag("--workers") ?? config.workers) || 4);
  console.log(`walk-forward: ${coins.length} coins x ${folds.length} folds, ${evalsPerFold} evals/coin/fold, ${nWorkers} workers`);
  console.log(`slippage=${config.slippageTicks} ticks, commission=${config.commissionPct}%/side, sizing: qty_pct_equity is part of the search space (baseline run)`);

  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const waiting: ((w: Worker) => void)[] = [];
  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker(path.join(HERE, "evalWorker.boot.mjs"), { workerData: { config } });
    workers.push(w); idle.push(w);
  }
  const acquire = (): Promise<Worker> => new Promise((res) => {
    const w = idle.pop();
    if (w) res(w); else waiting.push(res);
  });
  const release = (w: Worker): void => {
    const next = waiting.shift();
    if (next) next(w); else idle.push(w);
  };

  const send = <T>(w: Worker, msg: unknown): Promise<T> => new Promise((resolve, reject) => {
    const onMsg = (r: { ok: boolean; error?: string } & Record<string, unknown>): void => {
      w.off("message", onMsg); w.off("error", onErr);
      if (r.ok) resolve(r as T); else reject(new Error(r.error));
    };
    const onErr = (e: Error): void => { w.off("message", onMsg); w.off("error", onErr); reject(e); };
    w.on("message", onMsg); w.on("error", onErr);
    w.postMessage(msg);
  });

  let stop = false;
  process.on("SIGINT", () => { stop = true; console.log("stopping after current coin…"); });
  process.on("SIGTERM", () => { stop = true; });

  // Probe first candle per coin once, for fold eligibility.
  const firstBar = new Map<string, number>();
  {
    const w = await acquire();
    for (const coin of coins) {
      try {
        const r = await send<{ firstBarMs: number }>(w, { probe: true, coin });
        firstBar.set(coin, r.firstBarMs);
      } catch (err) {
        console.error(`[${coin}] probe failed: ${(err as Error).message} — coin skipped`);
      }
    }
    release(w);
  }

  const t0all = Date.now();
  let doneUnits = 0;
  const totalUnits = folds.length * coins.length;

  for (const fold of folds) {
    if (stop) break;
    const trainStart = Date.parse(fold.trainStart), trainEnd = Date.parse(fold.trainEnd);
    const testStart = Date.parse(fold.testStart), testEnd = Date.parse(fold.testEnd);
    const dir = path.join(HERE, "folds", fold.id);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n════ FOLD ${fold.id}  train ${fold.trainStart.slice(0, 10)}→${fold.trainEnd.slice(0, 10)}  test ${fold.testStart.slice(0, 10)}→${fold.testEnd.slice(0, 10)} ════`);

    const coinTask = async (coin: string): Promise<void> => {
      const outF = path.join(dir, `${coin}.json`);
      if (fs.existsSync(outF)) { doneUnits++; console.log(`[${fold.id}/${coin}] already done — skipped`); return; }
      const fb = firstBar.get(coin);
      if (fb === undefined) { doneUnits++; return; }
      const effTrainStart = Math.max(trainStart, fb);
      if (trainEnd - effTrainStart < minTrainMs) {
        doneUnits++;
        console.log(`[${fold.id}/${coin}] skipped: history — only ${((trainEnd - effTrainStart) / MONTH_MS).toFixed(1)} months of training data`);
        fs.writeFileSync(outF, JSON.stringify({ fold: fold.id, symbol: coin, skipped: "insufficient_history", train_months: Number(((trainEnd - effTrainStart) / MONTH_MS).toFixed(2)) }, null, 1));
        return;
      }

      let h = 0;
      for (const ch of coin + fold.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const d = new Driver(space, search, Number(search.random_seed ?? 42) + (h % 100000));
      const namer = new Driver(space, search, 0);
      const pool: Trial[] = [];
      const jl = fs.createWriteStream(path.join(dir, `${coin}.jsonl`), { flags: "a" });

      const w = await acquire();
      const t0 = Date.now();
      let ok = 0, failed = 0;
      try {
        for (let k = 0; k < evalsPerFold && !stop; k++) {
          const genome = d.ask();
          if (!genome) break;
          const tunables = namer.genomeToParams(genome);
          try {
            const r = await send<{ metrics: Metrics }>(w, {
              coin, genome, params: { ...base, ...tunables },
              startMs: effTrainStart, endMs: trainEnd,
            });
            const s = scoreMetrics(r.metrics, objective);
            d.tell(genome, Number.isFinite(s) ? s : null);
            if (Number.isFinite(s)) {
              pool.push({ genome, params: tunables, metrics: r.metrics, score: s });
              jl.write(JSON.stringify({ g: genome, m: r.metrics, s: Math.round(s * 1000) / 1000 }) + "\n");
            }
            ok++;
          } catch (err) {
            failed++;
            if (failed <= 3) console.error(`[${fold.id}/${coin}] eval failed: ${(err as Error).message}`);
            d.tell(genome, null);
          }
        }

        if (pool.length === 0) {
          fs.writeFileSync(outF, JSON.stringify({ fold: fold.id, symbol: coin, skipped: "no_valid_train_config", evals: ok }, null, 1));
          console.log(`[${fold.id}/${coin}] no config cleared min_trades in training`);
          return;
        }

        pool.sort((a, b) => b.score - a.score);
        const picks: Record<string, Trial> = {
          peak: pool[0]!,
          plateau: plateauPick(pool, space),
          multi: multiPick(pool),
        };

        // Freeze and score each pick on the untouched test window.
        const out: Record<string, unknown> = {
          fold: fold.id, symbol: coin,
          train: { start: new Date(effTrainStart).toISOString(), end: fold.trainEnd, evals: ok, failed, valid: pool.length },
          test: { start: fold.testStart, end: fold.testEnd },
          rules: {},
        };
        for (const [rule, t] of Object.entries(picks)) {
          let testMetrics: Metrics | null = null;
          try {
            const r = await send<{ metrics: Metrics }>(w, {
              coin, genome: t.genome, params: { ...base, ...t.params },
              startMs: testStart, endMs: testEnd,
            });
            testMetrics = r.metrics;
          } catch (err) {
            console.error(`[${fold.id}/${coin}] OOS eval failed (${rule}): ${(err as Error).message}`);
          }
          const inputs: Record<string, unknown> = {};
          space.forEach((p, i) => { inputs[p.id] = p.values[t.genome[i]!]; });
          (out.rules as Record<string, unknown>)[rule] = {
            params: t.params,
            train_metrics: t.metrics,
            train_score: Math.round(t.score * 1000) / 1000,
            train_risk_per_trade: riskPerTrade(t.metrics),
            test_metrics: testMetrics,
            test_risk_per_trade: testMetrics ? riskPerTrade(testMetrics) : null,
            inputs_to_apply: inputs,
          };
        }
        fs.writeFileSync(outF, JSON.stringify(out, null, 1));

        const p = picks.peak!.metrics, mm = (out.rules as Record<string, Record<string, Metrics>>).peak!.test_metrics;
        const dt = (Date.now() - t0) / 1000;
        console.log(`[${fold.id}/${coin}] ${ok} evals in ${dt.toFixed(0)}s (${(ok / dt).toFixed(1)}/s) | train net=${p.net_pct}% dd=${p.dd_pct}% tr=${p.trades} → TEST net=${mm?.net_pct ?? "n/a"}% dd=${mm?.dd_pct ?? "n/a"}% tr=${mm?.trades ?? "n/a"}`);
      } finally {
        jl.end();
        release(w);
        doneUnits++;
        const frac = doneUnits / totalUnits;
        const elapsed = (Date.now() - t0all) / 1000;
        if (frac > 0) {
          const eta = elapsed / frac - elapsed;
          console.log(`  progress ${doneUnits}/${totalUnits} (${(frac * 100).toFixed(1)}%), elapsed ${(elapsed / 3600).toFixed(1)}h, ETA ${(eta / 3600).toFixed(1)}h`);
        }
      }
    };

    await Promise.all(coins.map(coinTask));
  }

  for (const w of workers) await w.terminate();
  console.log(`\nwalk-forward finished in ${((Date.now() - t0all) / 3600000).toFixed(2)}h`);
}

main().catch((err) => { console.error(err); releaseProcessLock(); process.exit(1); });
