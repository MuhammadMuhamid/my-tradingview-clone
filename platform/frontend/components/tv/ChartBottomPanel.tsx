"use client";
/**
 * The workspace's bottom drawer: Positions & Orders, the Strategy Tester and
 * the Pine Editor.
 *
 * Positions & Orders is the trader-state area — what the account holds and
 * what is in flight, read-only, from the same Bot-authoritative read the
 * ticket makes. It is the first tab because it is the one a trader looks at
 * after ordering; the tester and the editor are research tools.
 *
 * One tester and one editor for the whole workspace, both pointed at the
 * FOCUSED pane — testing a strategy is a question about one instrument and one
 * resolution, and sixteen simultaneous testers would be sixteen backtests
 * nobody asked for.
 *
 * The panel owns its own open/closed preference because that preference is
 * about this drawer and nothing else. Phones and desktops store it separately:
 * a tester left open on a large screen must not open itself on a phone, where
 * it would take over half the chart.
 */
import { useCallback, useEffect, useState } from "react";
import { PineEditor } from "@/components/tv/PineEditor";
import { StrategyTester } from "@/components/tv/StrategyTester";
import { TradingStateStrip } from "@/components/tv/TradingStateStrip";
import type { StrategyProperties } from "@/components/tv/StrategySettingsModal";
import type { PineParams } from "@/lib/indicators";
import type { ManualTradingState, PineScript } from "@/lib/api";
import type { Interval, OpenTrade, Strategy, StrategyParams, Trade } from "@/lib/types";

/**
 * Bottom-panel preference key. Phones and desktops store it separately so one
 * form factor's choice never dictates the other's opening layout.
 */
const bottomKey = (): string =>
  typeof window !== "undefined" && window.innerWidth < 768
    ? "tv.bottomCollapsed.mobile"
    : "tv.bottomCollapsed";

export interface ChartBottomPanelProps {
  /** The focused pane's instrument and resolution. */
  symbol: string;
  interval: Interval;
  replayActive: boolean;

  strategies: Strategy[];
  strategy: Strategy | null;
  onStrategyChange: (key: string) => void;
  onOpenSettings: () => void;
  properties: StrategyProperties;
  params: StrategyParams;
  requestedRange: { start: string; end: string; nonce: number; run?: boolean } | null;
  onTrades: (trades: Trade[]) => void;
  onOpenTrade: (trade: OpenTrade | null) => void;

  /** Pine run window, which follows the workspace replay horizon. */
  startTime: string;
  endTime: string;
  /** Applied studies on the focused pane. */
  indicatorCount: number;
  onOpenIndicators: () => void;
  openScript: PineScript | null;
  openParams: PineParams | undefined;
  onOpenScriptConsumed: () => void;
  onApplyToChart: (payload: { name: string; source: string; params: PineParams }) => void;
  editingApplied: boolean;

  /** Positions and orders, from the same read the ticket uses. Read-only here. */
  manualState: ManualTradingState | null;
  manualUnavailable: string | null;
  /** The instrument the ticket points at (the focused pane, unless pinned). */
  tradingSymbol: string;
  onOpenTicket: () => void;
}

export function ChartBottomPanel(props: ChartBottomPanelProps) {
  const [tab, setTab] = useState<"trading" | "tester" | "pine">("trading");
  /** Collapsed to just its tab strip, so the chart gets the full height. */
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(bottomKey());
    /*
     * Default closed on every form factor, not only on phones. The panel opens
     * on an empty placeholder that says "hit Run backtest", and it was taking
     * ~40% of the workspace to say it — on a chart-first product that is the
     * most expensive blank space on the screen. The tab strip stays visible as
     * the handle, and once a user opens it the preference is theirs.
     */
    setCollapsed(stored === null ? true : stored === "1");
  }, []);

  /**
   * Persist on the user's action rather than in an effect on the value.
   * An effect keyed to `collapsed` runs in the same commit as the restore
   * effect, before the restored state has been applied, so it writes the
   * initial `false` straight back over the stored preference.
   */
  const toggleBottom = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      window.localStorage.setItem(bottomKey(), next ? "1" : "0");
      return next;
    });
  }, []);

  /*
   * Handing the editor a script IS the request to look at it — from the
   * library list, and from "edit" on an applied study. The page used to open
   * the panel itself at both call sites, which is one place too many for a
   * rule about this drawer.
   */
  const { openScript } = props;
  useEffect(() => {
    if (!openScript) return;
    setTab("pine");
    setCollapsed(false);
  }, [openScript]);

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      <div className="flex items-center gap-4 border-b border-border px-3 py-1">
        {([["trading", "Positions & Orders"], ["tester", "Strategy Tester"], ["pine", "Pine Editor"]] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              // Clicking the active tab while collapsed reopens it, which
              // is what a collapsed tab strip invites you to do.
              if (tab === id) toggleBottom();
              else {
                setTab(id);
                setCollapsed(false);
                window.localStorage.setItem(bottomKey(), "0");
              }
            }}
            // 22px measured on a phone. The tab strip is also the handle
            // that brings a collapsed panel back, so it has to be pressable
            // with a thumb, not only clickable with a pointer.
            className={`flex min-h-[32px] items-end border-b-2 pb-1.5 text-xs font-medium ${
              tab === id && !collapsed
                ? "border-accent text-ink"
                : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {props.indicatorCount > 0 && (
            <button
              onClick={props.onOpenIndicators}
              className="flex items-center gap-2 text-[11px] text-ink-faint hover:text-ink"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {props.indicatorCount} indicator{props.indicatorCount === 1 ? "" : "s"} on this chart
            </button>
          )}
          <button
            onClick={toggleBottom}
            title={collapsed ? "Expand panel" : "Minimize panel"}
            aria-label={collapsed ? "Expand panel" : "Minimize panel"}
            // 20x20 measured below the 24x24 minimum a pointer target
            // needs, and it is the control that hides the panel covering
            // the chart — the one a phone user reaches for most.
            className="flex h-7 w-7 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              {collapsed ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
            </svg>
          </button>
        </div>
      </div>
      {/* Collapsed: the tab strip stays as the handle to bring it back.
          The body unmounts rather than hiding, so a collapsed Pine Editor
          stops compiling on every keystroke. */}
      {collapsed ? null : tab === "trading" ? (
        <TradingStateStrip
          state={props.manualState}
          symbol={props.tradingSymbol}
          onOpenTicket={props.onOpenTicket}
          unavailable={props.manualUnavailable}
        />
      ) : tab === "tester" && props.replayActive ? (
        <div className="flex h-[180px] items-center justify-center px-6 text-center text-sm text-ink-muted">
          Strategy Tester is unavailable during Bar Replay. Exit Replay to run a full-range strategy test.
        </div>
      ) : tab === "tester" ? (
        <StrategyTester
          symbol={props.symbol}
          timeframe={props.interval}
          strategies={props.strategies}
          strategy={props.strategy}
          onStrategyChange={props.onStrategyChange}
          onOpenSettings={props.onOpenSettings}
          properties={props.properties}
          params={props.params}
          requestedRange={props.requestedRange}
          onTrades={props.onTrades}
          onOpenTrade={props.onOpenTrade}
        />
      ) : (
        <div className="h-[380px]">
          <PineEditor
            symbol={props.symbol}
            timeframe={props.interval}
            startTime={props.startTime}
            endTime={props.endTime}
            appliedCount={props.indicatorCount}
            openScript={props.openScript}
            openParams={props.openParams}
            onOpenScriptConsumed={props.onOpenScriptConsumed}
            onApplyToChart={props.onApplyToChart}
            editingApplied={props.editingApplied}
          />
        </div>
      )}
    </div>
  );
}
