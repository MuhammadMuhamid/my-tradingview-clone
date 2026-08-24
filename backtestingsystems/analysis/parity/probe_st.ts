import { closePool } from "../src/db/pool";
import * as candleRepo from "../src/repositories/candles";
import { toBars } from "../src/engine/mtf";
import * as ta from "../src/engine/ta";

async function main() {
  const from = Date.parse("2026-04-01T00:00:00Z");
  const to = Date.parse("2026-06-23T00:00:00Z");
  const candles = await candleRepo.getCandles("DEXEUSDT", "1h", { from, to });
  const b = toBars(candles);
  // SuperTrend hl2, ATR 10 rma, mult 1.1 — same as engine's superTrend()
  const src = ta.hl2(b.high, b.low);
  const atr = ta.atr(b.high, b.low, b.close, 10);
  const n = b.length;
  const up = new Array(n).fill(NaN), dn = new Array(n).fill(NaN), tr = new Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const bu = src[i]! - 1.1 * atr[i]!;
    const bd = src[i]! + 1.1 * atr[i]!;
    const pu = i > 0 ? up[i-1] : NaN, pd = i > 0 ? dn[i-1] : NaN;
    up[i] = (i > 0 && b.close[i-1]! > pu) ? Math.max(bu, pu) : bu;
    dn[i] = (i > 0 && b.close[i-1]! < pd) ? Math.min(bd, pd) : bd;
    tr[i] = i === 0 ? 1 : (tr[i-1] === -1 && b.close[i]! > pd) ? 1 : (tr[i-1] === 1 && b.close[i]! < pu) ? -1 : tr[i-1];
  }
  for (let i = 0; i < n; i++) {
    const t = new Date(b.time[i]!).toISOString();
    if (t >= "2026-06-22T04" && t <= "2026-06-22T12") {
      console.log(t, "trend", tr[i], "close", b.close[i]);
    }
  }
  await closePool();
}
main();
