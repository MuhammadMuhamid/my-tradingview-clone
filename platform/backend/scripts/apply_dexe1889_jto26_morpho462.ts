import fs from "node:fs";
import { pool, closePool } from "../src/db/pool";

const params = (file: string): Record<string, unknown> =>
  (JSON.parse(fs.readFileSync(file, "utf8")) as { params: Record<string, unknown> }).params;

async function main(): Promise<void> {
  const updates = [
    ["DEXEUSDT", params("/tmp/dexe-rank1889.json")],
    ["JTOUSDT", params("/tmp/jto-rank26.json")],
    ["MORPHOUSDT", params("/tmp/morpho-rank462.json")],
  ] as const;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [symbol, strategyParams] of updates) {
      const result = await client.query(
        `UPDATE deployments
         SET params=$2, status='active', buy_quote_qty=320.01, updated_at=now()
         WHERE symbol=$1 AND status IN ('active','paused')
         RETURNING id`,
        [symbol, strategyParams]
      );
      if (result.rowCount !== 1) {
        throw new Error(`${symbol}: expected exactly one active/paused deployment, got ${result.rowCount}`);
      }
    }
    await client.query("COMMIT");
    console.log("DEXE 1889, JTO 26, MORPHO 462 applied; runtime states preserved");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
