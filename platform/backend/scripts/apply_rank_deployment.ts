/**
 * Point one deployment at a ranked optimizer result.
 *
 *   npx tsx scripts/apply_rank_deployment.ts SYMBOL RANK|line:N BUY_USDT [5m|15m] [tree] [--apply]
 *
 * OPT-26: preview by default. The order size is already an explicit argument
 * here, so `--buy` is not needed — but writing still is not the default.
 * BE-24: the ranked lookup streams the result file in bounded chunks instead of
 * reading a multi-gigabyte JSONL into memory.
 */
import fs from "node:fs";
import path from "node:path";
import { pool, closePool } from "../src/db/pool";
import { scanRanked } from "../src/optimizer/resultsIndex";
import { requireApplyFlag } from "./lib/applyGuard";

type ResultRecord = {
  score: number | null;
  genome?: number[];
  params: Record<string, unknown>;
  metrics?: Record<string, number | null>;
};

async function rankedResult(dir: string, symbol: string, rank: number): Promise<ResultRecord> {
  const file = path.join(dir, "results", `${symbol}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`no optimizer results for ${symbol}`);
  const scan = await scanRanked(file, { topK: Math.max(rank, 1000) });
  if (rank < 1 || rank > scan.records.length) {
    throw new Error(
      `${symbol} has ${scan.records.length} ranked results` +
      `${scan.truncated ? " within the scan budget" : ""}; requested ${rank}`
    );
  }
  return scan.records[rank - 1] as ResultRecord;
}

function resultAtLine(dir: string, symbol: string, lineNumber: number): ResultRecord {
  const file = path.join(dir, "results", `${symbol}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`no optimizer results for ${symbol}`);
  const line = fs.readFileSync(file, "utf8").split("\n")[lineNumber - 1];
  if (!line?.trim()) throw new Error(`${symbol}: no result at history line ${lineNumber}`);
  const row = JSON.parse(line) as ResultRecord;
  if (row.score === null || !row.params) throw new Error(`${symbol}: invalid result at history line ${lineNumber}`);
  return row;
}

async function main(): Promise<void> {
  const intent = requireApplyFlag(process.argv.slice(2), "apply_rank_deployment.ts");
  // X-04 / OPT-11: "optimizer" is a directory that does not exist. There is no
  // safe default tree — a wrong tree resolves a config from the wrong search
  // space — so the tree id is required.
  const [symbolArg, rankArg, amountArg, timeframeArg = "15m", optimizerArg] = intent.rest;
  const symbol = symbolArg?.toUpperCase();
  const lineSelection = rankArg?.startsWith("line:") ? Number(rankArg.slice(5)) : null;
  const rank = lineSelection === null ? Number(rankArg) : null;
  const amount = Number(amountArg);
  if (!symbol || (lineSelection === null
      ? (!Number.isInteger(rank) || (rank ?? 0) < 1)
      : (!Number.isInteger(lineSelection) || lineSelection < 1))
      || !Number.isFinite(amount) || amount <= 0 || !optimizerArg) {
    throw new Error(
      "usage: apply_rank_deployment SYMBOL RANK|line:N BUY_USDT [5m|15m] TREE_ID [--apply]"
    );
  }
  if (timeframeArg !== "5m" && timeframeArg !== "15m") throw new Error("timeframe must be 5m or 15m");

  // The trees moved out of this repository into the backtesting repository, so
  // look there first and fall back to the old in-backend location. Override with
  // BACKTEST_TREES when the two checkouts are not siblings.
  const backend = path.resolve(import.meta.dirname, "..");
  const treeRoots = [
    process.env.BACKTEST_TREES,
    path.resolve(backend, "..", "..", "backtestingsystems", "trees"),
    backend,
  ].filter((d): d is string => Boolean(d) && fs.existsSync(d as string));

  const root = treeRoots.find((d) => fs.existsSync(path.join(d, optimizerArg, "tree.json")));
  if (!root) {
    const available = treeRoots.flatMap((d) =>
      fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(d, e.name, "tree.json")))
        .map((e) => e.name)).sort();
    throw new Error(
      `no optimizer tree '${optimizerArg}'. Searched: ${treeRoots.join(", ")}. ` +
      `Registered trees: ${available.join(", ") || "(none found)"}`
    );
  }
  const optimizerDir = path.join(root, optimizerArg);
  const selected = lineSelection === null
    ? await rankedResult(optimizerDir, symbol, rank!)
    : resultAtLine(optimizerDir, symbol, lineSelection);
  console.log(intent.banner());
  if (!intent.apply) {
    console.log(JSON.stringify({
      wouldApply: { symbol, rank, historyLine: lineSelection, timeframe: timeframeArg,
        buyQuoteQty: amount, tree: optimizerArg, status: "paused" },
      score: selected.score, metrics: selected.metrics,
      params: Object.keys(selected.params).length,
    }, null, 2));
    await closePool();
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const known = await client.query("SELECT 1 FROM symbols WHERE symbol=$1", [symbol]);
    if (!known.rowCount) throw new Error(`unknown local symbol: ${symbol}`);

    const existing = await client.query<{ id: string }>(
      "SELECT id FROM deployments WHERE symbol=$1 AND status IN ('active','paused') FOR UPDATE",
      [symbol]
    );
    if ((existing.rowCount ?? 0) > 1) throw new Error(`${symbol}: duplicate deployments found`);

    let id: string;
    let operation: "created" | "updated";
    if (existing.rows[0]) {
      id = existing.rows[0].id;
      await client.query(
        `UPDATE deployments SET timeframe=$2, params=$3, buy_quote_qty=$4,
           status='paused', updated_at=now() WHERE id=$1`,
        [id, timeframeArg, selected.params, amount]
      );
      operation = "updated";
    } else {
      const template = await client.query<{
        strategy_id: number; delivery: string; webhook_url: string | null;
        secret: string | null; bot_uuid: string | null;
      }>(`SELECT strategy_id,delivery,webhook_url,secret,bot_uuid
          FROM deployments WHERE status='active' AND delivery='custom'
          ORDER BY updated_at DESC LIMIT 1`);
      const t = template.rows[0];
      if (!t) throw new Error("no active custom-webhook deployment template found");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO deployments
          (strategy_id,config_id,symbol,timeframe,params,status,delivery,webhook_url,
           secret,bot_uuid,buy_quote_qty,runtime_state,last_bar_time)
         VALUES ($1,NULL,$2,$3,$4,'paused',$5,$6,$7,$8,$9,
                 '{"position":"flat"}'::jsonb,NULL) RETURNING id`,
        [t.strategy_id, symbol, timeframeArg, selected.params, t.delivery,
         t.webhook_url, t.secret, t.bot_uuid, amount]
      );
      id = inserted.rows[0]!.id;
      operation = "created";
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ id, operation, symbol, rank, historyLine: lineSelection,
      timeframe: timeframeArg,
      buyQuoteQty: amount, score: selected.score, metrics: selected.metrics }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
