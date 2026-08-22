"use client";
import { useEffect, useRef, useState } from "react";
import { EquityCurve } from "@/components/EquityCurve";
import { TradeList } from "@/components/TradeList";
import { StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import type { Backtest, Interval, OpenTrade, Strategy, StrategyParams, Trade } from "@/lib/types";
import type { StrategyProperties } from "./StrategySettingsModal";
import { fmtNum, fmtPct, fmtPrice, signClass } from "@/lib/format";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

/**
 * Default start of the backtest window. Both date fields are free-text inputs —
 * this is only the value they start on, and typing over it is always respected.
 * Changed from 2025-11-01 to 2025-07-01 on 2026-07-30.
 */
const DEFAULT_START = "2025-07-01";

function Stat({ label, value, valueClass = "text-ink", sub }: {
  label: string; value: string; valueClass?: string; sub?: string;
}) {
  return (
    <div>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular ${valueClass}`}>{value}</div>
      {sub && <div className="text-xs text-ink-faint tabular">{sub}</div>}
    </div>
  );
}

/**
 * TradingView-style Strategy Tester bottom panel: strategy picker + settings
 * gear + date range + Run; Overview (key stats + cumulative equity) and
 * Trades tabs. Completed runs push their trades up so the main chart can draw
 * entry/exit markers.
 */
export function StrategyTester({
  symbol, timeframe, strategies, strategy, onStrategyChange, onOpenSettings,
  properties, params, requestedRange, onTrades, onOpenTrade,
}: {
  symbol: string;
  timeframe: Interval;
  strategies: Strategy[];
  strategy: Strategy | null;
  onStrategyChange: (key: string) => void;
  onOpenSettings: () => void;
  properties: StrategyProperties;
  params: StrategyParams;
  requestedRange?: { start: string; end: string; nonce: number; run?: boolean } | null;
  onTrades: (trades: Trade[]) => void;
  /** Running position from the finished run, so the chart can draw SL/TP lines. */
  onOpenTrade?: (openTrade: OpenTrade | null) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<"overview" | "trades">("overview");
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [run, setRun] = useState<Backtest | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRanNonce = useRef<number>(0);

  useEffect(() => {
    if (!requestedRange) return;
    setStart(requestedRange.start);
    setEnd(requestedRange.end);
  }, [requestedRange]);

  // Poll while a run is queued/running.
  useEffect(() => {
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    pollRef.current = setInterval(async () => {
      try {
        const fresh = await api.getBacktest(run.id);
        setRun(fresh);
        if (fresh.status === "done") {
          const t = await api.getBacktestTrades(fresh.id);
          setTrades(t);
          onTrades(t);
          onOpenTrade?.(fresh.metrics?.openTrade ?? null);
        }
      } catch { /* transient */ }
    }, 2500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [run, onTrades, onOpenTrade]);

  const launch = async (startDate = start, endDate = end) => {
    if (!strategy) return;
    setErr(null);
    setTrades([]);
    onTrades([]);
    onOpenTrade?.(null);
    try {
      const bt = await api.createBacktest({
        strategyKey: strategy.key,
        symbol,
        timeframe,
        startTime: new Date(startDate).toISOString(),
        endTime: new Date(endDate + "T23:59:59Z").toISOString(),
        params: {
          ...params,
          qty_cash: properties.qtyType === "cash"
            ? (properties.qtyValue ?? properties.qtyCash)
            : properties.qtyCash,
          qty_pct_equity: properties.qtyType === "percent_of_equity"
            ? (properties.qtyValue ?? 100)
            : 0,
        },
        initialCapital: properties.initialCapital,
        commissionPct: properties.commissionPct,
        slippageTicks: properties.slippageTicks,
      });
      setRun(bt);
      setTab("overview");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Auto-run when a layout (or optimizer deep link) was just applied upstream;
  // the nonce guard makes this fire exactly once per application, and the
  // strategy dependency waits until the strategy list has loaded.
  useEffect(() => {
    if (!requestedRange?.run || !strategy) return;
    if (autoRanNonce.current === requestedRange.nonce) return;
    autoRanNonce.current = requestedRange.nonce;
    void launch(requestedRange.start, requestedRange.end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedRange, strategy]);

  const m = run?.metrics ?? null;
  const running = run !== null && (run.status === "queued" || run.status === "running");
  const inputBox = "rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink outline-none focus:border-accent";

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      {/* header bar */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button onClick={() => setCollapsed((c) => !c)} className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink" title={collapsed ? "Expand" : "Collapse"}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d={collapsed ? "M3 9l4-4 4 4" : "M3 5l4 4 4-4"} stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>
        <select
          value={strategy?.key ?? ""}
          onChange={(e) => onStrategyChange(e.target.value)}
          className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm font-medium text-ink outline-none"
        >
          {strategies.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <button onClick={onOpenSettings} className="rounded p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink" title="Strategy settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
        <span className="text-ink-faint">·</span>
        <span className="text-xs text-ink-faint">{symbol} {timeframe}</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputBox} />
        <span className="text-xs text-ink-faint">→</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputBox} />
        <button
          onClick={() => void launch()}
          disabled={running || !strategy}
          className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? "Running…" : "Run backtest"}
        </button>
        {run && <StatusBadge status={run.status} />}
        {err && <span className="text-xs text-down">{err}</span>}
        <div className="ml-auto flex gap-4">
          {(["overview", "trades"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setCollapsed(false); }}
              className={`border-b-2 pb-0.5 text-xs font-medium capitalize ${
                tab === t && !collapsed ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              {t === "trades" ? `List of trades${trades.length ? ` (${trades.length})` : ""}` : "Overview"}
            </button>
          ))}
        </div>
      </div>

      {/* body */}
      {!collapsed && (
        <div className="h-[220px] overflow-y-auto border-t border-border sm:h-[300px]">
          {tab === "overview" ? (
            m ? (
              <div className="flex h-full flex-col gap-2 px-4 py-3">
                <div className="flex flex-nowrap gap-x-8 overflow-x-auto whitespace-nowrap pb-1 [&>div]:shrink-0">
                  <Stat label="Total P&L" value={fmtPct(m.netProfitPct)} valueClass={signClass(m.netProfitPct)}
                    sub={`${fmtNum(m.netProfit)} USDT`} />
                  <Stat label="Max drawdown" value={`${fmtNum(m.maxDrawdownPct)}%`}
                    valueClass={m.maxDrawdownPct < 20 ? "text-ink" : "text-down"} />
                  <Stat label="Profitable trades" value={`${fmtNum(m.winRatePct, 1)}%`}
                    sub={`${m.winningTrades}/${m.totalTrades}`} />
                  <Stat label="Profit factor" value={m.profitFactor === null ? "∞" : fmtNum(m.profitFactor)}
                    valueClass={m.profitFactor === null || m.profitFactor >= 1 ? "text-up" : "text-down"} />
                  <Stat label="Avg trade" value={fmtPct(m.avgTradePct)} valueClass={signClass(m.avgTradePct)}
                    sub={`${fmtNum(m.avgBarsInTrade, 0)} bars avg`} />
                  <Stat label="Commission" value={fmtNum(m.commissionPaid)} valueClass="text-ink-muted" />
                </div>
                {m.openTrade && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs">
                    <span className="rounded bg-warn/20 px-1.5 py-0.5 font-semibold text-warn">OPEN TRADE</span>
                    <span className="text-ink-muted">Entry <span className="text-ink">{fmtPrice(m.openTrade.entryPrice)}</span></span>
                    <span className="text-ink-muted">Last <span className="text-ink">{fmtPrice(m.openTrade.lastPrice)}</span></span>
                    <span className="text-ink-muted">SL <span className="text-down">{m.openTrade.stop === null ? "—" : fmtPrice(m.openTrade.stop)}</span></span>
                    <span className="text-ink-muted">TP <span className="text-up">{m.openTrade.target === null ? "—" : fmtPrice(m.openTrade.target)}</span></span>
                    <span className="text-ink-muted">Unrealized{" "}
                      <span className={signClass(m.openTrade.unrealizedPnlPct)}>
                        {fmtPct(m.openTrade.unrealizedPnlPct)} ({fmtNum(m.openTrade.unrealizedPnl)} USDT)
                      </span>
                    </span>
                    <span className="text-ink-faint">{fmtNum(m.openTrade.barsHeld, 0)} bars held</span>
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  {run?.equityCurve && run.equityCurve.length > 0 && (
                    <EquityCurve points={run.equityCurve} initialCapital={run.initialCapital} className="h-[180px]" />
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-ink-faint">
                {running ? "Backtest running — fetching data and simulating…"
                  : run?.status === "error" ? <span className="text-down">{run.error}</span>
                  : "Configure the date range and hit “Run backtest” to see results here."}
              </div>
            )
          ) : (
            <TradeList trades={trades} />
          )}
        </div>
      )}
    </div>
  );
}
