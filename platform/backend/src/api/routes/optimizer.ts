/**
 * Optimizer results API — exposes the local GA optimizer's best configs
 * (optimizer/best/*.json + results/*.jsonl) to the frontend so the chart can
 * one-click load a coin's winning parameters.
 *
 * A "best config" the optimizer stores contains only the 31 tunable params;
 * the full runnable config = base_params.json (verified common statics) merged
 * with those tunables. This route does that merge server-side and returns a
 * complete params object plus the properties/timeframe/range the optimizer
 * used, so the chart reproduces the leaderboard number exactly.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

type OptimizerSystem = "current" | "one-year";

function optimizerKey(timeframe = "15m", system: OptimizerSystem = "current"): string {
  if (system === "one-year") {
    if (timeframe === "1h") return "optimizer1y1h";
    if (timeframe === "5m") return "optimizer1y5m";
    return "optimizer1y15m";
  }
  return timeframe === "1h" ? "optimizer1h" : timeframe === "5m" ? "optimizer5m" : "optimizer";
}

function optimizerDir(
  strategy = "ma_rr_v9",
  timeframe = "15m",
  system: OptimizerSystem = "current"
): string {
  // SRTrend now has a single optimizer tree: the one-year 1-hour system. The
  // former sr_optimizer15m / sr_optimizer5m trees were removed on 2026-07-30.
  if (strategy === "srtrend_v10") return path.join(process.cwd(), "sr_optimizer1h");
  // MTF Confluence Lean has one tree per chart timeframe.
  if (strategy === "mtf_lean") {
    return path.join(process.cwd(), timeframe === "15m" ? "lean_optimizer15m" : "optimizer1y5m");
  }
  return path.join(process.cwd(), optimizerKey(timeframe, system));
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface OptConfig {
  range: { start: string; end: string };
  initialCapital: number;
  commissionPct: number;
  slippageTicks: number;
  timeframe: string;
}

interface BestRec {
  ts: string;
  symbol: string;
  genome: number[];
  params: Record<string, unknown>;
  metrics: Record<string, number | null>;
  score: number | null;
}

function loadConfig(optDir: string): OptConfig {
  return (
    readJson<OptConfig>(path.join(optDir, "config.json")) ?? {
      range: { start: "2025-11-01T00:00:00Z", end: "now" },
      initialCapital: 1000,
      commissionPct: 0.1,
      slippageTicks: 0,
      timeframe: "15m",
    }
  );
}

function baseParams(optDir: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>(path.join(optDir, "base_params.json")) ?? {};
}

interface RawCountEntry { size: number; count: number }

/** Incremental newline count: never load multi-gigabyte JSONL histories into RAM. */
function resultCounts(optDir: string, resultFiles: string[]): Record<string, number> {
  const cacheFile = path.join(optDir, "index", "raw_counts.json");
  const cache = readJson<Record<string, RawCountEntry>>(cacheFile) ?? {};
  const next: Record<string, RawCountEntry> = {};
  for (const file of resultFiles) {
    const full = path.join(optDir, "results", file);
    const size = fs.statSync(full).size;
    const prior = cache[file] ?? { size: 0, count: 0 };
    let offset = size < prior.size ? 0 : prior.size;
    let count = size < prior.size ? 0 : prior.count;
    if (size > offset) {
      const fd = fs.openSync(full, "r");
      try {
        const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
        while (offset < size) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - offset), offset);
          if (!n) break;
          for (let i = 0; i < n; i += 1) if (buf[i] === 10) count += 1;
          offset += n;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    next[file] = { size, count };
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, cacheFile);
  return Object.fromEntries(
    Object.entries(next).map(([file, entry]) => [file.slice(0, -6), entry.count])
  );
}

/** Full runnable params = base statics + this result's tunables. */
function fullParams(rec: BestRec, optDir: string): Record<string, unknown> {
  return { ...baseParams(optDir), ...rec.params };
}

/** Suggested Strategy-Tester properties to reproduce the optimizer's number. */
function properties(cfg: OptConfig, params: Record<string, unknown>) {
  const nowIso = new Date().toISOString().slice(0, 10);
  return {
    initialCapital: cfg.initialCapital,
    commissionPct: cfg.commissionPct,
    slippageTicks: cfg.slippageTicks,
    qtyCash: Number(params.qty_cash ?? 930),
    qtyType: Number(params.qty_pct_equity ?? 0) > 0 ? "percent_of_equity" : "cash",
    qtyValue: Number(params.qty_pct_equity ?? 0) > 0
      ? Number(params.qty_pct_equity)
      : Number(params.qty_cash ?? 930),
    timeframe: cfg.timeframe,
    rangeStart: cfg.range.start.slice(0, 10),
    rangeEnd: cfg.range.end === "now" ? nowIso : cfg.range.end.slice(0, 10),
  };
}

/** Deduped, score-sorted result history for a coin. */
function rankedHistory(symbol: string, resultsDir: string): BestRec[] {
  const f = path.join(resultsDir, `${symbol}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const seen = new Set<string>();
  const recs: BestRec[] = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: BestRec;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.score === null || r.score === undefined) continue;
    const g = (r.genome ?? []).join(",");
    if (seen.has(g)) continue;
    seen.add(g);
    recs.push(r);
  }
  recs.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  return recs;
}

export async function optimizerRoutes(app: FastifyInstance): Promise<void> {
  // Leaderboard across all coins with a best file.
  app.get("/api/optimizer/leaderboard", async (req) => {
    const q = req.query as { strategy?: string; timeframe?: string; system?: OptimizerSystem };
    const dashboardDir = process.env.OPTIMIZER_DASHBOARD_DIR;
    if (q.strategy !== "srtrend_v10" && dashboardDir) {
      const snapshot = readJson<Record<string, unknown>>(
        path.join(dashboardDir, `${optimizerKey(q.timeframe, q.system)}.json`)
      );
      if (snapshot) return snapshot;
    }
    const optDir = optimizerDir(q.strategy, q.timeframe, q.system);
    const bestDir = path.join(optDir, "best"), resultsDir = path.join(optDir, "results");
    const cfg = loadConfig(optDir);
    const rows: unknown[] = [];
    const resultFiles = fs.existsSync(resultsDir)
      ? fs.readdirSync(resultsDir).filter((f) => f.endsWith(".jsonl"))
      : [];
    const counts = resultCounts(optDir, resultFiles);
    if (fs.existsSync(bestDir)) {
      for (const file of fs.readdirSync(bestDir)) {
        if (!file.endsWith(".json")) continue;
        const rec = readJson<BestRec>(path.join(bestDir, file));
        if (!rec) continue;
        const symbol = file.slice(0, -5);
        const tests = counts[symbol] ?? 0;
        rows.push({ symbol, score: rec.score, metrics: rec.metrics, tests });
      }
    }
    rows.sort((a, b) =>
      (((b as { score: number }).score ?? -1e18) - ((a as { score: number }).score ?? -1e18)));
    return {
      system: q.system ?? "current",
      timeframe: cfg.timeframe,
      range: cfg.range,
      totalBacktests: Object.values(counts).reduce((sum, n) => sum + n, 0),
      leaderboard: rows,
    };
  });

  // Best (or rank-N) config for one coin, ready to load onto the chart.
  app.get("/api/optimizer/best/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const sym = symbol.toUpperCase();
    const q = req.query as { rank?: string; strategy?: string; timeframe?: string; system?: OptimizerSystem };
    const optDir = optimizerDir(q.strategy, q.timeframe, q.system);
    const bestDir = path.join(optDir, "best"), resultsDir = path.join(optDir, "results");
    const cfg = loadConfig(optDir);

    let rec: BestRec | null;
    if (q.rank) {
      const recs = rankedHistory(sym, resultsDir);
      const rank = Number(q.rank);
      if (!(rank >= 1 && rank <= recs.length)) {
        return reply.code(404).send({ error: `${sym} has ${recs.length} results` });
      }
      rec = recs[rank - 1]!;
    } else {
      rec = readJson<BestRec>(path.join(bestDir, `${sym}.json`));
      if (!rec) return reply.code(404).send({ error: `no optimizer result yet for ${sym}` });
    }

    const params = fullParams(rec, optDir);
    return {
      symbol: sym,
      rank: q.rank ? Number(q.rank) : 1,
      score: rec.score,
      foundAt: rec.ts,
      metrics: rec.metrics,
      params,
      tunedParams: rec.params,
      properties: properties(cfg, params),
      timeframe: cfg.timeframe,
      optimizerSystem: q.system ?? "current",
      strategyKey: q.strategy ?? "ma_rr_v9",
    };
  });
}
