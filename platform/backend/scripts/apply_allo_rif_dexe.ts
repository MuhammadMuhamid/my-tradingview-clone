import fs from "node:fs";
import { pool, closePool } from "../src/db/pool";

const readParams = (file: string): Record<string, unknown> =>
  (JSON.parse(fs.readFileSync(file, "utf8")) as { params: Record<string, unknown> }).params;

async function main(): Promise<void> {
  const allo = readParams("/tmp/allo-rank1.json");
  const rif = readParams("/tmp/rif-rank2.json");
  const dexe = readParams("/tmp/dexe-rank1878.json");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const template = await client.query<{
      strategy_id: number; delivery: string; webhook_url: string | null;
      secret: string | null; bot_uuid: string | null;
    }>(`SELECT strategy_id,delivery,webhook_url,secret,bot_uuid
       FROM deployments WHERE symbol='DEXEUSDT' AND status='active' LIMIT 1 FOR UPDATE`);
    if (!template.rows[0]) throw new Error("active DEXE deployment not found");
    const duplicate = await client.query(
      `SELECT symbol FROM deployments WHERE symbol IN ('ALLOUSDT','RIFUSDT') AND status='active'`
    );
    if (duplicate.rowCount) throw new Error("active ALLO/RIF deployment already exists");
    await client.query(
      `UPDATE deployments SET params=$1, buy_quote_qty=320.01,
       runtime_state='{"position":"flat"}'::jsonb, last_bar_time=NULL, updated_at=now()
       WHERE symbol='DEXEUSDT' AND status='active'`,
      [dexe]
    );
    const t = template.rows[0];
    for (const [symbol, timeframe, params] of [
      ["ALLOUSDT", "5m", allo], ["RIFUSDT", "15m", rif],
    ] as const) {
      await client.query(
        `INSERT INTO deployments
         (strategy_id,config_id,symbol,timeframe,params,status,delivery,webhook_url,
          secret,bot_uuid,buy_quote_qty,runtime_state,last_bar_time)
         VALUES ($1,NULL,$2,$3,$4,'active',$5,$6,$7,$8,320.01,
                 '{"position":"flat"}'::jsonb,NULL)`,
        [t.strategy_id, symbol, timeframe, params, t.delivery, t.webhook_url, t.secret, t.bot_uuid]
      );
    }
    await client.query("COMMIT");
    console.log("DEXE updated; ALLO and RIF created");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
