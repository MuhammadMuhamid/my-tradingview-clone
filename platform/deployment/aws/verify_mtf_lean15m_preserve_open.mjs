import pg from "pg";

const preserve = "币安人生USDT";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(`
  SELECT d.id, d.symbol, d.status, d.timeframe, d.buy_quote_qty,
         d.runtime_state->>'position' AS position,
         COALESCE((d.params->>'rrUsePartialTp')::boolean, false) AS partial,
         s.key AS strategy_key, l.name AS layout_name,
         l.timeframe AS layout_timeframe, l.strategy_key AS layout_strategy
  FROM deployments d
  JOIN strategies s ON s.id=d.strategy_id
  LEFT JOIN chart_layouts l ON l.symbol=d.symbol
  ORDER BY d.symbol
`);
const fresh = rows.filter((r) => r.symbol !== preserve);
const kept = rows.filter((r) => r.symbol === preserve);
const layouts = await pool.query("SELECT count(*)::int AS n FROM chart_layouts");

const failures = [];
if (rows.length !== 15) failures.push(`expected 15 deployments, found ${rows.length}`);
if (layouts.rows[0].n !== 15) failures.push(`expected 15 layouts, found ${layouts.rows[0].n}`);
if (fresh.length !== 14) failures.push(`expected 14 replacement deployments, found ${fresh.length}`);
if (fresh.filter((r) => r.partial).length !== 9) failures.push("expected 9 partial replacements");
if (fresh.filter((r) => !r.partial).length !== 5) failures.push("expected 5 full-exit replacements");
for (const row of fresh) {
  if (row.status !== "active" || row.timeframe !== "15m" || row.strategy_key !== "mtf_lean")
    failures.push(`bad deployment metadata: ${row.symbol}`);
  if (Number(row.buy_quote_qty) !== 70.01) failures.push(`bad buy amount: ${row.symbol}`);
  if (row.layout_timeframe !== "15m" || row.layout_strategy !== "mtf_lean")
    failures.push(`bad layout metadata: ${row.symbol}`);
}
if (kept.length !== 1) failures.push(`expected one preserved deployment, found ${kept.length}`);
else if (kept[0].position !== "long") failures.push("preserved position is no longer long");

console.log(JSON.stringify({
  deployments: rows.length,
  layouts: layouts.rows[0].n,
  replacements: fresh.length,
  partial: fresh.filter((r) => r.partial).length,
  full: fresh.filter((r) => !r.partial).length,
  buyQuoteQty: [...new Set(fresh.map((r) => Number(r.buy_quote_qty)))],
  preserved: kept[0] ?? null,
  failures,
}, null, 2));
await pool.end();
if (failures.length) process.exit(1);
