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
 * ── TVP8 owner veto (OV-B): composition, not just height ───────────────────
 *
 * This row was 38px tall like the reference's and still looked nothing like
 * it: the account entry was a glyph+chevron IN the row; Alert lived far to the
 * right of Replay; the chart style was a single dropdown where the reference
 * shows favourite styles as icon radios beside a caret; Trade was an icon;
 * `Last close 77,799 · 9,999 bars · Unnamed` sat in prime toolbar space; the
 * row itself ended where the watchlist began instead of spanning the window.
 *
 * The composition is now the reference's, measured live on 2026-09-14
 * (`measurements/tv-shell-live-inventory-20260914.md` in the campaign folder):
 *
 *   [BTCUSDT] [⊕] │ 1m 5m 15m 1h 4h 1D [⌄] │ [style][style][style] [⌄] │
 *   [indicators] │ [alert] [replay] │ [undo] [redo]   … ml-auto …
 *   [layout] [Unnamed ☁] [⌄] [sync*] │ [search] [settings] [fullscreen]
 *   [camera] [⋯] [ Trade ]
 *
 *   * only with two or more panes — a disabled Sync on a one-pane chart is a
 *     control that teaches "this is broken".
 *
 * Every control is icon-only at every width. The only words on the row are
 * the ticker, the interval chips, the saved layout's name and `Trade`. The
 * price readout and the bar count are gone from the bar: the price is in the
 * legend already, and the bar count is the History-depth group's tooltip in
 * the More strip. The account entry is the 52×38 cell at the top of the
 * left-rail column, rendered by the page — the row starts after it.
 *
 * ── The hierarchy ──────────────────────────────────────────────────────────
 *
 * The tier is a property of the CONTROL, declared in `lib/toolbarLayout`:
 *
 *   primary row  — chart context, then the workspace cluster pushed right.
 *                  The same row at 768px and at 2560px.
 *   More strip   — history depth, read-only trading overlays, server-side
 *                  automation, strategy properties, the optimizer's best
 *                  config. Opened deliberately, at every width.
 *
 * Below `md` the workspace cluster, the saved-layout identity and Trade move
 * into that strip — a phone genuinely has no room for them. Below `sm` so do
 * Compare, Indicators, Alert and Replay. Each is ONE component rendered in two
 * places, so the placements cannot drift apart.
 *
 * ── FC2-B1: which element absorbs pressure ─────────────────────────────────
 *
 * Nothing wraps, so the row is always one row. At desktop widths the row is
 * wider than its content. Below `sm` the timeframe strip is not rendered and
 * the SYMBOL pill truncates — a shortened instrument is legible and
 * recoverable; an overlapped control is neither. The invariant, asserted by a
 * pairwise sweep at 320 / 360 / 390 / 430: no two interactive boxes on this
 * bar intersect.
 */
import { useEffect, useRef } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { type Resolution } from "@/lib/resolution";
import { Separator } from "@/components/ui";
import { ChartTypeMenu } from "@/components/tv/ChartTypeMenu";
import { IndicatorTemplatesMenu, type TemplateStudies } from "@/components/tv/IndicatorTemplatesMenu";
import type { IndicatorTemplate, TemplateApplication } from "@/lib/indicatorTemplates";
import { LayoutSelector } from "@/components/tv/LayoutSelector";
import { LayoutMenu } from "@/components/tv/LayoutMenu";
import { SyncMenu } from "@/components/tv/SyncMenu";
import { TradingOverlayMenu } from "@/components/tv/TradingOverlays";
import type { ChartType } from "@/lib/chartType";
import type { ChartSettings } from "@/lib/chartSettings";
import type { SyncOptions } from "@/lib/paneSync";
import type { Layout } from "@/lib/layouts";
import {
  SEPARATOR, TOOL_BUTTON, TOOL_ICON_BUTTON, TOOL_ICON_SIZE, TOOL_ICON_STROKE,
  TOOL_PILL_OUTLINE, TOOLBAR_ROW_H,
} from "@/components/tv/toolbarChrome";
import { TimeframePicker, type ResolutionPreferences } from "@/components/tv/TimeframePicker";
import { toolbarGroup, type ToolbarControlId } from "@/lib/toolbarLayout";
import { toolbarDensityClasses } from "@/components/tv/toolbarDensity";
import { displaySymbol, displayTicker } from "@/lib/instrument";
import type {
  TradingOverlayItem, TradingOverlayPreferences, TradingOverlayResponse,
} from "@/lib/tradingOverlays";

export { SEPARATOR, TOOL_BUTTON, TOOL_ICON_BUTTON, TOOLBAR_H, TOOLBAR_ROW_H } from "@/components/tv/toolbarChrome";
export { toolbarDensityClasses } from "@/components/tv/toolbarDensity";

const HISTORY_OPTIONS = [
  { label: "2K", bars: 2000 },
  { label: "10K", bars: 10000 },
  { label: "50K", bars: 50000 },
  { label: "All", bars: 200000 },
];

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

/**
 * One glyph frame for every icon on the bar (OV-K).
 *
 * The reference's toolbar icons share a size, a stroke and round caps; ours
 * were drawn one at a time at 18px/1.7 and read as a different family. The
 * frame is the family; the children are the silhouette.
 */
function Glyph(props: { children: React.ReactNode; size?: number; stroke?: number }) {
  const size = props.size ?? TOOL_ICON_SIZE;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={props.stroke ?? TOOL_ICON_STROKE} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      {props.children}
    </svg>
  );
}

export interface ChartToolbarProps {
  /** The focused pane's instrument and timeframe. */
  symbol: string;
  interval: Resolution;
  onOpenSearch: () => void;
  /** Open the focused pane's comparison dialog. */
  onOpenCompare: () => void;
  onInterval: (interval: Resolution) => void;
  /**
   * The browser's favourite / recent / custom resolutions.
   *
   * Owned by the page rather than by this bar so the pane legend's own
   * timeframe control shows the same favourites and records the same recents:
   * two pickers reading two lists would be two products.
   */
  resolutions: ResolutionPreferences;

  chartType: ChartType;
  onChartType: (type: ChartType) => void;
  /** The focused pane's settings, for the chart-style control's disclosure text. */
  chartSettings?: ChartSettings;

  presetId: string;
  onPreset: (presetId: string) => void;

  sync: SyncOptions;
  onSync: (next: SyncOptions) => void;
  /** One pane: Sync has nothing to act on and is not rendered. */
  syncDisabled: boolean;

  bars: number;
  onBars: (bars: number) => void;
  /** How many bars the focused pane has actually loaded — the History group's tooltip. */
  loadedBars?: number;

  indicatorCount: number;
  onOpenIndicators: () => void;
  /** The focused pane's studies — what `Save indicator template…` captures. */
  indicatorTemplateStudies: TemplateStudies;
  /** Apply a template to the focused pane, and report what landed. */
  onApplyIndicatorTemplate: (t: IndicatorTemplate) => TemplateApplication;

  /** Drawing-history actions, on the primary row like the reference. */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;

  replayActive: boolean;
  replayPickerOpen: boolean;
  onToggleReplayPicker: () => void;
  replayBlocksLiveActions: boolean;

  /** The chart workspace is fullscreen right now. */
  fullscreen: boolean;
  /** The browser permits fullscreen at all; false hides the control entirely. */
  fullscreenSupported: boolean;
  onToggleFullscreen: () => void;
  onOpenChartSettings: () => void;
  onOpenCommandPalette: () => void;
  /** Save or copy a picture of the focused chart. */
  onSnapshot: (mode: "save" | "copy") => void;

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
}

/**
 * Layout, saved layout, sync, and the utilities — the right-hand group.
 *
 * One component, rendered in the primary row on a desktop and in the More
 * strip on a phone, so the two placements cannot drift apart and no control
 * exists in one and not the other.
 */
function WorkspaceActions(props: ChartToolbarProps & { className: string }) {
  return (
    <div className={`items-center ${props.className}`}>
      <div {...ctl("layout")} className="flex shrink-0 items-center">
        <LayoutSelector presetId={props.presetId} onChange={props.onPreset} />
      </div>

      <SavedLayoutIdentity {...props} className="flex" />

      {/*
        Sync is Trading Scene's own: the reference has no multi-chart sync
        control on the bar. It sits beside the layout controls it belongs with,
        and only exists when there are two or more panes to synchronise.
      */}
      {!props.syncDisabled && (
        <div {...ctl("sync")} className="flex shrink-0 items-center">
          <SyncMenu value={props.sync} onChange={props.onSync} disabled={false} />
        </div>
      )}

      <Separator className={SEPARATOR} />

      {/* The reference's order: quick search, settings, fullscreen, snapshot. */}
      <button {...ctl("commandPalette")} onClick={props.onOpenCommandPalette}
        title="Search tool or function"
        aria-label="Search tool or function" className={TOOL_ICON_BUTTON}>
        {/*
          R1b-03: a plain magnifier was the blind reviewer's first clue. The
          reference's quick-search glyph is a lens with a LIGHTNING BOLT in it,
          the bolt breaking the ring at the top — 18×21, not 16×16.
        */}
        <Glyph>
          <circle cx="10.2" cy="11.2" r="7.3" />
          <path d="M15.4 16.4L21 22" />
          <path d="M12.4 1.4L8.2 10.4h4.2l-1.4 7 5.4-9h-4.2z" />
        </Glyph>
      </button>

      <button {...ctl("chartSettings")} onClick={props.onOpenChartSettings}
        title="Chart settings — symbol, status, scales, canvas, trading and events"
        aria-label="Chart settings" className={TOOL_ICON_BUTTON}>
        {/*
          R1b-03: ours was a narrow POINTY-TOP hexagon at 16×18; the
          reference's is a wide FLAT-TOP one at 22×18 with a ring inside.
        */}
        <Glyph>
          <path d="M5.6 3.4h12.8L23.2 12l-4.8 8.6H5.6L0.8 12z" />
          <circle cx="12" cy="12" r="3.7" />
        </Glyph>
      </button>

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
          className={TOOL_ICON_BUTTON}
        >
          <Glyph>
            {props.fullscreen
              ? <><path d="M9 4v5H4" /><path d="M15 20v-5h5" /><path d="M20 9h-5V4" /><path d="M4 15h5v5" /></>
              : <><path d="M4 9V4h5" /><path d="M20 15v5h-5" /><path d="M15 4h5v5" /><path d="M9 20H4v-5" /></>}
          </Glyph>
        </button>
      )}

      <SnapshotMenu onSnapshot={props.onSnapshot} />
    </div>
  );
}

/** The camera: Save image / Copy image, as the reference's own camera offers. */
function SnapshotMenu({ onSnapshot }: { onSnapshot: (mode: "save" | "copy") => void }) {
  const [open, setOpen] = useExclusivePopover("toolbar:snapshot");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative">
      <button {...ctl("snapshot")}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Chart image"
        aria-label="Chart image" className={TOOL_ICON_BUTTON}>
        {/* R1b-03: 21×17, not 18×14 — the reference's camera nearly fills its cell. */}
        <Glyph>
          <path d="M1.2 8.6A1.9 1.9 0 013.1 6.7h3.2L8.2 3.6h7.6l1.9 3.1h3.2a1.9 1.9 0 011.9 1.9v9.6a1.9 1.9 0 01-1.9 1.9H3.1a1.9 1.9 0 01-1.9-1.9z" />
          <circle cx="12" cy="13.2" r="4.1" />
        </Glyph>
      </button>
      {open && (
        <div role="menu" aria-label="Chart image"
          className="tvc-menu absolute right-0 top-[38px] z-50 w-[196px]">
          {([["save", "Save image"], ["copy", "Copy image"]] as const).map(([mode, label]) => (
            <button
              key={mode}
              role="menuitem"
              onClick={() => { setOpen(false); onSnapshot(mode); }}
              className="tvc-menu-row w-full px-3 text-left text-sm text-ink-muted hover:text-ink"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compare, in the two places it has to be.
 *
 * Beside the symbol at `sm` and above, where the reference puts it and where a
 * comparison is started from; in the More strip below, one tap away. Showing
 * it at every width was tried first and MEASURED: at 320px it pushes `More`
 * 41px past the right edge.
 */
function CompareButton(props: ChartToolbarProps & { className: string }) {
  return (
    <button
      {...ctl("compare")}
      onClick={props.onOpenCompare}
      title="Compare this chart with another instrument"
      aria-label="Compare with another instrument"
      className={`${TOOL_ICON_BUTTON} ${props.className}`}
    >
      {/* R1b-03: 19×19. Ours drew the same ⊕ two pixels small in every direction. */}
      <Glyph><circle cx="12" cy="12" r="9.6" /><path d="M12 6.6v10.8M6.6 12h10.8" /></Glyph>
    </button>
  );
}

/**
 * Studies, Alert and Replay — chart context, but the three pieces of it a
 * 320px phone has no room for. Same one-component-two-placements shape as
 * `WorkspaceActions`, for the same reason.
 */
function ContextActions(props: ChartToolbarProps & { className: string }) {
  const { replayActive, replayBlocksLiveActions } = props;
  return (
    <div className={`items-center ${props.className}`}>
      <button
        {...ctl("indicators")}
        onClick={props.onOpenIndicators}
        title="Indicators, metrics, and strategies"
        aria-label={props.indicatorCount > 0
          ? `Indicators — ${props.indicatorCount} on the focused chart`
          : "Indicators"}
        className={TOOL_ICON_BUTTON}
      >
        {/*
          R1b-03 / BLIND clue 3: a rising line over three HOLLOW bars and NO
          baseline. Ours drew a peaked line over four filled ticks sitting on a
          solid rule, which is the generic "chart" glyph the blind reviewer
          named as a tell.
        */}
        <Glyph>
          <path d="M2.8 13.6l4.6-4.6 3.6 3.2 3.4-4.4 4.8-6" />
          <rect x="2.8" y="15.6" width="5.4" height="6.4" />
          <rect x="8.2" y="12.8" width="5.4" height="9.2" />
          <rect x="13.6" y="9.6" width="5.4" height="12.4" />
        </Glyph>
      </button>

      {/* The reference's 2×2-grid Indicator templates button, beside Indicators. */}
      <IndicatorTemplatesMenu studies={props.indicatorTemplateStudies} onApply={props.onApplyIndicatorTemplate} />

      <Separator className={`${SEPARATOR} hidden sm:inline-block`} />

      {/*
        FE-01: this bell used to open the deployment dialog, which created AND
        activated a live 800 USDT strategy. An alert means "tell me when";
        automation has its own button in the More strip that says what it does.
      */}
      <button
        {...ctl("alert")}
        onClick={props.onOpenPriceAlert} disabled={replayBlocksLiveActions}
        title={replayActive ? "Exit Replay to create live alerts" : "Create alert"}
        aria-label="Create alert"
        className={TOOL_ICON_BUTTON}
      >
        {/*
          R1b-03 / BLIND clue 2: a clock DIAL whose ring is broken at the lower
          right by the `+`, with the alarm arcs over the top — 21×21. Ours put
          the plus INSIDE a closed ring with two bells on top, which reads as a
          stopwatch.
        */}
        <Glyph>
          {/* the dial, opened at the lower right so the plus breaks the ring */}
          <path d="M20.2 16.4A9 9 0 1 0 14.8 21.2" />
          {/* the hands */}
          <path d="M12 7.2v5.4h4.1" />
          {/* the alarm's two arcs, over the top */}
          <path d="M2.6 5.4A10.6 10.6 0 0 1 6.9 1.9M17.1 1.9a10.6 10.6 0 0 1 4.3 3.5" />
          {/* the plus, sitting in the gap */}
          <path d="M18.6 15.5v7.2M15 19.1h7.2" />
        </Glyph>
      </button>

      <button
        {...ctl("replay")}
        onClick={props.onToggleReplayPicker}
        aria-pressed={replayActive || props.replayPickerOpen}
        aria-label="Bar replay"
        title={replayActive ? "Replay is active" : "Bar replay — start from a historical point"}
        className={TOOL_ICON_BUTTON}
      >
        {/* Double rewind: two hollow triangles, each against its own bar. */}
        <Glyph>
          <path d="M10.4 5.4L3.4 12l7 6.6z" /><path d="M11.6 5.4v13.2" />
          <path d="M19 5.4L12 12l7 6.6z" /><path d="M20.2 5.4v13.2" />
        </Glyph>
      </button>
    </div>
  );
}

/** The saved layout this workspace is on, and whether it is behind. */
function SavedLayoutIdentity(props: ChartToolbarProps & { className: string }) {
  return (
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

/**
 * The Trade pill — the row's last control, as the reference's bar ends in
 * one. The paper / demo / testnet order ticket; nothing here can reach a
 * live exchange.
 */
function TradeButton(props: ChartToolbarProps & { className: string }) {
  return (
    <button
      {...ctl("trade")}
      onClick={props.onOpenManual} disabled={props.replayBlocksLiveActions}
      title={props.replayActive ? "Exit Replay to trade" : "Paper / demo / testnet order ticket"}
      aria-label="Trade"
      className={`${TOOL_PILL_OUTLINE} ${props.className}`}
    >
      Trade
    </button>
  );
}

export function ChartToolbar(props: ChartToolbarProps) {
  const { symbol, interval, replayActive } = props;
  /*
   * TVP7. The pill used to read `OANDA:EUR/USD · FX` — a venue, a
   * separator and an asset-class tag, in the one control a user aims at first.
   * That is the canonical identity, and it is genuinely useful, but it is not
   * what names an instrument on a workstation: TradingView's pill says
   * `BTCUSDT` and the venue, the product type and the long name live in the
   * chart's status line and in the symbol dialog, where there is room to read
   * them. So the pill carries the ticker and the FULL identity stays in the
   * control's tooltip and accessible name.
   */
  const symbolLabel = displaySymbol(symbol);
  const tickerLabel = displayTicker(symbol);
  const { moreOpen, onMoreOpen } = props;
  const density = toolbarDensityClasses();
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the More strip, like every other overlay in the workspace.
  useEffect(() => {
    if (!moreOpen) return;
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [moreOpen, onMoreOpen]);

  const loaded = props.loadedBars;

  return (
    <div className="min-w-0 flex-1 bg-surface">
      {/* ── primary row: chart context, then the workspace cluster pushed right ── */}
      <div
        data-toolbar-row="primary"
        className={`flex ${TOOLBAR_ROW_H} flex-nowrap items-center pl-1 pr-1.5`}
      >
        {/*
          The instrument keeps its pill. TradingView's symbol control is also
          the one rounded, filled thing on an otherwise square bar — it is the
          subject the whole workspace is about, and it is the control a user
          aims at first, so it is allowed to be the one that stands out.

          The truncating label is what makes the mobile row safe: this is the
          element that gives width back when the viewport cannot hold the row.
          `min-w-[44px]` and not `min-w-0`, because the touch rule in
          `globals.css` sets a 44px minimum WIDTH without `!important` and a
          utility class outranks it.
        */}
        <button
          {...ctl("symbol")}
          onClick={props.onOpenSearch}
          title={`${symbolLabel} — change symbol (/)`}
          aria-label={`Change symbol — currently ${symbolLabel}`}
          /*
            R1b-01 / BLIND clue 8: 14px at REGULAR weight, and nothing in the
            chip but the ticker. A semibold ticker was the one heavy string on
            a row the reference sets entirely at 400.
          */
          className="flex h-7 min-w-[44px] shrink items-center rounded-full bg-state-active px-3 text-sm font-normal text-ink hover:brightness-110 sm:shrink-0"
        >
          <span className="min-w-0 truncate">{tickerLabel}</span>
        </button>

        <CompareButton {...props} className="hidden sm:flex" />

        <Separator className={`${SEPARATOR} hidden sm:inline-block`} />

        {/*
          The timeframe control: favourites as text chips, then a caret that
          opens the full list. What resolutions exist, which are favourites and
          how a custom one is entered all belong to `TimeframePicker`; this bar
          only decides where the control sits and what tier it is in. Below
          `sm` the strip is not rendered and the wrapper must not shrink below
          the caret it holds (FC2-B1).
        */}
        <div {...ctl("timeframe")} className="flex shrink-0 items-center">
          <TimeframePicker
            interval={interval}
            onInterval={props.onInterval}
            preferences={props.resolutions}
          />
        </div>

        <Separator className={`${SEPARATOR} hidden sm:inline-block`} />

        {/*
          The chart-style control is a slot: favourite styles as icon radios
          and a caret that opens the full list. What presentations exist, and
          how the main series draws them, belongs to the chart-type system.
        */}
        <div {...ctl("chartType")} className="flex shrink-0 items-center">
          <ChartTypeMenu value={props.chartType} onChange={props.onChartType}
            settings={props.chartSettings} />
        </div>

        <Separator className={`${SEPARATOR} hidden sm:inline-block`} />

        <ContextActions {...props} className="hidden sm:flex" />

        <Separator className={`${SEPARATOR} hidden sm:inline-block`} />

        <div className="flex shrink-0 items-center" aria-label="Edit history">
          <button
            {...ctl("undo")}
            onClick={props.onUndo}
            disabled={!props.canUndo}
            aria-label="Undo"
            title="Undo last drawing change"
            className={TOOL_ICON_BUTTON}
          >
            <Glyph><path d="M9.2 6.6L4.4 11.4l4.8 4.8" /><path d="M4.4 11.4h9.2a5.8 5.8 0 015.8 5.8v2" /></Glyph>
          </button>
          <button
            {...ctl("redo")}
            onClick={props.onRedo}
            disabled={!props.canRedo}
            aria-label="Redo"
            title="Redo last drawing change"
            className={TOOL_ICON_BUTTON}
          >
            <Glyph><path d="M14.8 6.6l4.8 4.8-4.8 4.8" /><path d="M19.6 11.4h-9.2a5.8 5.8 0 00-5.8 5.8v2" /></Glyph>
          </button>
        </div>

        {/* ── the right-hand group ── */}
        <div className="ml-auto flex min-w-0 shrink items-center">
          <WorkspaceActions {...props} className={density.cluster} />

          {/*
            More is Trading Scene's own — history depth, overlays, automation,
            the strategy tester and the optimizer have no counterpart on the
            reference's bar. It sits as the last icon before the Trade pill,
            and stays on the row at every width because it is the way INTO the
            strip that holds everything a narrow row cannot.
          */}
          <button
            {...ctl("more")}
            ref={moreButtonRef}
            onClick={() => onMoreOpen(!moreOpen)}
            aria-expanded={moreOpen}
            aria-controls="chart-toolbar-more"
            aria-label={moreOpen ? "Fewer controls" : "More controls"}
            title={moreOpen ? "Fewer controls" : "History depth, overlays, automation, strategy"}
            className={TOOL_ICON_BUTTON}
          >
            <Glyph stroke={2.6}><path d="M5 12h.01M12 12h.01M19 12h.01" /></Glyph>
          </button>

          <TradeButton {...props} className={`ml-1.5 ${density.cluster}`} />
        </div>
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
          className="flex flex-wrap items-center gap-1 border-t border-border px-1 py-1"
        >
          {/* Phone: compare, studies, alert, replay, the workspace cluster and Trade. */}
          <CompareButton {...props} className="flex sm:hidden" />
          <ContextActions {...props} className="flex sm:hidden" />
          <WorkspaceActions {...props} className={density.clusterInMore} />
          <TradeButton {...props} className={density.clusterInMore} />
          <Separator className={density.separatorInMore} />

          <div {...ctl("history")} role="group" aria-label="History depth"
            title={loaded !== undefined
              ? `${loaded.toLocaleString()} bars loaded on the focused chart`
              : undefined}
            className="flex items-center gap-0.5">
            <span className="mr-1 hidden text-[10px] uppercase tracking-wide text-ink-faint sm:inline">
              History
            </span>
            {HISTORY_OPTIONS.map((h) => (
              <button key={h.label} onClick={() => props.onBars(h.bars)}
                title={`Show up to ${h.bars.toLocaleString()} bars`}
                aria-pressed={props.bars === h.bars}
                className={`tvc-control flex h-[30px] items-center px-2 text-[13px] ${
                  props.bars === h.bars ? "font-semibold text-ink" : "text-ink-muted hover:text-ink"
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
            <Glyph size={18}><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></Glyph>
            Automate
          </button>

          <button
            {...ctl("strategy")}
            onClick={props.onOpenStrategy}
            title="Strategy properties for the tester"
            className={TOOL_BUTTON}>
            <Glyph size={18}><path d="M3 12h4l2-7 4 14 2-7h6" /></Glyph>
            Strategy
          </button>

          <button
            {...ctl("best")}
            onClick={props.onApplyBest} disabled={props.loadingBest || replayActive}
            title={replayActive ? "Exit Replay to apply a full-range optimizer result" : `Apply the local optimizer's best saved config for ${displayTicker(symbol)}`}
            /*
              A toolbar control, not a call to action: 38px, transparent, the
              inset chip — `warn` is reserved for a state whose outcome is not
              yet known (§2), not for drawing the eye to a feature.
            */
            className={`${TOOL_BUTTON} shrink-0 gap-1.5 disabled:cursor-not-allowed disabled:opacity-40`}>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M7 1l1.8 3.9 4.2.5-3.1 2.9.8 4.2L7 10.5 3.3 12.5l.8-4.2L1 5.4l4.2-.5L7 1Z" />
            </svg>
            {props.loadingBest ? "Loading…" : "Best config"}
          </button>
        </div>
      )}
    </div>
  );
}
