"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, CardHeader, StatusBadge, Button } from "@/components/ui";
import { Metrics } from "@/components/Metrics";
import { EquityCurve } from "@/components/EquityCurve";
import { TradeList } from "@/components/TradeList";
import { CandleChart, TRADE_LABEL_LIMIT, type ChartPriceLine } from "@/components/CandleChart";
import { api } from "@/lib/api";
import type { Backtest, Candle, Trade } from "@/lib/types";
import { fmtDate, fmtPrice, UTC_DATE_NOTE } from "@/lib/format";

export default function BacktestDetail() {
  const id = useParams<{ id: string }>().id;
  const [bt, setBt] = useState<Backtest | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [tab, setTab] = useState<"chart" | "trades">("chart");
  const [err, setErr] = useState<string | null>(null);

  const ot = bt?.metrics?.openTrade ?? null;
  const openLines: ChartPriceLine[] = ot
    ? [
        { price: ot.entryPrice, color: "#f0b90b", title: "ENTRY", dashed: true },
        ...(ot.target !== null ? [{ price: ot.target, color: "#2ebd85", title: "TP" }] : []),
        ...(ot.stop !== null ? [{ price: ot.stop, color: "#f6465d", title: "SL" }] : []),
      ]
    : [];

  /*
   * This page never asked twice.
   *
   * A queued or running backtest rendered "Backtest is still running…" and then
   * sat there for as long as the tab was open — the list page polls, this one
   * did not, so the only way to see a result was to reload by hand. It now
   * polls on the same 2.5s cadence as the list, and stops as soon as the run
   * reaches a terminal state (or the request fails, so a dead backend is not
   * hammered).
   */
  useEffect(() => {
    let live = true;
    let timer: number | undefined;

    const load = async (): Promise<void> => {
      try {
        const b = await api.getBacktest(id);
        if (!live) return;
        setBt(b); setErr(null);
        if (b.status === "done") {
          const [tr, cs] = await Promise.all([
            api.getBacktestTrades(id),
            api.candlesRange(b.symbol, b.timeframe,
              new Date(b.startTime).getTime(), new Date(b.endTime).getTime()),
          ]);
          if (!live) return;
          setTrades(tr);
          setCandles(cs);
          return;
        }
        if (b.status === "error") return;
        timer = window.setTimeout(() => void load(), 2500);
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    };

    void load();
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [id]);

  /*
   * Every state of this page keeps the heading and the way back.
   *
   * The error and loading branches used to return a bare <div>, so the two
   * states a user is most likely to be stuck in had no `h1`, no breadcrumb and
   * no navigation at all — the same defect the Operations page documents having
   * fixed.
   */
  const shell = (body: ReactNode): ReactNode => (
    <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/research"><Button variant="ghost">← Backtests</Button></Link>
        <h1 className="text-lg font-semibold">Backtest</h1>
      </div>
      {body}
    </div>
  );

  if (err && !bt) return shell(
    <div role="alert" className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">
      This backtest could not be loaded.
      <span className="mt-1 block font-mono text-xs text-ink-faint">{err}</span>
    </div>
  );
  if (!bt) return shell(<div role="status" className="text-ink-faint">Loading…</div>);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/research"><Button variant="ghost">← Backtests</Button></Link>
        <h1 className="text-lg font-semibold">{bt.symbol} · {bt.timeframe}</h1>
        <StatusBadge status={bt.status} />
        <span className="text-sm text-ink-faint" title={UTC_DATE_NOTE}>
          {fmtDate(bt.startTime)} → {fmtDate(bt.endTime)} <span className="text-ink-faint">UTC</span>
        </span>
      </div>

      {err && (
        <div role="alert" className="rounded-md border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
          This page stopped updating.
          <span className="ml-1 font-mono text-ink-faint">{err}</span>
        </div>
      )}

      {bt.status !== "done" ? (
        <Card><div className="px-4 py-10 text-center text-ink-faint">
          {bt.status === "error" ? <span className="text-down">{bt.error}</span> : "Backtest is still running…"}
        </div></Card>
      ) : (
        <>
          {bt.metrics && <Metrics m={bt.metrics} initialCapital={bt.initialCapital} />}

          {ot && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs sm:text-sm">
              <span className="rounded bg-warn/20 px-1.5 py-0.5 text-xs font-semibold text-warn">OPEN TRADE</span>
              <span className="text-ink-muted">Entry <span className="text-ink">{fmtPrice(ot.entryPrice)}</span></span>
              <span className="text-ink-muted">Last <span className="text-ink">{fmtPrice(ot.lastPrice)}</span></span>
              <span className="text-ink-muted">SL <span className="text-down">{ot.stop === null ? "—" : fmtPrice(ot.stop)}</span></span>
              <span className="text-ink-muted">TP <span className="text-up">{ot.target === null ? "—" : fmtPrice(ot.target)}</span></span>
              <span className="text-ink-muted">Unrealized{" "}
                <span className={ot.unrealizedPnlPct >= 0 ? "text-up" : "text-down"}>
                  {ot.unrealizedPnlPct >= 0 ? "+" : ""}{ot.unrealizedPnlPct.toFixed(2)}%
                </span>
              </span>
            </div>
          )}

          <Card>
            <CardHeader title="Equity curve" right={<span className="text-xs text-ink-faint">initial {bt.initialCapital}</span>} />
            <div className="p-2">
              {bt.equityCurve && bt.equityCurve.length > 0
                ? <EquityCurve points={bt.equityCurve} initialCapital={bt.initialCapital} />
                : <div className="py-10 text-center text-ink-faint">No equity data</div>}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={tab === "chart" ? "Price & trades" : `Trades (${trades.length})`}
              right={
                <div className="flex rounded-md border border-border p-0.5">
                  {(["chart", "trades"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`rounded px-2.5 py-1 text-xs capitalize ${tab === t ? "bg-surface-2 text-ink" : "text-ink-muted"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              }
            />
            {tab === "chart" ? (
              <div className="overflow-hidden p-2">
                {/*
                  P-B4: above the limit the arrows lose their price labels,
                  because 600+ text runs across one plot is not readable. Saying
                  where the prices went is part of that change — silently
                  dropping them would just be a different kind of wrong.
                */}
                {trades.length * 2 > TRADE_LABEL_LIMIT && candles.length > 0 && (
                  <p className="px-1 pb-2 text-xs text-ink-faint">
                    {trades.length.toLocaleString()} trades — entries and exits are drawn as arrows
                    without price labels at this density. Open{" "}
                    <button onClick={() => setTab("trades")}
                      className="rounded text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                      Trades
                    </button>{" "}for every fill price.
                  </p>
                )}
                {candles.length > 0
                  ? <CandleChart symbol={bt.symbol} interval={bt.timeframe} candles={candles} trades={trades}
                      priceLines={openLines} live={false} />
                  : <div className="py-10 text-center text-ink-faint">No candle data</div>}
              </div>
            ) : (
              <TradeList trades={trades} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
