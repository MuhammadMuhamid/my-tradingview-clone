/**
 * Optimizer results API — exposes the local GA optimizer trees' best configs
 * (`<tree>/best/*.json` + `<tree>/results/*.jsonl`) to the frontend so the
 * chart can one-click load a coin's winning parameters.
 *
 * A "best config" the optimizer stores contains only the tunable params; the
 * full runnable config = `base_params.json` (verified common statics) merged
 * with those tunables. This route does that merge server-side and returns a
 * complete params object plus the properties/timeframe/range the optimizer
 * used, so the chart reproduces the leaderboard number exactly.
 *
 * Two audit findings shape the code below:
 *   `X-04` — routing is a registry each tree owns (`tree.json`), resolved from
 *     `OPTIMIZER_ROOT`/the module path rather than `process.cwd()`. An unknown
 *     or absent tree answers 404 naming what does exist; a tree that simply has
 *     no generated results yet says so explicitly. Neither is an empty 200.
 *   `BE-24` — no handler here scans a result stream synchronously or writes to
 *     disk. Counts come from a background refresher, ranked history from a
 *     bounded asynchronous scan.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { assertSymbol } from "../../data/binanceRest";
import {
  listTrees, optimizerRoot, resolveTree, treeResults,
  type OptimizerTree,
} from "../../optimizer/registry";
import { countsFor, scanRanked, type RankedRecord } from "../../optimizer/resultsIndex";

/** A dashboard snapshot older than this is reported as stale (`OPT-29`). */
const SNAPSHOT_STALE_MS = Number(process.env.OPTIMIZER_SNAPSHOT_STALE_MS ?? 24 * 60 * 60 * 1000);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface OptConfig {
  range?: { start?: string; end?: string; split?: string };
  initialCapital?: number;
  commissionPct?: number;
  slippageTicks?: number;
  qtyCash?: number;
  timeframe?: string;
}

interface BestRec extends RankedRecord {
  ts?: string;
  symbol?: string;
  params?: Record<string, unknown>;
}

/**
 * The tree's own cost model. There is deliberately no invented fallback: a
 * tree without a readable `config.json` is a broken tree, and reporting made-up
 * figures is how `OPT-11`'s wrong cost model reached the chart.
 */
function loadConfig(tree: OptimizerTree): OptConfig {
  return readJson<OptConfig>(path.join(tree.dir, "config.json")) ?? {};
}

function baseParams(tree: OptimizerTree): Record<string, unknown> {
  return readJson<Record<string, unknown>>(path.join(tree.dir, "base_params.json")) ?? {};
}

/**
 * The `min_trades` floor a tree's objective enforces, from its own params.json.
 *
 * `OPT-09`: GA winners cluster exactly on that floor. `ANALYSIS_1H_1Y.md`
 * records SYNUSDT, KAITOUSDT and EIGENUSDT all winning with **31** trades
 * against a floor of 30, reporting +2799 %, +494 % and +342 %. Maximising over
 * ~1e19 candidates with a hard floor produces winners at the floor by
 * construction: the fewer trades a result rests on, the more of its return can
 * be luck, and the search is free to find the luckiest such result.
 */
function minTradesFloor(tree: OptimizerTree): number | null {
  const space = readJson<{ objective?: { min_trades?: number } }>(
    path.join(tree.dir, "params.json")
  );
  const floor = space?.objective?.min_trades;
  return typeof floor === "number" && Number.isFinite(floor) ? floor : null;
}

/** Within two trades of the floor is "at the boundary" for reporting. */
const FLOOR_MARGIN = 2;

function atTradeFloor(trades: number | null | undefined, floor: number | null): boolean {
  if (floor === null || typeof trades !== "number") return false;
  return trades <= floor + FLOOR_MARGIN;
}

function treeSummary(tree: OptimizerTree) {
  return {
    id: tree.id,
    label: tree.label,
    strategy: tree.strategy,
    timeframe: tree.timeframe,
    system: tree.system,
    kind: tree.kind,
    status: tree.status,
    ...(tree.note ? { note: tree.note } : {}),
    cost: tree.cost,
  };
}

function notFound(reply: FastifyReply, reason: string, candidates: string[]) {
  return reply.code(404).send({
    error: reason,
    root: optimizerRoot(),
    availableTrees: candidates,
  });
}

/** Full runnable params = base statics + this result's tunables. */
function fullParams(rec: BestRec, tree: OptimizerTree): Record<string, unknown> {
  return { ...baseParams(tree), ...(rec.params ?? {}) };
}

/**
 * Suggested Strategy-Tester properties to reproduce the optimizer's number.
 *
 * `qtyCash` is read from the result, then the tree's config, and is `null` when
 * neither states it — the previous hardcoded 930 was a superseded order size
 * that silently mis-sized every reproduction (`OPT-11`).
 */
function properties(cfg: OptConfig, tree: OptimizerTree, params: Record<string, unknown>) {
  const nowIso = new Date().toISOString().slice(0, 10);
  const pct = Number(params.qty_pct_equity ?? 0);
  const cashRaw = params.qty_cash ?? cfg.qtyCash;
  const qtyCash = Number.isFinite(Number(cashRaw)) ? Number(cashRaw) : null;
  const end = cfg.range?.end;
  return {
    initialCapital: cfg.initialCapital ?? null,
    commissionPct: cfg.commissionPct ?? null,
    slippageTicks: cfg.slippageTicks ?? null,
    qtyCash,
    qtyType: pct > 0 ? "percent_of_equity" : "cash",
    qtyValue: pct > 0 ? pct : qtyCash,
    timeframe: cfg.timeframe ?? tree.timeframe,
    rangeStart: cfg.range?.start?.slice(0, 10) ?? null,
    rangeEnd: end ? (end === "now" ? nowIso : end.slice(0, 10)) : null,
  };
}

export async function optimizerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every tree the application can reach, with the cost model and the
   * historical/not-comparable status the UI must show beside its numbers.
   */
  app.get("/api/optimizer/trees", async () => ({
    root: optimizerRoot(),
    trees: listTrees().map(treeSummary),
  }));

  // Leaderboard for one tree.
  app.get("/api/optimizer/leaderboard", async (req, reply) => {
    const q = req.query as { tree?: string; strategy?: string; timeframe?: string; system?: string };
    const resolved = resolveTree(q);
    if (!resolved.tree) return notFound(reply, resolved.reason, resolved.candidates);
    const tree = resolved.tree;

    // A snapshot exported from the machine that runs the optimizers. It is
    // served as-is but never silently: its age travels with it, because these
    // files were found two weeks stale in front of a live UI (`OPT-29`).
    const dashboardDir = process.env.OPTIMIZER_DASHBOARD_DIR;
    if (dashboardDir) {
      const snapshot = readJson<Record<string, unknown> & { generatedAt?: string }>(
        path.join(dashboardDir, `${tree.id}.json`)
      );
      if (snapshot) {
        const generatedAt = snapshot.generatedAt ?? null;
        const ageMs = generatedAt ? Date.now() - Date.parse(generatedAt) : null;
        return {
          ...snapshot,
          tree: treeSummary(tree),
          source: "snapshot",
          generatedAt,
          ageMinutes: ageMs === null ? null : Math.round(ageMs / 60_000),
          stale: ageMs === null ? true : ageMs > SNAPSHOT_STALE_MS,
        };
      }
    }

    const cfg = loadConfig(tree);
    const { hasResults, bestDir } = treeResults(tree);
    const snapshot = countsFor(tree);
    const floor = minTradesFloor(tree);
    const rows: unknown[] = [];
    if (hasResults) {
      for (const file of fs.readdirSync(bestDir)) {
        if (!file.endsWith(".json")) continue;
        const rec = readJson<BestRec>(path.join(bestDir, file));
        if (!rec) continue;
        const symbol = file.slice(0, -5);
        rows.push({
          symbol, score: rec.score, metrics: rec.metrics ?? {},
          tests: snapshot.counts[symbol] ?? 0,
          // OPT-09: a winner sitting on the min_trades floor rests on the
          // fewest trades the objective permits, which is where a maximum over
          // a huge search lands by construction.
          atTradeFloor: atTradeFloor(rec.metrics?.trades, floor),
        });
      }
      rows.sort((a, b) =>
        (((b as { score: number }).score ?? -1e18) - ((a as { score: number }).score ?? -1e18)));
    }
    return {
      tree: treeSummary(tree),
      system: tree.system,
      timeframe: cfg.timeframe ?? tree.timeframe,
      range: cfg.range ?? null,
      source: "tree",
      // `pending` means the background count has not finished, not zero.
      testsState: snapshot.state,
      totalBacktests: snapshot.total,
      generatedAt: snapshot.computedAt,
      stale: false,
      // Distinguishes "this tree has produced nothing yet" from "no such tree",
      // which the previous empty-200 could not (`X-04`).
      resultsAvailable: hasResults,
      minTrades: floor,
      leaderboard: rows,
    };
  });

  // Best (or rank-N) config for one coin, ready to load onto the chart.
  app.get("/api/optimizer/best/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    // `.toUpperCase()` alone left `.` and `/` intact, and this value is
    // concatenated into a filesystem path below. `assertSymbol` is the
    // existing choke point and rejects anything that is not [A-Z0-9]{2,24}.
    let sym: string;
    try {
      sym = assertSymbol(symbol);
    } catch {
      return reply.code(400).send({ error: "invalid symbol" });
    }
    const q = req.query as {
      rank?: string; tree?: string; strategy?: string; timeframe?: string; system?: string;
    };
    const resolved = resolveTree(q);
    if (!resolved.tree) return notFound(reply, resolved.reason, resolved.candidates);
    const tree = resolved.tree;
    const cfg = loadConfig(tree);
    const { bestDir, resultsDir } = treeResults(tree);

    let rec: BestRec | null;
    let truncated = false;
    if (q.rank) {
      const rank = Number(q.rank);
      if (!Number.isInteger(rank) || rank < 1) {
        return reply.code(400).send({ error: "rank must be a positive integer" });
      }
      const scan = await scanRanked(path.join(resultsDir, `${sym}.jsonl`), { topK: Math.max(rank, 1000) });
      truncated = scan.truncated;
      if (rank > scan.records.length) {
        return reply.code(404).send({
          error: `${sym} has ${scan.records.length} ranked results in ${tree.id}` +
            (scan.truncated ? " within the scan budget" : ""),
          tree: tree.id,
          truncated: scan.truncated,
        });
      }
      rec = scan.records[rank - 1] as BestRec;
    } else {
      rec = readJson<BestRec>(path.join(bestDir, `${sym}.json`));
      if (!rec) {
        return reply.code(404).send({
          error: `no optimizer result yet for ${sym} in ${tree.id}`,
          tree: tree.id,
        });
      }
    }

    const params = fullParams(rec, tree);
    return {
      symbol: sym,
      rank: q.rank ? Number(q.rank) : 1,
      score: rec.score,
      foundAt: rec.ts ?? null,
      metrics: rec.metrics ?? {},
      params,
      tunedParams: rec.params ?? {},
      properties: properties(cfg, tree, params),
      timeframe: cfg.timeframe ?? tree.timeframe,
      tree: treeSummary(tree),
      optimizerSystem: tree.system,
      strategyKey: tree.strategy,
      // True when the byte budget stopped the ranked scan short; the rank is
      // then the best within what was read, not provably the global rank.
      rankTruncated: truncated,
    };
  });
}
