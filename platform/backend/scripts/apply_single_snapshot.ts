/**
 * Point one existing deployment at a saved parameter snapshot.
 *
 *   npx tsx scripts/apply_single_snapshot.ts SYMBOL SNAPSHOT.json
 *   npx tsx scripts/apply_single_snapshot.ts SYMBOL SNAPSHOT.json --apply --buy 320.01
 *
 * OPT-26: preview by default, and the order size must be stated. It used to
 * write `status='active'` with `buy_quote_qty=320.01` the moment it was run.
 */
import fs from "node:fs";
import { pool, closePool } from "../src/db/pool";
import { parseApplyIntent } from "./lib/applyGuard";

async function main(): Promise<void> {
  const intent = parseApplyIntent(process.argv.slice(2), {
    script: "apply_single_snapshot.ts", historicalBuy: 320.01,
  });
  const [symbolArg, snapshotFile] = intent.rest;
  const symbol = symbolArg?.toUpperCase();
  if (!symbol || !snapshotFile) {
    throw new Error("usage: apply_single_snapshot SYMBOL SNAPSHOT.json [--apply --buy <usdt>]");
  }
  console.log(intent.banner());
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as {
    symbol: string; params: Record<string, unknown>;
  };
  if (snapshot.symbol.toUpperCase() !== symbol) throw new Error("snapshot symbol mismatch");
  if (!intent.apply) {
    const target = await pool.query(
      `SELECT id,status,buy_quote_qty FROM deployments
       WHERE symbol=$1 AND status IN ('active','paused')`,
      [symbol]
    );
    console.log(`would set ${target.rowCount ?? 0} deployment(s) for ${symbol} to ` +
      `status=active, buy_quote_qty=${intent.buyQuoteQty}, ` +
      `${Object.keys(snapshot.params).length} params:`);
    for (const row of target.rows) console.log(" ", JSON.stringify(row));
    await closePool();
    return;
  }
  const result = await pool.query(
    `UPDATE deployments
     SET params=$2, status='active', buy_quote_qty=$3, updated_at=now()
     WHERE symbol=$1 AND status IN ('active','paused')
     RETURNING id,status,buy_quote_qty,runtime_state`,
    [symbol, snapshot.params, intent.buyQuoteQty]
  );
  if (result.rowCount !== 1) {
    throw new Error(`${symbol}: expected exactly one active/paused deployment, got ${result.rowCount}`);
  }
  console.log(JSON.stringify(result.rows[0]));
  await closePool();
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
