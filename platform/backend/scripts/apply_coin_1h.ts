/**
 * Build one coin from the 1h optimizer, locally: resolve its config by the
 * frozen ORIG# (drift-proof), upsert a 1h layout, and create a live alert at
 * 280.01 USDT with the provided secret + webhook. The running backend encrypts
 * the secret; it is never printed here. All local — AWS is done in the final
 * deploy.
 *
 *   CREDS_FILE=/path/alert_creds.json npx tsx scripts/apply_coin_1h.ts DEXEUSDT 1
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { query } from "../src/db/pool";

const API = "http://127.0.0.1:4000";
const OPT = "optimizer1y1h"; // 1h, one-year range (2025-07-20 → now)
const TF = "1h";

function resolve(symbol: string, orig: number): {
  params: Record<string, unknown>; metrics: Record<string, number | null>;
  properties: Record<string, unknown>; error?: string;
} {
  const script = path.join(process.cwd(), "scripts", "resolve_config.py");
  return JSON.parse(execFileSync("python3", [script, symbol, String(orig), OPT], { encoding: "utf8" }));
}

async function main(): Promise<void> {
  const [symbolArg, rankArg] = process.argv.slice(2);
  if (!symbolArg || !rankArg) throw new Error("usage: apply_coin_1h.ts SYMBOL ORIG#");
  const symbol = symbolArg.toUpperCase();
  const orig = Number(rankArg);

  const credsFile = process.env.CREDS_FILE;
  if (!credsFile) throw new Error("CREDS_FILE env not set");
  const creds = JSON.parse(fs.readFileSync(credsFile, "utf8")) as {
    secret: string; webhookUrl: string; buyQuoteQty: number;
  };

  const r = resolve(symbol, orig);
  if (r.error) throw new Error(`resolve: ${r.error}`);
  const { params, metrics: m, properties } = r;
  console.log(`${symbol} 1h ORIG#${orig}: net ${m.net_pct}% dd ${m.dd_pct}% wr ${m.win_rate}% trades ${m.trades} pf ${m.profit_factor} (${Object.keys(params).length} params)`);

  // 1h layout
  const layout = await fetch(`${API}/api/layouts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `${symbol} 1h`, symbol, timeframe: TF, bars: 10000, strategyKey: "ma_rr_v9", params, properties }),
  }).then((x) => x.json()) as { id?: string; error?: string };
  if (!layout.id) throw new Error(`layout: ${layout.error}`);
  console.log(`  layout upserted: ${layout.id.slice(0, 8)} (1h)`);

  // live alert @ 280.01 with provided creds (backend encrypts the secret)
  const dep = await fetch(`${API}/api/deployments`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyKey: "ma_rr_v9", symbol, timeframe: TF, params,
      delivery: "custom", webhookUrl: creds.webhookUrl, secret: creds.secret,
      buyQuoteQty: creds.buyQuoteQty,
    }),
  }).then((x) => x.json()) as { id?: string; error?: string };
  if (!dep.id) throw new Error(`alert: ${dep.error}`);
  await query("UPDATE deployments SET status='active' WHERE id=$1", [dep.id]);
  console.log(`  alert created: ${dep.id.slice(0, 8)} (1h, buy ${creds.buyQuoteQty}, active, secret configured)`);
  console.log("  done.");
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
