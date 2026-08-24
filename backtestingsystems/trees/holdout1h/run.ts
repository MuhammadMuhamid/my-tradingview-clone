/**
 * Holdout validation driver for opt1hyear-results.
 *
 * For each coin:
 *   1. Pull the top-N configs from the live leaderboard index, ordered by
 *      `score DESC, file_offset ASC` — byte-for-byte the ordering that
 *      `opt1hyear-results <coin> best` prints.
 *   2. Read each config's full params back out of results/<coin>.jsonl.
 *   3. Replay every one of them over the coin's HOLDOUT window: from its first
 *      available bar (or config.holdoutStart, whichever is later) up to
 *      config.holdoutEnd — history the optimizer never saw.
 *
 * The point is NOT to crown a winner. With 1000 candidates, the best holdout
 * result is itself a lucky draw. The point is the DISTRIBUTION: does the rank a
 * config earned in-sample predict anything out-of-sample? report.py answers that.
 *
 *   npx tsx holdout1h/run.ts                    # all coins
 *   npx tsx holdout1h/run.ts --coins ZECUSDT    # one coin
 *   npx tsx holdout1h/run.ts --top 200          # smaller pool
 *
 * Resumable: a coin whose out/<coin>.jsonl already holds topN rows is skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPT = path.join(HERE, "..", "optimizer1y1h");
const OUT = path.join(HERE, "out");
const CONFIGS = path.join(HERE, "configs");

const LOCK = path.join(HERE, ".holdout.pid");
function acquireLock(): void {
  try { fs.writeFileSync(LOCK, `${process.pid}\n`, { flag: "wx" }); }
  catch {
    const prior = Number(fs.readFileSync(LOCK, "utf8").trim());
    let alive = false;
    try { process.kill(prior, 0); alive = true; } catch { /* stale */ }
    if (alive) throw new Error(`holdout already running as PID ${prior}`);
    fs.unlinkSync(LOCK);
    fs.writeFileSync(LOCK, `${process.pid}\n`, { flag: "wx" });
  }
}
function releaseLock(): void {
  try { if (Number(fs.readFileSync(LOCK, "utf8").trim()) === process.pid) fs.unlinkSync(LOCK); } catch { /* gone */ }
}
acquireLock();
process.on("exit", releaseLock);

interface Row { file_offset: number; score: number; net: number; dd: number; wr: number; trades: number; pf: number }

/**
 * Top-N configs for a coin, pre-extracted by extract_top.py in exactly the order
 * `opt1hyear-results <coin> best` uses (score DESC, file_offset ASC). Kept in a
 * separate step so this tree needs no sqlite driver added to the project.
 */
function topConfigs(coin: string, n: number): { rank: number; row: Row; params: Record<string, unknown> }[] {
  const f = path.join(CONFIGS, `${coin}.json`);
  if (!fs.existsSync(f)) return [];
  const all = JSON.parse(fs.readFileSync(f, "utf8")) as
    { rank: number; in_sample: Row; params: Record<string, unknown> }[];
  return all.slice(0, n).map((x) => ({ rank: x.rank, row: x.in_sample, params: x.params }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | null => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? "" : null; };

  const config = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
  const base: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(OPT, "base_params.json"), "utf8"));
  const topN = Number(flag("--top") ?? config.topN ?? 1000);
  const nWorkers = Math.max(1, Number(flag("--workers") ?? config.workers) || 6);
  const holdoutStart = Date.parse(String(config.holdoutStart));
  const holdoutEnd = Date.parse(String(config.holdoutEnd));

  const coinsArg = flag("--coins");
  const coins = (coinsArg
    ? coinsArg.split(",")
    : fs.readFileSync(path.join(OPT, "coins.txt"), "utf8").split("\n"))
    .map((l) => l.trim().replace(/^BINANCE:/, ""))
    .filter((l) => l && !l.startsWith("#"));

  fs.mkdirSync(OUT, { recursive: true });
  console.log(`holdout: ${coins.length} coins x top ${topN} configs, ${nWorkers} workers`);
  console.log(`window: ${config.holdoutStart.slice(0, 10)} -> ${config.holdoutEnd.slice(0, 10)} (per coin, clipped to its first bar)`);
  console.log(`sizing: FIXED $${config.qtyCash} per trade (no compounding) | commission ${config.commissionPct}%/side | slippage ${config.slippageTicks} ticks\n`);

  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const waiting: ((w: Worker) => void)[] = [];
  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker(path.join(HERE, "evalWorker.boot.mjs"), { workerData: { config } });
    workers.push(w); idle.push(w);
  }
  const acquire = (): Promise<Worker> => new Promise((res) => {
    const w = idle.pop(); if (w) res(w); else waiting.push(res);
  });
  const release = (w: Worker): void => { const nx = waiting.shift(); if (nx) nx(w); else idle.push(w); };
  const send = <T>(w: Worker, msg: unknown): Promise<T> => new Promise((resolve, reject) => {
    const onMsg = (r: { ok: boolean; error?: string } & Record<string, unknown>): void => {
      w.off("message", onMsg); w.off("error", onErr);
      if (r.ok) resolve(r as T); else reject(new Error(r.error));
    };
    const onErr = (e: Error): void => { w.off("message", onMsg); w.off("error", onErr); reject(e); };
    w.on("message", onMsg); w.on("error", onErr); w.postMessage(msg);
  });

  let stop = false;
  process.on("SIGINT", () => { stop = true; console.log("stopping after current coin…"); });
  process.on("SIGTERM", () => { stop = true; });

  const t0all = Date.now();
  for (const coin of coins) {
    if (stop) break;
    const outF = path.join(OUT, `${coin}.jsonl`);
    if (fs.existsSync(outF) && fs.readFileSync(outF, "utf8").split("\n").filter(Boolean).length >= topN) {
      console.log(`[${coin}] already done — skipped`);
      continue;
    }

    const w = await acquire();
    let firstBarMs = 0, barCount = 0;
    try {
      const pr = await send<{ firstBarMs: number; barCount: number }>(w, { probe: true, coin });
      firstBarMs = pr.firstBarMs; barCount = pr.barCount;
    } catch (err) {
      console.log(`[${coin}] no data — skipped (${(err as Error).message})`);
      release(w); continue;
    }
    release(w);

    const start = Math.max(holdoutStart, firstBarMs);
    const months = (holdoutEnd - start) / (30.44 * 86_400_000);
    if (months < 3) {
      console.log(`[${coin}] skipped: only ${months.toFixed(1)} months of pre-optimizer history`);
      fs.writeFileSync(path.join(OUT, `${coin}.skipped.json`),
        JSON.stringify({ coin, reason: "insufficient_holdout", months: Number(months.toFixed(2)) }, null, 1));
      continue;
    }

    const configs = topConfigs(coin, topN);
    if (configs.length === 0) { console.log(`[${coin}] no leaderboard rows — skipped`); continue; }

    const t0 = Date.now();
    fs.writeFileSync(outF, "");
    const stream = fs.createWriteStream(outF, { flags: "a" });
    let ok = 0, failed = 0;

    await Promise.all(Array.from({ length: nWorkers }, async () => {
      for (;;) {
        const item = configs.shift();
        if (!item || stop) break;
        const ww = await acquire();
        try {
          const r = await send<{ metrics: Record<string, number | null> }>(ww, {
            coin, rank: item.rank, params: { ...base, ...item.params },
            startMs: start, endMs: holdoutEnd,
          });
          stream.write(JSON.stringify({
            rank: item.rank,
            in_sample: { score: item.row.score, net: item.row.net, dd: item.row.dd, wr: item.row.wr, trades: item.row.trades, pf: item.row.pf },
            holdout: r.metrics,
            params: item.params,
          }) + "\n");
          ok++;
        } catch (err) {
          failed++;
          if (failed <= 3) console.error(`  [${coin}] rank ${item.rank} failed: ${(err as Error).message}`);
        } finally { release(ww); }
      }
    }));
    stream.end();

    const dt = (Date.now() - t0) / 1000;
    console.log(`[${coin}] ${ok} configs in ${dt.toFixed(0)}s (${(ok / dt).toFixed(1)}/s) | holdout ${new Date(start).toISOString().slice(0, 10)} -> ${config.holdoutEnd.slice(0, 10)} (${months.toFixed(1)}mo, ${barCount} bars) | ${failed} failed`);
  }

  for (const w of workers) await w.terminate();
  console.log(`\nholdout finished in ${((Date.now() - t0all) / 60000).toFixed(1)} min`);
}

main().catch((e) => { console.error(e); releaseLock(); process.exit(1); });
