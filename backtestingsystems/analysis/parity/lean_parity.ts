/**
 * MTF Confluence Lean — TradingView vs local TS engine parity check.
 * Consumes parity/tv_lean_raw.json (captured from the chart's _reportData) and
 * replays the SAME inputs, range and broker properties through the engine.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as candleRepo from "../src/repositories/candles";
import * as symbolRepo from "../src/repositories/symbols";
import { FeedStore, toBars, Bars } from "../src/engine/mtf";
import { mtfLeanModule } from "../src/engine/strategies/mtf_lean";
import type { Interval } from "../src/types/market";

// decodeURIComponent: the repo path contains a space, which import.meta.url escapes as %20.
const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const raw = JSON.parse(fs.readFileSync(path.join(HERE, "tv_lean_raw.json"), "utf8"));
const V: Record<string, any> = {};
for (const x of raw.inputs) V[x.id] = x.value;

// TradingView input id -> engine param name (MTF Confluence Lean, verified 2026-08-11)
const IDMAP: Record<string, string> = {
  in_0:"useBarConfirm", in_1:"ordersOnConfirmedBar", in_2:"cooldownBarsAfterExit",
  in_3:"htfClosed", in_4:"useHeikin", in_5:"useChoppyFilter", in_6:"maxConsecLoss", in_7:"choppyPauseBars",
  in_16:"atrLenRisk",
  in_17:"useG1", in_18:"g1_tf", in_19:"g1_atrLen", in_20:"g1_mult", in_21:"g1_chgAtr",
  in_22:"useG2", in_23:"g2_tf", in_24:"g2_len", in_25:"g2_thr", in_26:"g2_max",
  in_27:"useG3", in_28:"g3_tf", in_29:"g3_len", in_30:"g3_coef", in_31:"g3_vcoef", in_32:"g3_sig", in_33:"g3_smooth", in_34:"g3_level",
  in_35:"useG4", in_36:"g4_tf", in_37:"g4_lb", in_38:"g4_volLen", in_39:"g4_boxW", in_40:"g4_atrMult",
  in_41:"useVolumeFilter", in_42:"volTf", in_43:"volMaLen", in_44:"volMultMin",
  in_45:"useHhStructure", in_46:"hhTf", in_47:"hhPivotLen",
  in_48:"useS1", in_49:"s1_tf", in_50:"s1_len", in_51:"s1_maxAge",
  in_52:"useS4", in_53:"s4_tf", in_54:"s4_atrLen", in_55:"s4_mult", in_56:"s4_chgAtr",
  in_57:"useS5", in_58:"s5_tf", in_59:"s5_prd", in_60:"s5_factor", in_61:"s5_pd",
  in_62:"useS6", in_63:"s6_tf", in_64:"s6_len", in_65:"s6_margin", in_66:"s6_vis", in_67:"s6_prox",
  in_68:"useS7", in_69:"s7_tf", in_70:"s7_len",
  in_71:"useTrigger", in_72:"trig_tf", in_73:"trigMode", in_74:"bbReclaimLb", in_75:"bb_len",
  in_76:"bb_maTyp", in_77:"bb_mult", in_78:"trig_stLen", in_79:"trig_stMult", in_80:"reqST5",
  in_81:"long_en", in_82:"useBodyFilter", in_83:"entryBodyAtrMult", in_84:"useOneTradePerSignal",
  in_85:"rrSwingLb", in_86:"rrBufAtr", in_87:"rrRatio", in_88:"minSlDistAtr",
  in_89:"rrUsePartialTp", in_90:"rrTp1Pct", in_91:"rrTp1Size", in_92:"rrTp2Pct", in_93:"rrTp2Size",
  in_94:"rrUseTrailSl", in_95:"rrTrailPct", in_96:"rrTrailActPct",
  in_97:"rrUseBE", in_98:"rrBeAfterR", in_99:"rrBeOffR",
  in_101:"exitOnG1Flip", in_102:"exitOnS4Flip", in_103:"maxBarsTrade",
  in_104:"useHlBreakExit", in_105:"hlBreakTf", in_106:"hlBreakPivLen",
};
const params: Record<string, unknown> = {};
for (const [id, name] of Object.entries(IDMAP)) if (id in V) params[name] = V[id];
params.qty_cash = Number(V.in_128);
params.qty_pct_equity = V.in_127 === "percent_of_equity" ? Number(V.in_128) : 0;
params.fill_bar_close = Boolean(V.in_137);

const symbol = String(raw.symbol).split(":").pop()!;
const chartTf = `${raw.resolution}m` as Interval;
const startMs = raw.settings.dateRange.backtest.from;
// The local candle DB lags live TradingView. Clip the window to the last bar we
// actually hold, otherwise the engine is scored on bars it cannot see.
const DB_END = Date.parse(process.env.PARITY_END ?? "2026-07-30T00:55:00Z");
const endMs   = Math.min(raw.settings.dateRange.backtest.to, DB_END);
const initialCapital = Number(V.in_129);
const commissionPct  = Number(V.in_132);
const slippageTicks  = Number(V.in_133);

const W: Record<string, number> = {"1m":3*864e5,"5m":10*864e5,"15m":40*864e5,"1h":90*864e5};
const iso = (ms:number)=>new Date(ms).toISOString().replace(".000","");

(async () => {
  const p = mtfLeanModule.resolveParams(params as any);
  const feeds = new FeedStore();
  for (const n of mtfLeanModule.requiredFeeds(p, chartTf)) {
    // PARITY_NOWARMUP=1 feeds the engine EXACTLY the bars TradingView had loaded
    // (no extra history). Path-dependent components (the S6 zigzag level store,
    // the S1 swept-pivot arrays) build different state from a different start
    // point, so matching the warmup is required to isolate real logic drift.
    const warm = process.env.PARITY_NOWARMUP === "1" ? 0 : (W[n.interval] ?? 30*864e5);
    const c = await candleRepo.getCandles(symbol, n.interval, { from: startMs - warm, to: endMs });
    feeds.set(toBars(c));
  }
  const info = await symbolRepo.getSymbol(symbol);
  const res = mtfLeanModule.runBars(feeds, symbol, chartTf, p, {
    initialCapital, commissionPct, slippageTicks, tickSize: info!.priceTick,
    qtyCash: Number(p.qty_cash), qtyPctEquity: Number(p.qty_pct_equity ?? 0),
    fillOnBarClose: Boolean(p.fill_bar_close),
  }, { startMs, endMs });

  const tv = raw.trades.filter((t:any)=>t.e.tm>=startMs && t.e.tm<=endMs).map((t:any)=>({ t:t.e.tm, px:t.e.p, qty:t.q, xt:t.x?.tm??null, xpx:t.x?.p??null, pnl:t.tp.v, why:t.x?.c??"OPEN" }));
  const en = res.broker.closed.map((t:any)=>({ t:t.entryTime, px:t.entryPrice, qty:t.qty, xt:t.exitTime, xpx:t.exitPrice, pnl:t.pnl, why:t.reason ?? t.exitReason ?? "?" }));

  console.log(`\nsymbol=${symbol} tf=${chartTf}  range ${iso(startMs)} -> ${iso(endMs)}`);
  console.log(`capital=${initialCapital} comm=${commissionPct}% slip=${slippageTicks} qtyCash=${p.qty_cash} fillOnClose=${p.fill_bar_close}`);
  console.log(`\nTV trades: ${tv.length}   engine trades: ${en.length}\n`);
  // Align by ENTRY TIMESTAMP, not by list position: a single extra or missing
  // trade would otherwise shift every later row and report false mismatches.
  const byTime = new Map<number, any>();
  for (const b of en) byTime.set(b.t, b);
  const seen = new Set<number>();
  let matched = 0, tvOnly = 0, engOnly = 0;
  const rows: string[] = [];
  for (const a of tv) {
    const b = byTime.get(a.t);
    if (b) {
      seen.add(a.t);
      const samePx = Math.abs(a.px - b.px) / a.px < 1e-6;
      const sameExit = a.xt === b.xt;
      const pnlDiff = Math.abs(a.pnl - b.pnl) / Math.max(Math.abs(a.pnl), 1);
      const m = samePx && sameExit && pnlDiff < 0.01;
      if (m) matched++;
      rows.push(`${iso(a.t)}  px ${a.px.toFixed(2)}/${b.px.toFixed(2)}  exit ${a.xt?iso(a.xt):"-"} / ${b.xt?iso(b.xt):"-"}  pnl ${a.pnl.toFixed(2)}/${b.pnl.toFixed(2)}  ${m?"MATCH":"DIFF px="+samePx+" exit="+sameExit+" pnlD="+(100*pnlDiff).toFixed(2)+"%"}`);
    } else { tvOnly++; rows.push(`${iso(a.t)}  TV-ONLY   px ${a.px.toFixed(2)} pnl ${a.pnl.toFixed(2)}`); }
  }
  for (const b of en) if (!seen.has(b.t)) { engOnly++; rows.push(`${iso(b.t)}  ENGINE-ONLY  px ${b.px.toFixed(2)} pnl ${(b.pnl??0).toFixed(2)}`); }
  rows.sort();
  for (const r of rows) console.log("  " + r);
  console.log(`\nmatched=${matched}  TV-only=${tvOnly}  engine-only=${engOnly}  (TV ${tv.length}, engine ${en.length})`);
  const tvPnl = tv.reduce((s:number,t:any)=>s+t.pnl,0), enPnl = en.reduce((s:number,t:any)=>s+(t.pnl??0),0);
  console.log(`total pnl  TV=${tvPnl.toFixed(2)}  engine=${enPnl.toFixed(2)}`);
  process.exit(0);
})();
