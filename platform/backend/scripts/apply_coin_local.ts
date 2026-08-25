/**
 * Local apply helper for the "new settings" rollout. For one coin + optimizer
 * ORIG# rank it:
 *   1. pulls the full verified param set from the local optimizer API,
 *   2. upserts that coin's layout (name = SYMBOL) with the new params,
 *   3. reconfigures its alert (deployment): existing → update params + reset
 *      runtime state + buy 340.01; missing → create by copying webhook/secret
 *      from a template alert (credential never leaves the DB).
 *
 * All local (localhost:4000 + local DB). Nothing here touches AWS.
 *
 *   npx tsx scripts/apply_coin_local.ts SYNUSDT 453                     # preview
 *   npx tsx scripts/apply_coin_local.ts SYNUSDT 453 --apply --buy 340.01
 *   npx tsx scripts/apply_coin_local.ts SYNUSDT 453 --template KAITOUSDT
 *
 * OPT-26: preview by default, and the order size must be stated. It used to
 * create or reconfigure a LIVE alert at a size hardcoded in this file.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { query } from "../src/db/pool";
import { initialRuntimeState } from "../src/types/deployments";
import { parseApplyIntent } from "./lib/applyGuard";

const API = "http://127.0.0.1:4000";
/** What this script hardcoded. Kept only so the preview can suggest it. */
const HISTORICAL_BUY = 340.01;

/** Resolve full params by the SAME ORIG# the opt-results leaderboard shows
 *  (frozen sqlite index, drift-proof). */
function resolveByOrig(symbol: string, orig: number): {
  params: Record<string, unknown>;
  metrics: Record<string, number | null>;
  properties: Record<string, unknown>;
  error?: string;
} {
  const script = path.join(process.cwd(), "scripts", "resolve_config.py");
  const out = execFileSync("python3", [script, symbol, String(orig)], { encoding: "utf8" });
  return JSON.parse(out);
}

async function main(): Promise<void> {
  const intent = parseApplyIntent(process.argv.slice(2), {
    script: "apply_coin_local.ts", historicalBuy: HISTORICAL_BUY,
  });
  const BUY = intent.buyQuoteQty;
  const tplIdx = process.argv.indexOf("--template");
  const template = (tplIdx > 0 ? process.argv[tplIdx + 1] ?? "KAITOUSDT" : "KAITOUSDT").toUpperCase();
  const [symbolArg, rankArg] = intent.rest.filter((a) => a !== "--force" && a !== "--template" && a !== template);
  if (!symbolArg || !rankArg) {
    throw new Error("usage: apply_coin_local.ts SYMBOL RANK [--template COIN] [--apply --buy <usdt>]");
  }
  const symbol = symbolArg.toUpperCase();
  const rank = Number(rankArg);
  const force = process.argv.includes("--force"); // override a stale local "long" state
  console.log(intent.banner());

  // 1. Verified full params by ORIG# from the frozen optimizer index (drift-proof).
  const best = resolveByOrig(symbol, rank);
  if (best.error) throw new Error(`resolve: ${best.error}`);
  const params = best.params;
  const m = best.metrics;
  console.log(`${symbol} ORIG#${rank}: net ${m.net_pct}% dd ${m.dd_pct}% wr ${m.win_rate}% trades ${m.trades} pf ${m.profit_factor} (${Object.keys(params).length} params)`);

  if (!intent.apply) {
    const existing = await query<{ id: string; status: string; position: string }>(
      "SELECT id, status, runtime_state->>'position' AS position FROM deployments WHERE symbol=$1",
      [symbol]
    );
    console.log(`  would upsert layout ${symbol} and ` +
      (existing.rows.length
        ? `update alert ${existing.rows[0]!.id.slice(0, 8)} (status ${existing.rows[0]!.status}, ` +
          `position ${existing.rows[0]!.position}) with buy ${BUY} and a reset runtime state`
        : `CREATE an ACTIVE alert copying credentials from ${template}, buy ${BUY}`));
    process.exit(0);
  }

  // 2. Upsert layout.
  const layout = await fetch(`${API}/api/layouts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: symbol, symbol, timeframe: "15m", bars: 10000, strategyKey: "ma_rr_v9",
      params,
      properties: {
        initialCapital: best.properties.initialCapital, qtyCash: best.properties.qtyCash,
        qtyType: best.properties.qtyType, qtyValue: best.properties.qtyValue,
        commissionPct: best.properties.commissionPct, slippageTicks: best.properties.slippageTicks,
      },
    }),
  }).then((r) => r.json()) as { id: string };
  console.log(`  layout upserted: ${layout.id.slice(0, 8)}`);

  // 3. Alert (deployment).
  const existing = await query<{ id: string; position: string }>(
    "SELECT id, runtime_state->>'position' AS position FROM deployments WHERE symbol=$1",
    [symbol]
  );
  const freshState = JSON.stringify(initialRuntimeState());
  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    if (row.position === "long" && !force) {
      console.log(`  ⚠️  alert ${symbol} is IN A POSITION — skipping alert change (safe). Re-run with --force if flat.`);
      return;
    }
    if (row.position === "long" && force) {
      console.log(`  (--force) local state was 'long' (stale) — resetting to flat and applying.`);
    }
    await query(
      "UPDATE deployments SET params=$2, runtime_state=$3, buy_quote_qty=$4, updated_at=now() WHERE id=$1",
      [row.id, JSON.stringify(params), freshState, BUY]
    );
    console.log(`  alert updated in place: ${row.id.slice(0, 8)} (params swapped, state reset, buy ${BUY})`);
  } else {
    const tpl = await query<{ strategy_id: number }>(
      "SELECT strategy_id FROM deployments WHERE symbol=$1 LIMIT 1",
      [template]
    );
    if (tpl.rows.length === 0) throw new Error(`template alert ${template} not found to copy credentials from`);
    // Copy delivery/webhook/secret/bot_uuid (encrypted) from the template; set this coin's params.
    const created = await query<{ id: string }>(
      `INSERT INTO deployments
         (strategy_id, symbol, timeframe, params, delivery, webhook_url, secret, bot_uuid,
          buy_quote_qty, runtime_state, status)
       SELECT strategy_id, $1, '15m', $2::jsonb, delivery, webhook_url, secret, bot_uuid,
          $3, $4::jsonb, 'active'
       FROM deployments WHERE symbol=$5 LIMIT 1
       RETURNING id`,
      [symbol, JSON.stringify(params), BUY, freshState, template]
    );
    console.log(`  alert CREATED: ${created.rows[0]!.id.slice(0, 8)} (credentials copied from ${template}, buy ${BUY}, active)`);
  }
  console.log("  done.");
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
