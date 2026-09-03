"use client";
/**
 * The workspace's global controls.
 *
 * ── What belongs here and what does not ────────────────────────────────────
 *
 * This bar acts on the WORKSPACE, or on the focused pane as the workspace's
 * current subject. Anything that is genuinely one chart's own — its symbol,
 * its timeframe strip, its maximise button — lives on the pane, where it can
 * be reached without first focusing something.
 *
 * The symbol and interval controls here are the focused pane's, deliberately:
 * they were the page's only symbol controls before this workspace existed, and
 * a user reaching for the top of the screen means "the chart I am looking at".
 * Whether that reaches other panes is the Sync menu's business, not this file's.
 *
 * Extracted from a 1,795-line page so that toolbar and symbol-search work can
 * proceed without touching chart internals. It renders; it holds no state
 * beyond its own overflow toggle.
 */
import type { ReactNode } from "react";
import { Separator } from "@/components/ui";
import { ChartTypeMenu } from "@/components/tv/ChartTypeMenu";
import { LayoutSelector } from "@/components/tv/LayoutSelector";
import { LayoutMenu } from "@/components/tv/LayoutMenu";
import { SyncMenu } from "@/components/tv/SyncMenu";
import { TradingOverlayMenu } from "@/components/tv/TradingOverlays";
import type { ChartType } from "@/lib/chartType";
import type { SyncOptions } from "@/lib/paneSync";
import type { Layout } from "@/lib/layouts";
import type {
  TradingOverlayItem, TradingOverlayPreferences, TradingOverlayResponse,
} from "@/lib/tradingOverlays";
import type { Interval } from "@/lib/types";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

const HISTORY_OPTIONS = [
  { label: "2K", bars: 2000 },
  { label: "10K", bars: 10000 },
  { label: "50K", bars: 50000 },
  { label: "All", bars: 200000 },
];

/**
 * Every secondary toolbar control, at one height.
 *
 * They were a mixture of `py-1` and `py-1.5` with three different text sizes,
 * so the row's baseline stepped up and down across it — the single most
 * visible difference between this toolbar and a professional one.
 */
export const TOOL_BUTTON =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] " +
  "text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink " +
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted";

export interface ChartToolbarProps {
  /** The focused pane's instrument and timeframe. */
  symbol: string;
  interval: Interval;
  onOpenSearch: () => void;
  onInterval: (interval: Interval) => void;

  chartType: ChartType;
  onChartType: (type: ChartType) => void;

  presetId: string;
  onPreset: (presetId: string) => void;

  sync: SyncOptions;
  onSync: (next: SyncOptions) => void;
  syncDisabled: boolean;

  bars: number;
  onBars: (bars: number) => void;

  indicatorCount: number;
  onOpenIndicators: () => void;

  replayActive: boolean;
  replayPickerOpen: boolean;
  onToggleReplayPicker: () => void;
  replayBlocksLiveActions: boolean;

  overlayMenuOpen: boolean;
  onOverlayMenuOpen: (open: boolean) => void;
  overlayPrefs: TradingOverlayPreferences;
  onOverlayPrefs: (next: TradingOverlayPreferences) => void;
  overlayData: TradingOverlayResponse | null;
  overlaysLoading: boolean;
  overlayError: string | null;
  overlayItems: TradingOverlayItem[];
  onSelectOverlay: (id: string) => void;

  onOpenPriceAlert: () => void;
  onOpenAutomation: () => void;
  onOpenManual: () => void;
  onOpenStrategy: () => void;
  onApplyBest: () => void;
  loadingBest: boolean;

  /** Right-hand readout for the focused pane. */
  readout: ReactNode;

  layouts: Layout[];
  currentLayoutId: string | null;
  autosave: boolean;
  layoutDirty: boolean;
  autosaveError: string | null;
  layoutHandlers: {
    onSelect: (id: string) => void;
    onSaveNow: () => void;
    onToggleAutosave: () => void;
    onCreate: () => void;
    onCopy: () => void;
    onRename: () => void;
    onDelete: (id: string) => void;
  };

  moreOpen: boolean;
  onMoreOpen: (open: boolean) => void;
  onOpenNav: () => void;
}

export function ChartToolbar(props: ChartToolbarProps) {
  const { symbol, interval, replayActive, replayBlocksLiveActions } = props;

  return (
    <div className="flex flex-nowrap items-center gap-1.5 border-b border-border bg-surface px-2 py-1 sm:flex-wrap sm:overflow-x-visible sm:px-2.5">
      {/* Phone-only: site nav lives here, so the global bar can be hidden. */}
      <button
        onClick={props.onOpenNav}
        aria-label="Menu"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink md:hidden"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <button
        onClick={props.onOpenSearch}
        title="Change symbol (/)"
        aria-label={`Change symbol — currently ${symbol}`}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-sm font-semibold text-ink transition-colors hover:bg-border"
      >
        {symbol}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-ink-faint">
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
        </svg>
      </button>
      <Separator className="hidden sm:inline-block" />
      {/* The interval strip is the only thing allowed to overflow, so the
          ☰ and ⋯ buttons stay pinned at the edges of a narrow screen. */}
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:flex-none sm:overflow-visible">
        {INTERVALS.map((i) => (
          <button key={i} onClick={() => props.onInterval(i)}
            aria-pressed={interval === i}
            className={`flex h-7 shrink-0 items-center rounded px-2 text-[13px] transition-colors ${
              interval === i
                ? "bg-surface-2 font-semibold text-ink"
                : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
            }`}>
            {i}
          </button>
        ))}
      </div>
      <Separator className="hidden sm:inline-block" />
      <ChartTypeMenu value={props.chartType} onChange={props.onChartType} />
      <button
        onClick={props.onToggleReplayPicker}
        aria-pressed={replayActive || props.replayPickerOpen}
        title={replayActive ? "Replay is active" : "Start Bar Replay from a historical point"}
        className={`${TOOL_BUTTON} ${replayActive || props.replayPickerOpen ? "bg-accent/15 text-accent" : ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M8 5v14l11-7z" /><path d="M4 5v14" />
        </svg>
        Replay
      </button>
      <TradingOverlayMenu open={props.overlayMenuOpen} onOpen={props.onOverlayMenuOpen}
        value={props.overlayPrefs} onChange={props.onOverlayPrefs}
        data={props.overlayData} loading={props.overlaysLoading} error={props.overlayError}
        items={props.overlayItems} onSelect={props.onSelectOverlay} />
      {/*
        Secondary controls: inline on a wide screen, behind ⋯ below it.
        The threshold used to be 768px, which meant a 1024px laptop with
        the watchlist open laid these out across THREE wrapped rows —
        nearly a third of the viewport spent on chrome before the first
        candle. They cannot be put in a horizontal scroller instead: the
        layout and sync menus open downwards out of it, and a scroll
        container would clip them. So below `xl` they collapse behind the
        same ⋯ toggle the phone layout already uses.
      */}
      <div className={`${props.moreOpen ? "flex" : "hidden"} order-last w-full flex-wrap items-center gap-1.5 border-t border-border pt-1.5 xl:order-none xl:flex xl:w-auto xl:border-0 xl:pt-0`}>
        <Separator className="hidden xl:inline-block" />
        <div className="flex items-center gap-0.5">
          {HISTORY_OPTIONS.map((h) => (
            <button key={h.label} onClick={() => props.onBars(h.bars)}
              title={`Show up to ${h.bars.toLocaleString()} bars`}
              aria-pressed={props.bars === h.bars}
              className={`flex h-7 items-center rounded px-2 text-xs transition-colors ${
                props.bars === h.bars
                  ? "bg-surface-2 text-ink"
                  : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
              }`}>
              {h.label}
            </button>
          ))}
        </div>
        <Separator />
        <button onClick={props.onOpenIndicators}
          title="Pine indicators on the focused chart"
          className={TOOL_BUTTON}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 17l5-6 4 4 3-4 6 6" /><path d="M3 20h18" />
          </svg>
          Indicators
          {props.indicatorCount > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
              {props.indicatorCount}
            </span>
          )}
        </button>
        <LayoutSelector presetId={props.presetId} onChange={props.onPreset} />
        <SyncMenu value={props.sync} onChange={props.onSync} disabled={props.syncDisabled} />
        {/*
          FE-01: this bell used to open the deployment dialog, which created
          AND activated a live 800 USDT strategy. A bell means "tell me when",
          in this product and in every other one; automation now has its own
          button, below, that says what it does.
        */}
        <button onClick={props.onOpenPriceAlert} disabled={replayBlocksLiveActions}
          title={replayActive ? "Exit Replay to create live alerts" : "Notify me when price reaches a level"}
          className={TOOL_BUTTON}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
          </svg>
          Alert
        </button>
        <button onClick={props.onOpenAutomation} disabled={replayBlocksLiveActions}
          title={replayActive ? "Exit Replay to invoke Bot automation" : "Run this strategy server-side and send live orders to your bot"}
          className={TOOL_BUTTON}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
          </svg>
          Automate
        </button>
        <button onClick={props.onOpenManual}
          disabled={replayBlocksLiveActions}
          title={replayActive ? "Exit Replay to trade" : "Manual Binance Spot order ticket"}
          className={TOOL_BUTTON}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 7h16M7 12h10M9 17h6" /><path d="M17 4l3 3-3 3M7 14l-3 3 3 3" />
          </svg>
          Trade
        </button>
        <button onClick={props.onOpenStrategy}
          className={TOOL_BUTTON}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 12h4l2-7 4 14 2-7h6" />
          </svg>
          Strategy
        </button>
        <button onClick={props.onApplyBest} disabled={props.loadingBest || replayActive}
          title={replayActive ? "Exit Replay to apply a full-range optimizer result" : `Apply the local optimizer's best saved config for ${symbol}`}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 text-[13px] font-medium text-warn transition-colors hover:bg-warn/20 disabled:cursor-wait disabled:opacity-60">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <path d="M7 1l1.8 3.9 4.2.5-3.1 2.9.8 4.2L7 10.5 3.3 12.5l.8-4.2L1 5.4l4.2-.5L7 1Z" />
          </svg>
          {props.loadingBest ? "Loading…" : "Best"}
        </button>
        <div className="flex shrink-0 items-center gap-3 xl:ml-auto">
          {props.readout}
          <LayoutMenu
            autosaveError={props.autosaveError}
            layouts={props.layouts}
            currentId={props.currentLayoutId}
            autosave={props.autosave}
            dirty={props.layoutDirty}
            {...props.layoutHandlers}
          />
        </div>
      </div>

      {/* Overflow toggle for the secondary controls, below `xl`. */}
      <button
        onClick={() => props.onMoreOpen(!props.moreOpen)}
        aria-label={props.moreOpen ? "Fewer controls" : "More controls"}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md xl:hidden ${
          props.moreOpen ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
        </svg>
      </button>
    </div>
  );
}
