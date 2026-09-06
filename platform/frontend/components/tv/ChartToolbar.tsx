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
 * ── The hierarchy, and why the width no longer decides it ──────────────────
 *
 * This bar used to have one tier. Below 1280px a ⋯ toggle hid roughly half the
 * controls; at or above it, all of them rendered inline and wrapped — so a 13"
 * laptop got a compact bar and a large monitor got three ragged rows of chrome
 * before the first candle. More screen bought worse layout.
 *
 * Now the tier is a property of the CONTROL, declared in `lib/toolbarLayout`,
 * not of the viewport:
 *
 *   primary row  — chart context (symbol, timeframe, presentation, studies,
 *                  replay) then workspace actions (alert, ticket, layout, sync,
 *                  fullscreen), with the saved-layout identity pushed right.
 *                  The same row at 1280px and at 2560px.
 *   More strip   — history depth, read-only trading overlays, server-side
 *                  automation, strategy properties, the optimizer's best
 *                  config. Opened deliberately, at every width.
 *
 * The More strip is a full-width row below the bar rather than a popover
 * because the overlay control inside it opens its own menu downward, which a
 * popover would clip.
 *
 * Below `md` the workspace-action cluster and the saved-layout identity move
 * into that same strip — a phone genuinely has no room for them, and the brief
 * for this bar is a compact primary row at DESKTOP widths, with controlled
 * overflow below. They are rendered from one component either way, so the two
 * placements cannot drift apart.
 *
 * `md` there means md OF THE ROW, not of the screen. The manual ticket is a
 * static flex sibling of this column once it is open, so it subtracts its own
 * width from the row while every viewport query stays where it was. See
 * `toolbarDensityClasses` below: that mismatch is what drew the saved-layout
 * identity on top of the ticket's instrument header at 1024 and at 1280.
 *
 * Pressure inside the primary row is absorbed by the timeframe strip, which is
 * the one element allowed to scroll. Nothing wraps, so the row is always one
 * row.
 *
 * That absorber is `flex-initial`, not `flex-none`. `flex-none` pins the strip
 * at its content width, which made the row incompressible: with the manual
 * trading panel open the main column loses 341px, the row overflowed it, and
 * the saved-layout button was painted straight through the ticket's own
 * instrument header — two live controls drawn on top of each other. It must be
 * able to give width back (it never GROWS into free space, which is what keeps
 * the saved-layout identity pinned right by `ml-auto`). Absorbing pressure is
 * not the same as never receiving it, though: the strip can only give back the
 * width it has, so the breakpoints themselves also have to know about the
 * ticket. Both are needed.
 *
 * Every control that was here before is still here. Nothing was dropped to
 * make the row fit, and nothing decorative was added to make it look like some
 * other product.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Separator } from "@/components/ui";
import { ChartTypeMenu } from "@/components/tv/ChartTypeMenu";
import { LayoutSelector } from "@/components/tv/LayoutSelector";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { LayoutMenu } from "@/components/tv/LayoutMenu";
import { SyncMenu } from "@/components/tv/SyncMenu";
import { TradingOverlayMenu } from "@/components/tv/TradingOverlays";
import type { ChartType } from "@/lib/chartType";
import type { SyncOptions } from "@/lib/paneSync";
import type { Layout } from "@/lib/layouts";
import { timeframeStrip } from "@/lib/timeframes";
import { toolbarGroup, type ToolbarControlId } from "@/lib/toolbarLayout";
import type {
  TradingOverlayItem, TradingOverlayPreferences, TradingOverlayResponse,
} from "@/lib/tradingOverlays";
import type { Interval } from "@/lib/types";

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

/**
 * The bar's two collapse decisions, as class names.
 *
 * `md:` and `xl:` ask about the VIEWPORT. This row is not the viewport: open
 * the manual ticket and `ChartSidePanel` becomes a static flex sibling that
 * takes 341px out of this column, so at a 1280px screen the row is 939px wide
 * while `xl:` has already turned every text label on. The row then overflowed
 * its column and the saved-layout identity was painted over the ticket's own
 * instrument header — two live controls, one on top of the other.
 *
 * So when the ticket is open the same two decisions are made against the same
 * two widths shifted by the ticket's own width: `md` at 768+341=1109 and `xl`
 * at 1280+341=1621. With the ticket closed nothing changes at all.
 *
 * The literals live here rather than in `lib/toolbarLayout` because
 * tailwind.config.ts only scans app/ and components/, so a class name written
 * anywhere else emits no CSS. `toolbarDensity` there is the same rule as a
 * function, and chartToolbar.test.ts pins the two against each other.
 */
export function toolbarDensityClasses(ticketOpen: boolean): {
  label: string; cluster: string; clusterInMore: string;
  separator: string; separatorInMore: string;
} {
  return ticketOpen
    ? {
      label: "hidden min-[1621px]:inline",
      cluster: "hidden min-[1109px]:flex",
      clusterInMore: "flex min-[1109px]:hidden",
      separator: "hidden min-[1109px]:inline-block",
      separatorInMore: "min-[1109px]:hidden",
    }
    : {
      label: "hidden xl:inline",
      cluster: "hidden md:flex",
      clusterInMore: "flex md:hidden",
      separator: "hidden md:inline-block",
      separatorInMore: "md:hidden",
    };
}

/**
 * The tier marker every control carries.
 *
 * Spread onto the control itself, so the registry in `lib/toolbarLayout` is
 * what the bar is actually built from rather than a description of it that can
 * drift. It is also what lets a test assert the hierarchy without a DOM.
 */
function ctl(id: ToolbarControlId): { "data-toolbar-control": string; "data-toolbar-group": string } {
  return { "data-toolbar-control": id, "data-toolbar-group": toolbarGroup(id) };
}

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

  /** The chart workspace is fullscreen right now. */
  fullscreen: boolean;
  /** The browser permits fullscreen at all; false hides the control entirely. */
  fullscreenSupported: boolean;
  onToggleFullscreen: () => void;

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
  /**
   * The manual-trading ticket is open, so it is taking its own width out of
   * this bar's row. Not cosmetic: it is what the collapse breakpoints above
   * are measured against.
   */
  ticketOpen: boolean;
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

/**
 * The five supported intervals the quick strip has no room for.
 *
 * They are not new: the backend has always served 3m, 30m, 2h, 6h and 12h, and
 * the candle store, the alert evaluator and the Pine runner all handle them.
 * Only the toolbar's hard-coded list of six kept them unreachable.
 *
 * It sits OUTSIDE the scrolling strip on purpose — a popover inside an
 * `overflow-x-auto` container is clipped by it.
 */
function TimeframeMenu({
  interval, onInterval,
}: {
  interval: Interval;
  onInterval: (interval: Interval) => void;
}) {
  // Through the registry, so this cannot sit open beside the chart-type menu
  // forty pixels away in the same toolbar row.
  const [open, setOpen] = useExclusivePopover("timeframe");
  const boxRef = useRef<HTMLDivElement>(null);
  const strip = timeframeStrip(interval);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen]);

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-pressed={strip.moreActive}
        title="More timeframes"
        aria-label={strip.moreActive
          ? `Timeframe — currently ${interval}. More timeframes`
          : "More timeframes"}
        className={`flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-[13px] transition-colors ${
          strip.moreActive
            ? "bg-surface-2 font-semibold text-ink"
            : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
        }`}
      >
        {strip.moreLabel}
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label="More timeframes"
          className="absolute left-0 top-[34px] z-50 w-[132px] rounded-md border border-border bg-surface p-1 shadow-xl">
          {strip.more.map((i) => (
            <button
              key={i}
              role="menuitemradio"
              aria-checked={interval === i}
              onClick={() => { onInterval(i); setOpen(false); }}
              className={`flex w-full items-center rounded px-2 py-1.5 text-left text-[13px] transition-colors ${
                interval === i
                  ? "bg-surface-2 font-semibold text-ink"
                  : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
              }`}
            >
              {i}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Alert, ticket, layout, sync, fullscreen — what you DO with the chart.
 *
 * One component, rendered in the primary row on a desktop and in the More
 * strip on a phone, so the two placements cannot drift apart and no control
 * exists in one and not the other.
 */
function WorkspaceActions(props: ChartToolbarProps & { className: string; labelClass: string }) {
  const { replayActive, replayBlocksLiveActions } = props;
  const TOOL_LABEL = props.labelClass;
  return (
    <div className={`items-center gap-1.5 ${props.className}`}>
      {/*
        FE-01: this bell used to open the deployment dialog, which created AND
        activated a live 800 USDT strategy. A bell means "tell me when", in this
        product and in every other one; automation has its own button, in the
        More strip, that says what it does.
      */}
      <button
        {...ctl("alert")}
        onClick={props.onOpenPriceAlert} disabled={replayBlocksLiveActions}
        title={replayActive ? "Exit Replay to create live alerts" : "Notify me when price reaches a level"}
        aria-label="Alert"
        className={TOOL_BUTTON}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        <span className={TOOL_LABEL}>Alert</span>
      </button>

      <button
        {...ctl("trade")}
        onClick={props.onOpenManual} disabled={replayBlocksLiveActions}
        title={replayActive ? "Exit Replay to trade" : "Manual Binance Spot order ticket"}
        aria-label="Trade"
        className={TOOL_BUTTON}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 7h16M7 12h10M9 17h6" /><path d="M17 4l3 3-3 3M7 14l-3 3 3 3" />
        </svg>
        <span className={TOOL_LABEL}>Trade</span>
      </button>

      <div {...ctl("layout")} className="flex shrink-0 items-center">
        <LayoutSelector presetId={props.presetId} onChange={props.onPreset} />
      </div>

      <div {...ctl("sync")} className="flex shrink-0 items-center">
        <SyncMenu value={props.sync} onChange={props.onSync} disabled={props.syncDisabled} />
      </div>

      {/*
        Hidden rather than disabled when the browser will not allow it: an inert
        fullscreen button teaches the user the feature is broken, and
        `fullscreenEnabled` is false for reasons the page cannot fix (an iframe
        without the permission, a locked-down policy).
      */}
      {props.fullscreenSupported && (
        <button
          {...ctl("fullscreen")}
          onClick={props.onToggleFullscreen}
          aria-pressed={props.fullscreen}
          title={props.fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen the chart workspace"}
          aria-label={props.fullscreen ? "Exit fullscreen" : "Fullscreen"}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
            props.fullscreen
              ? "bg-surface-2 text-accent"
              : "text-ink-muted hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {props.fullscreen
              ? <><path d="M9 3v6H3" /><path d="M15 21v-6h6" /><path d="M21 9h-6V3" /><path d="M3 15h6v6" /></>
              : <><path d="M3 9V3h6" /><path d="M21 15v6h-6" /><path d="M15 3h6v6" /><path d="M9 21H3v-6" /></>}
          </svg>
        </button>
      )}
    </div>
  );
}

/** The saved layout this workspace is on, and whether it is behind. */
function SavedLayoutIdentity(props: ChartToolbarProps & { className: string }) {
  return (
    /*
      Second absorber, after the timeframe strip.
      At 1024 with the 341px ticket open the strip alone was 6px short, and two
      live controls still touched. The layout NAME truncates — it is the only
      text left on the row at that width — so the identity keeps its badge, its
      chevron and its click target while giving the row the last few pixels.
      At 1024 it now leaves the primary row entirely, because a 683px row is
      below `md` however wide the screen is; the caller decides that, so this
      component renders identically in both places.
    */
    <div {...ctl("savedLayouts")} className={`min-w-0 items-center ${props.className}`}>
      <LayoutMenu
        autosaveError={props.autosaveError}
        layouts={props.layouts}
        currentId={props.currentLayoutId}
        autosave={props.autosave}
        dirty={props.layoutDirty}
        {...props.layoutHandlers}
      />
    </div>
  );
}

export function ChartToolbar(props: ChartToolbarProps) {
  const { symbol, interval, replayActive } = props;
  const strip = timeframeStrip(interval);
  const { moreOpen, onMoreOpen } = props;
  const density = toolbarDensityClasses(props.ticketOpen);
  const TOOL_LABEL = density.label;

  // Escape closes the More strip, like every other overlay in the workspace.
  useEffect(() => {
    if (!moreOpen) return;
    const onEsc = (e: KeyboardEvent): void => { if (e.key === "Escape") onMoreOpen(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [moreOpen, onMoreOpen]);

  return (
    <div className="border-b border-border bg-surface">
      {/* ── primary row: chart context, then workspace actions ── */}
      <div
        data-toolbar-row="primary"
        className="flex flex-nowrap items-center gap-1.5 px-2 py-1 sm:px-2.5"
      >
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
          {...ctl("symbol")}
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

        {/*
          The timeframe strip is the one element that absorbs the row's width
          pressure: it scrolls rather than pushing the controls beside it off
          the bar, which is what keeps this a single row at every width.
        */}
        <div {...ctl("timeframe")} role="group" aria-label="Timeframe"
          className="flex min-w-0 flex-1 items-center gap-0.5 sm:flex-initial">
          <div className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {strip.quick.map((i) => (
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
          <TimeframeMenu interval={interval} onInterval={props.onInterval} />
        </div>

        <Separator className="hidden sm:inline-block" />

        {/*
          The chart-type control is a slot. What presentations exist, and how
          the main series draws them, belongs to the chart-type system — this
          bar only decides where the control sits and what tier it is in.
        */}
        <div {...ctl("chartType")} className="flex shrink-0 items-center">
          <ChartTypeMenu value={props.chartType} onChange={props.onChartType} />
        </div>

        <button
          {...ctl("indicators")}
          onClick={props.onOpenIndicators}
          title="Browse indicators and add one to the focused chart"
          aria-label={props.indicatorCount > 0
            ? `Indicators — ${props.indicatorCount} on the focused chart`
            : "Indicators"}
          className={TOOL_BUTTON}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M3 17l5-6 4 4 3-4 6 6" /><path d="M3 20h18" />
          </svg>
          <span className={TOOL_LABEL}>Indicators</span>
          {props.indicatorCount > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
              {props.indicatorCount}
            </span>
          )}
        </button>

        <button
          {...ctl("replay")}
          onClick={props.onToggleReplayPicker}
          aria-pressed={replayActive || props.replayPickerOpen}
          aria-label="Bar Replay"
          title={replayActive ? "Replay is active" : "Start Bar Replay from a historical point"}
          className={`${TOOL_BUTTON} ${replayActive || props.replayPickerOpen ? "bg-accent/15 text-accent" : ""}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M8 5v14l11-7z" /><path d="M4 5v14" />
          </svg>
          <span className={TOOL_LABEL}>Replay</span>
        </button>

        <Separator className={density.separator} />

        <WorkspaceActions {...props} className={density.cluster} labelClass={density.label} />

        <button
          {...ctl("more")}
          onClick={() => onMoreOpen(!moreOpen)}
          aria-expanded={moreOpen}
          aria-controls="chart-toolbar-more"
          aria-label={moreOpen ? "Fewer controls" : "More controls"}
          title={moreOpen ? "Fewer controls" : "History depth, overlays, automation, strategy"}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
            moreOpen ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
            <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
          </svg>
        </button>

        {/* Price and bar count: a readout, not a control, so it yields first. */}
        <div className="ml-auto hidden shrink-0 items-center gap-3 2xl:flex">
          {props.readout}
        </div>

        <SavedLayoutIdentity {...props} className={`ml-auto ${density.cluster} 2xl:ml-0`} />
      </div>

      {/*
        ── More: the secondary tier ──
        Deliberately opened, at every width. A full-width strip rather than a
        popover because the overlay control inside it opens its own menu
        downward, which a popover would clip.
      */}
      {moreOpen && (
        <div
          id="chart-toolbar-more"
          data-toolbar-row="secondary"
          role="group"
          aria-label="More chart controls"
          className="flex flex-wrap items-center gap-1.5 border-t border-border px-2 py-1.5 sm:px-2.5"
        >
          {/* Phone: the workspace actions and the saved layout live here. */}
          <WorkspaceActions {...props} className={density.clusterInMore} labelClass={density.label} />
          <SavedLayoutIdentity {...props} className={density.clusterInMore} />
          <Separator className={density.separatorInMore} />

          <div {...ctl("history")} role="group" aria-label="History depth" className="flex items-center gap-0.5">
            <span className="mr-1 hidden text-[10px] uppercase tracking-wide text-ink-faint sm:inline">
              History
            </span>
            {HISTORY_OPTIONS.map((h) => (
              <button key={h.label} onClick={() => props.onBars(h.bars)}
                title={`Show up to ${h.bars.toLocaleString()} bars`}
                aria-pressed={props.bars === h.bars}
                className={`flex h-7 items-center rounded px-2 text-xs transition-colors ${
                  props.bars === h.bars
                    ? "bg-surface-2 font-semibold text-ink"
                    : "text-ink-muted hover:bg-surface-2/60 hover:text-ink"
                }`}>
                {h.label}
              </button>
            ))}
          </div>

          <Separator />

          <div {...ctl("overlays")} className="flex shrink-0 items-center">
            <TradingOverlayMenu open={props.overlayMenuOpen} onOpen={props.onOverlayMenuOpen}
              value={props.overlayPrefs} onChange={props.onOverlayPrefs}
              data={props.overlayData} loading={props.overlaysLoading} error={props.overlayError}
              items={props.overlayItems} onSelect={props.onSelectOverlay} />
          </div>

          <button
            {...ctl("automate")}
            onClick={props.onOpenAutomation} disabled={props.replayBlocksLiveActions}
            title={replayActive ? "Exit Replay to invoke Bot automation" : "Run this strategy server-side and send live orders to your bot"}
            className={TOOL_BUTTON}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
            </svg>
            Automate
          </button>

          <button
            {...ctl("strategy")}
            onClick={props.onOpenStrategy}
            title="Strategy properties for the tester"
            className={TOOL_BUTTON}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M3 12h4l2-7 4 14 2-7h6" />
            </svg>
            Strategy
          </button>

          <button
            {...ctl("best")}
            onClick={props.onApplyBest} disabled={props.loadingBest || replayActive}
            title={replayActive ? "Exit Replay to apply a full-range optimizer result" : `Apply the local optimizer's best saved config for ${symbol}`}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 text-[13px] font-medium text-warn transition-colors hover:bg-warn/20 disabled:cursor-wait disabled:opacity-60">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M7 1l1.8 3.9 4.2.5-3.1 2.9.8 4.2L7 10.5 3.3 12.5l.8-4.2L1 5.4l4.2-.5L7 1Z" />
            </svg>
            {props.loadingBest ? "Loading…" : "Best config"}
          </button>

          <div className="ml-auto flex shrink-0 items-center gap-3 2xl:hidden">
            {props.readout}
          </div>
        </div>
      )}
    </div>
  );
}
