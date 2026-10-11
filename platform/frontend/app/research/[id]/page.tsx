"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Button, Card, CardHeader, Notice, PageHeader, PageShell, StatusBadge, shortReason,
} from "@/components/ui";
import { Metrics } from "@/components/Metrics";
import { RunWindows } from "@/components/RunWindows";
import { EquityCurve, type EquityView } from "@/components/EquityCurve";
import { RunSettings } from "@/components/RunSettings";
import { TradeList } from "@/components/TradeList";
import { CandleChart, TRADE_LABEL_LIMIT, type ChartPriceLine } from "@/components/CandleChart";
import { api } from "@/lib/api";
import { olderEngineNotice, refusedSettingsNotice, runFailure } from "@/lib/backtestFigures";
import { downloadText, tradesCsv, tradesCsvName } from "@/lib/tradeExport";
import type { Backtest, Candle, Strategy, Trade } from "@/lib/types";
import { fmtDate, fmtPrice, UTC_DATE_NOTE } from "@/lib/format";

export default function BacktestDetail() {
  const id = useParams<{ id: string }>().id;
  const router = useRouter();
  const [bt, setBt] = useState<Backtest | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [equityView, setEquityView] = useState<EquityView>("equity");
  const [trades, setTrades] = useState<Trade[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [tab, setTab] = useState<"chart" | "trades">("chart");
  const [err, setErr] = useState<string | null>(null);
  /** What Copy link / Export last did, said once, politely. */
  const [shareNote, setShareNote] = useState<string | null>(null);

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
              new Date(b.startTime).getTime(), new Date(b.endTime).getTime(), 200000, undefined, "backtest"),
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

  // The strategy's NAME, for the settings card. Not fatal: without it the card
  // says "Strategy #3" and re-running is disabled rather than guessed.
  useEffect(() => {
    api.listStrategies().then(setStrategies).catch(() => {});
  }, []);

  /*
   * The address bar already holds this, but a button says it can be shared
   * and confirms that it was. Without the clipboard (an insecure origin, a
   * denied permission) the address is printed so it can be copied by hand.
   */
  const copyLink = async (): Promise<void> => {
    const href = window.location.href;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(href);
      setShareNote("Link copied.");
    } catch {
      setShareNote(`Copy this address: ${href}`);
    }
  };

  const rerun = async (body: Parameters<typeof api.createBacktest>[0]): Promise<string> => {
    const created = await api.createBacktest(body);
    router.push(`/research/${created.id}`);
    return created.id;
  };

  /*
   * Every state of this page keeps the heading and the way back.
   *
   * The error and loading branches used to return a bare <div>, so the two
   * states a user is most likely to be stuck in had no `h1`, no breadcrumb and
   * no navigation at all — the same defect the Operations page documents having
   * fixed.
   */
  const shell = (body: ReactNode): ReactNode => (
    <PageShell>
      <PageHeader
        title="Backtest"
        leading={<Link href="/research"><Button variant="ghost">← Backtests</Button></Link>}
      />
      {body}
    </PageShell>
  );

  if (err && !bt) return shell(
    <Notice tone="error" role="alert">
      {/* A malformed or unknown id is a 404 now, and "not served" would misdescribe it. */}
      {/^backtest not found$/.test(err) ? "There is no backtest with this id." : "This backtest could not be loaded."}
      <span className="mt-1 block text-xs text-ink-faint" title={err}>
        {/^backtest not found$/.test(err) ? "It may have been deleted, or the link is incomplete." : shortReason(err)}
      </span>
    </Notice>
  );
  if (!bt) return shell(<div role="status" className="text-ink-faint">Loading…</div>);

  const olderEngine = olderEngineNotice(bt);
  const refused = refusedSettingsNotice(bt);

  return (
    <PageShell>
      <PageHeader
        title={`${bt.symbol} · ${bt.timeframe}`}
        leading={<Link href="/research"><Button variant="ghost">← Backtests</Button></Link>}
        actions={<>
          <StatusBadge status={bt.status} />
          <span className="text-sm text-ink-faint" title={UTC_DATE_NOTE}>
            {fmtDate(bt.startTime)} → {fmtDate(bt.endTime)} <span className="text-ink-faint">UTC</span>
          </span>
          {/* HVBO-3: this page's address, for a colleague or a note. */}
          <Button variant="ghost" onClick={() => void copyLink()} title="Copy this result's address">
            Copy link
          </Button>
        </>}
      />
      {shareNote && <p role="status" className="-mt-2 text-right text-xs text-ink-faint">{shareNote}</p>}

      {err && (
        <Notice tone="error" role="alert">
          This page stopped updating.
          <span className="ml-1 text-ink-faint" title={err}>{shortReason(err)}</span>
        </Notice>
      )}

      {bt.status !== "done" ? (
        <>
          {bt.status === "error" ? <FailedRun raw={bt.error} id={bt.id} /> : (
            <Card><div role="status" className="px-4 py-10 text-center text-ink-faint">
              Backtest is still running…
            </div></Card>
          )}
          <RunSettings bt={bt} strategies={strategies} onRerun={rerun} />
        </>
      ) : (
        <>
          {/*
            C-02: a run from an older correction set is reproducible only
            under an engine this server no longer runs, so its figures are
            not what a re-run gives today. Said before the figures.
          */}
          {olderEngine && !refused && (
            <Notice tone="warn"><span data-older-engine>{olderEngine}</span></Notice>
          )}
          {refused ? (
            /*
             * C-07: settings the server now refuses — a negative capital, a
             * negative commission — produced Net −320 %, PF ∞, Win 100 % on
             * the headline. Those are not figures about any market, so they
             * lead with why and are kept one deliberate click away.
             */
            <>
              <Notice tone="error" role="alert">
                <span data-refused-settings-notice>
                  {refused}{" "}
                  These figures came from settings no market allows, and describe nothing that could be traded.
                </span>
              </Notice>
              <details className="rounded-md border border-border">
                <summary className="cursor-pointer select-none px-4 py-2 text-xs font-medium text-ink-muted hover:text-ink">
                  Show the recorded figures anyway
                </summary>
                <div className="space-y-4 p-2 opacity-60">
                  {bt.metrics && <Metrics m={bt.metrics} initialCapital={bt.initialCapital} />}
                  <RunWindows segments={bt.segments} execution={bt.executionTruth}
                    initialCapital={bt.initialCapital} stressRunId={bt.stressRunId} />
                </div>
              </details>
            </>
          ) : (
            <>
              {bt.metrics && <Metrics m={bt.metrics} initialCapital={bt.initialCapital} />}

              <RunWindows segments={bt.segments} execution={bt.executionTruth}
                initialCapital={bt.initialCapital} stressRunId={bt.stressRunId} />
            </>
          )}

          <RunSettings bt={bt} strategies={strategies} onRerun={rerun} />

          {ot && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs sm:text-sm">
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
            <CardHeader
              title={equityView === "equity" ? "Equity curve" : "Drawdown"}
              right={
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-faint">initial {bt.initialCapital}</span>
                  <div role="group" aria-label="Curve" className="flex">
                    <Button variant="ghost" pressed={equityView === "equity"} onClick={() => setEquityView("equity")}>Equity</Button>
                    <Button variant="ghost" pressed={equityView === "drawdown"} onClick={() => setEquityView("drawdown")}>Drawdown</Button>
                  </div>
                </div>
              }
            />
            <div className="p-2">
              {bt.equityCurve && bt.equityCurve.length > 0
                ? <EquityCurve points={bt.equityCurve} initialCapital={bt.initialCapital}
                    view={equityView}
                    split={bt.stressRunId === null && bt.segments?.available ? bt.segments.split : null} />
                : <div className="py-10 text-center text-ink-faint">No equity data</div>}
              {bt.stressRunId === null && bt.segments?.available && bt.equityCurve && bt.equityCurve.length > 0 && (
                <p className="px-1 pt-1 text-xs text-ink-faint">
                  The shaded band is the validation window ({Math.round(bt.segments.holdoutFraction * 100)}% of the
                  range); the markers show where the out-of-sample and validation windows begin. The curve runs
                  through both — it is one simulation.
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={tab === "chart" ? "Price & trades" : `Trades (${trades.length})`}
              right={
                <div className="flex items-center gap-2">
                {/* HVBO-3: the trade list, as a file, built here from the records shown. */}
                <Button variant="ghost" disabled={trades.length === 0}
                  title={trades.length === 0 ? "This run has no trades to export" : "Download every trade as a CSV file"}
                  onClick={() => {
                    const ok = downloadText(tradesCsvName(bt), tradesCsv(trades, bt.commissionPct));
                    setShareNote(ok ? `Exported ${trades.length} trade${trades.length === 1 ? "" : "s"}.`
                      : "This browser could not save the file.");
                  }}>
                  Export trades (CSV)
                </Button>
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
    </PageShell>
  );
}

/**
 * A run that did not finish, said for the person who ran it.
 *
 * This card used to read "This backtest failed. Hover for the reason
 * reported." — the reason being the engine's own `invalid SOLUSDT 1h
 * backfill: empty_series`. The engine's words are kept, verbatim and one
 * click away, but the card leads with what happened and what to change.
 */
function FailedRun({ raw, id }: { raw: string | null; id: string }) {
  const copy = runFailure(raw);
  return (
    <Card>
      <div role="alert" className="space-y-2 px-4 py-6">
        <p className="font-medium text-down">This backtest did not finish. {copy.headline}</p>
        <p className="text-sm text-ink-muted">
          {copy.action}{" "}
          <Link href={`/research?from=${encodeURIComponent(id)}`}
            className="rounded text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            Edit the settings and run it again
          </Link>.
        </p>
        {copy.detail && (
          <details className="text-xs text-ink-faint">
            <summary className="cursor-pointer select-none hover:text-ink">Technical detail</summary>
            <p className="mt-1 break-words">{copy.detail}</p>
          </details>
        )}
      </div>
    </Card>
  );
}
