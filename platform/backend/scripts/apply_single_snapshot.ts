import fs from "node:fs";
import { pool, closePool } from "../src/db/pool";

async function main(): Promise<void> {
  const [symbolArg, snapshotFile] = process.argv.slice(2);
  const symbol = symbolArg?.toUpperCase();
  if (!symbol || !snapshotFile) throw new Error("usage: apply_single_snapshot SYMBOL SNAPSHOT.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as {
    symbol: string; params: Record<string, unknown>;
  };
  if (snapshot.symbol.toUpperCase() !== symbol) throw new Error("snapshot symbol mismatch");
  const result = await pool.query(
    `UPDATE deployments
     SET params=$2, status='active', buy_quote_qty=320.01, updated_at=now()
     WHERE symbol=$1 AND status IN ('active','paused')
     RETURNING id,status,buy_quote_qty,runtime_state`,
    [symbol, snapshot.params]
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
