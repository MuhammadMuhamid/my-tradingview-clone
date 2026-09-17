"use client";
/**
 * Everything to the right of the charts, plus the phone chrome that replaces
 * it on a small screen.
 *
 * These panels act on the FOCUSED pane — its watchlist selection, its applied
 * studies, its moving averages — or on the workspace's order ticket, which has
 * a target of its own that focus does not move (see `lib/tradingTarget`). None
 * of them knows what the layout is, and none of them reaches a pane directly.
 *
 * On a phone the same set is a drawer plus a thumb-height action bar, because
 * a column of panels beside a chart is not a phone layout — it is a desktop
 * layout with the chart squeezed out of it.
 */
import { useState, type ReactNode } from "react";
import { useIsMobile } from "@/lib/useIsMobile";
import { type Resolution } from "@/lib/resolution";
import { AlertsPanel } from "@/components/tv/AlertsPanel";
import { IndicatorsPanel } from "@/components/tv/IndicatorsPanel";
import { ManualTradingPanel } from "@/components/tv/ManualTradingPanel";
import { MaPanel } from "@/components/tv/MaPanel";
import { PushSetup } from "@/components/tv/PushSetup";
import { Watchlist } from "@/components/tv/Watchlist";
import { CorrelationPanel } from "@/components/tv/CorrelationPanel";
import type { MaAlert, ManualTradingState, PineScript } from "@/lib/api";
import type { NativeStudiesApi } from "@/lib/useNativeStudies";
import type { AppliedIndicator } from "@/lib/indicators";
import type { IndicatorsApi } from "@/lib/useIndicators";
import type { MaType } from "@/lib/movingAverages";
import type { ReplayQuote } from "@/lib/replay";
import type { SymbolInfo } from "@/lib/types";
import type { IndicatorKind } from "@/components/tv/IndicatorAlertModal";
import { canonicalDisplayParts, isCanonicalInstrumentId } from "@/lib/instrument";
import { WorkstationOrderTicket } from "@/components/tv/WorkstationOrderTicket";
import { ShortcutsSheet } from "@/components/tv/ShortcutsSheet";
import {
  ObjectsDataPanel, type ObjectsDataPanelProps,
} from "@/components/tv/ObjectsDataPanel";

export type ChartPanel =
  | "watchlist" | "alerts" | "objects" | "indicators" | "ma" | "manual" | "correlation" | null;

export interface ChartSidePanelProps {
  panel: ChartPanel;
  onPanel: (update: (current: ChartPanel) => ChartPanel) => void;
  onClosePanel: () => void;

  /** The focused pane's instrument and resolution. */
  symbol: string;
  interval: Resolution;
  replayActive: boolean;
  replayBlocksLiveActions: boolean;

  symbols: SymbolInfo[];
  onSelectSymbol: (symbol: string) => void;
  /** History depth the correlation table asks for per instrument. */
  bars: number;
  /** Watchlist row actions, which are workspace facts rather than list facts. */
  onOpenSymbolInNewPane?: (symbol: string) => void;
  onAddSymbolAlert?: (symbol: string) => void;
  /** TVP8 F-05: `Add SYMBOL to compare`, on the focused pane. */
  onAddSymbolCompare?: (symbol: string) => void;
  canOpenNewPane?: boolean;
  onSymbolsChanged: () => void;
  replayQuote: ReplayQuote | null;

  /** Real focused-pane state for the combined Objects / Data window panel. */
  objects: ObjectsDataPanelProps;

  onOpenAutomation: () => void;

  /** The focused pane's studies, or null while that pane is still mounting. */
  indicators: IndicatorsApi | null;
  /** The focused pane's built-in studies, listed beside its Pine studies. */
  nativeStudies: NativeStudiesApi | null;
  /** Open the Inputs/Style dialog for one built-in instance. */
  onEditNative: (key: string) => void;
  indicatorCount: number;
  indicatorFocusKey: string | null;
  onOpenInEditor: (script: PineScript) => void;
  onEditIndicator: (indicator: AppliedIndicator) => void;

  /** Where the order ticket points — NOT necessarily the focused pane. */
  tradingSymbol: string;
  tradingLastPrice: number | null;
  tradingNotice: string | null;
  onTicketStagedChange: (staged: boolean) => void;
  onManualState: (state: ManualTradingState | null) => void;

  maLines: { type: MaType; length: number; visible: boolean }[];
  maValues: Record<string, number | null>;
  maAlerts: MaAlert[];
  onToggleMa: (type: MaType, length: number) => void;
  onToggleAllMa: (visible: boolean) => void;
  onArmMa: (type: MaType, length: number) => void;
  onArmPrice: () => void;
  onArmLevel: (kind: "sr_zone" | "pivot_level") => void;
  onArmOscillator: (kind: IndicatorKind) => void;
  onOpenAlert: (alert: MaAlert) => void;
  onToast: (message: string) => void;

  toolsOpen: boolean;
  onToolsOpen: (open: boolean) => void;
  /** Existing focused-pane actions exposed to phone users without hover. */
  onMaximizeFocused?: () => void;
}

export function ChartSidePanel(props: ChartSidePanelProps): ReactNode {
  /** The rail's Help cell owns its own sheet; nothing above it has to. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const isMobile = useIsMobile();
  const tradingIdentity = canonicalDisplayParts(props.tradingSymbol);
  const canonicalBinanceSpot = tradingIdentity?.venue === "BINANCE" && tradingIdentity.type === "spot";
  /*
   * ── TVP8 R7-08: this rail is 46px, and the left one is 52 ─────────────────
   *
   * Measured on the reference at 1440x900: the drawing rail on the left is
   * 52px on a 52px pitch; the panel rail on the right is 46px on a 46px pitch,
   * with a 36x36 painted chip and 28px glyphs that are FULL INK at rest, not
   * muted. TVP7 made the two rails identical on the reasonable-sounding theory
   * that one workstation has one rail grammar. The reference disagrees, and it
   * is right to: the left rail is a tool palette you hold a pointer over all
   * day, the right one is six destinations. Ours was 52px wide on a 38px pitch
   * with 26px glyphs at stroke 1.8 — wider, tighter and heavier than the thing
   * it was copying, all at once.
   *
   * The chip is 36x36 through a rail-scoped `::before` inset, declared on the
   * column below rather than on every button.
   */
  /*
   * R1c-06: the cell is 45 wide, not 46.
   *
   * The rail COLUMN is still 46px of layout — but 1px of it is the hairline
   * that separates it from the watchlist (see the column below), so the
   * painted cells are 45. Measured on `tradingview/tv-shell-1920x1080-dark.png`
   * counted from the right edge: rail 1875–1919, a 1px rgb(46) line at 1874,
   * panel 1574–1873. At 1440 the same runs are 1395–1439 / 1394 / 1094–1393.
   */
  const railBtn = (isActive: boolean): string =>
    `tvc-control flex h-[46px] w-[45px] items-center justify-center ${
      isActive ? "text-ink" : "text-ink hover:text-ink"
    }`;

  /** A count on a rail cell, in the reference's badge grammar. */
  const RailBadge = ({ count }: { count: number }): ReactNode => (
    /* R7-08: a count badge, in the reference's own grammar — a small red
       numeric dot at the chip's corner. It used to be an accent pill, which
       put the product's selection colour on a control whose state it was not
       describing. Red is not a warning here; it is the badge colour the
       reference uses for a count on a rail cell. */
    <span className="pointer-events-none absolute right-[3px] top-[3px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-down px-[3px] text-[9px] font-semibold leading-none text-white">
      {count}
    </span>
  );

  /** Phone drawers are mutually exclusive — two overlays at once hides the chart. */
  const togglePanel = (p: ChartPanel): void => {
    setMoreOpen(false);
    props.onToolsOpen(false);
    props.onPanel((cur) => (cur === p ? null : p));
  };

  return (
    <>
    {props.panel && (
      <>
        {/* Phone: dim the chart and let a tap outside dismiss the drawer. */}
        <button
          aria-label="Close panel"
          onClick={props.onClosePanel}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
        {/*
          R1c-06 / R7b-05: the panel's right edge MEETS the rail.

          The workspace row lays its regions out with a 4px `gap`, which is
          right for the chart→panel gutter and wrong for the panel→rail seam:
          the reference separates those two with a 1px rgb(46) line, not with
          a band of page ground. `-mr-1` cancels the gap for exactly the
          docked column, and the rail's own `border-l` draws the line. The
          4px the chart column gets back is what moves its right edge from
          1085 to 1089 and the panel's content from 296px to the reference's
          300.
        */}
        <div role="region" aria-label={`${props.panel} panel`}
          className="fixed bottom-[52px] left-0 top-0 z-40 w-screen md:static md:bottom-auto md:left-auto md:right-auto md:z-auto md:-mr-1 md:h-auto md:w-auto">
          {props.panel === "watchlist" && (
            <Watchlist symbols={props.symbols} selected={props.symbol}
              onSelect={props.onSelectSymbol}
              onSymbolsChanged={props.onSymbolsChanged} replayQuote={props.replayQuote}
              onOpenInNewPane={props.onOpenSymbolInNewPane}
              onAddAlert={props.onAddSymbolAlert}
              onAddCompare={props.onAddSymbolCompare}
              canOpenNewPane={props.canOpenNewPane ?? false}
              replayActive={props.replayActive}
              /* R7-14: the gutter grip closes the panel. The rail cell still
                 toggles it, so `sidePanelDefault`'s preference test is
                 unaffected — this is a second way to the same state. */
              onHide={props.onClosePanel} />
          )}
          {props.panel === "correlation" && (
            /*
             * The watchlist's own instruments, in the watchlist's own order.
             *
             * The table's subject is the list the user is watching, so it takes
             * that list rather than a second one to curate. Its window is bars,
             * not minutes, so it means the same thing at every resolution the
             * focused pane can be on.
             */
            <CorrelationPanel
              symbols={props.symbols.map((s) => s.symbol)}
              interval={props.interval}
              bars={props.bars}
              selected={props.symbol}
              onSelect={props.onSelectSymbol}
            />
          )}
          {props.panel === "alerts" && !props.replayActive
    && <AlertsPanel onCreateAlert={props.onOpenAutomation} />}
          {props.panel === "objects" && <ObjectsDataPanel {...props.objects} />}
          {props.panel === "indicators" && (
            props.indicators ? (
              <IndicatorsPanel
                indicators={props.indicators}
                nativeStudies={props.nativeStudies}
                onEditNative={props.onEditNative}
                onOpenInEditor={props.onOpenInEditor}
                onEditIndicator={props.onEditIndicator}
                focusKey={props.indicatorFocusKey}
              />
            ) : (
              <aside className="flex h-full w-[85vw] max-w-[300px] shrink-0 items-center justify-center bg-surface p-4 text-xs text-ink-faint md:w-[300px]">
                Preparing this pane&apos;s studies…
              </aside>
            )
          )}
          {props.panel === "manual" && !props.replayActive && (isCanonicalInstrumentId(props.tradingSymbol)
            && !canonicalBinanceSpot
            ? <WorkstationOrderTicket instrument={props.tradingSymbol} />
            : <ManualTradingPanel symbol={tradingIdentity
                ? `${tradingIdentity.base}${tradingIdentity.quote}`
                : props.tradingSymbol}
                lastPrice={props.tradingLastPrice}
                targetNotice={props.tradingNotice}
                onStagedChange={props.onTicketStagedChange}
                onClose={props.onClosePanel}
                onStateChange={props.onManualState} />)}
          {props.panel === "ma" && (
            <aside className="flex h-full w-[85vw] max-w-[300px] shrink-0 flex-col bg-surface md:w-[300px]">
              <MaPanel
                lines={props.maLines}
                values={props.maValues}
                alerts={props.replayActive ? [] : props.maAlerts}
                timeframe={props.interval}
                onToggle={props.onToggleMa}
                onToggleAll={props.onToggleAllMa}
                onArm={props.onArmMa}
                onArmPrice={props.onArmPrice}
                onArmLevel={props.onArmLevel}
                onArmOscillator={props.onArmOscillator}
                // Clicking an armed alert opens THAT alert, not a fresh
                // dialog for its family. Re-opening the create dialog was
                // pre-filled by family only, so a user editing "RSI 14 > 70"
                // was silently handed a blank RSI 50 > 50 form.
                onOpenAlert={props.onOpenAlert}
                liveActionsDisabled={props.replayBlocksLiveActions}
                push={<PushSetup onMessage={props.onToast} />}
              />
            </aside>
          )}
        </div>
      </>
    )}

    {/* ── far-right icon rail (TV-style) ── */}
    {/*
      TVP8 R1-13: 6px of top padding, so this column's first PAINTED chip
      starts at y=48 — under the toolbar row, not level with it. The rail used
      to sit in the toolbar band (`py-1`, first cell at y=4) with its selected
      chip reading as part of the bar; the reference starts BOTH rail columns
      below the toolbar, and the toolbar row is 38px tall.

      `data-side-rail` is not decoration: `globals.css` scopes this rail's chip
      inset to it, the way `[data-drawing-rail]` scopes the left one's. Without
      the attribute a 46px cell would paint a 42px chip instead of D-04's
      centred 36x36 chip.

      TVP8 R7b-12: `pt-[6px]` → `pt-[1px]`. The reference's first rail chip is
      at y=47–84; six pixels of padding plus the chip's own 4px inset put ours
      at 52–89, five low, and every glyph centre below it inherited the same
      five. The column starts at y=42 (a 38px toolbar over the row's 4px
      gutter), so 1px of padding lands the first CELL at 43 and its chip at 47.

      R1c-06: 46px of layout, 45px of paint. The last pixel is the `border-l`
      hairline the reference draws between the watchlist and this rail, in
      place of the 4px gutter the workspace `gap` would otherwise put there.
    */}
    {!isMobile && <div data-side-rail="true"
      className="hidden w-[46px] shrink-0 flex-col items-center border-l border-border bg-surface pb-1 pt-[1px] md:flex">
      <button
        onClick={() => props.onPanel((p) => (p === "watchlist" ? null : "watchlist"))}
        className={railBtn(props.panel === "watchlist")}
        title="Watchlist"
        aria-label="Watchlist"
        aria-pressed={props.panel === "watchlist"}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
          <path d="M5 7h18M5 14h18M5 21h12" />
        </svg>
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "alerts" ? null : "alerts"))}
        disabled={props.replayBlocksLiveActions}
        className={railBtn(props.panel === "alerts")}
        title={props.replayBlocksLiveActions ? "Exit Replay to manage live automation" : "Automations — running strategies and their order log"}
        aria-label={props.replayBlocksLiveActions ? "Exit Replay to manage live automation" : "Automations"}
        aria-pressed={props.panel === "alerts"}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
          <circle cx="14" cy="15" r="8" /><path d="M14 11v4l3 2M6 5 3 3M22 5l-3 3" />
        </svg>
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "objects" ? null : "objects"))}
        className={railBtn(props.panel === "objects")}
        title="Object tree and Data window"
        aria-label="Object tree and Data window"
        aria-pressed={props.panel === "objects"}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
          <path d="M7 6h6v5H7zM15 17h6v5h-6zM7 17h6v5H7zM10 11v3h8v3M10 14v3" />
        </svg>
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "indicators" ? null : "indicators"))}
        className={railBtn(props.panel === "indicators")}
        title="Indicators"
        aria-label="Indicators"
        aria-pressed={props.panel === "indicators"}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
          <path d="M4 20l6-8 5 5 4-6 5 8" /><path d="M4 23h20" />
        </svg>
        {props.indicatorCount > 0 && <RailBadge count={props.indicatorCount} />}
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "ma" ? null : "ma"))}
        className={railBtn(props.panel === "ma")}
        title="Moving averages and the alerts armed on them"
        aria-label="Moving averages"
        aria-pressed={props.panel === "ma"}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
          <path d="M3 18c4-9 8 4 12-5s7 3 10-4" />
        </svg>
        {props.maAlerts.length > 0 && <RailBadge count={props.maAlerts.length} />}
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "correlation" ? null : "correlation"))}
        className={railBtn(props.panel === "correlation")}
        title="Correlation — how the watchlist's instruments move together"
        aria-label="Correlation"
        aria-pressed={props.panel === "correlation"}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
          <rect x="4" y="4" width="20" height="20" rx="1.5" />
          <path d="M11 4v20M18 4v20M4 11h20M4 18h20" />
        </svg>
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "manual" ? null : "manual"))}
        disabled={props.replayBlocksLiveActions}
        className={railBtn(props.panel === "manual")}
        title={props.replayBlocksLiveActions ? "Exit Replay to trade" : "Paper / demo / testnet order ticket"}
        aria-label={props.replayBlocksLiveActions ? "Exit Replay to trade" : "Paper / demo / testnet order ticket"}
        aria-pressed={props.panel === "manual"}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
          <path d="M5 8h18M8 14h12M10 20h8" /><path d="m20 5 3 3-3 3M8 17l-3 3 3 3" />
        </svg>
      </button>

      {/*
        The reference's bottom-anchored group. Six cells there, one here: the
        rule TVP8 keeps is that a rail cell is a DESTINATION THAT EXISTS, so
        the column ends where the product does rather than being padded out to
        the reference's count with glyphs that open nothing.

        No `aria-pressed`: this opens a sheet, not a panel, and
        `sidePanelDefault`'s `openPanel()` reads the rail by that attribute.
      */}
      <div className="mt-auto flex w-full flex-col items-center">
        <div aria-hidden="true" className="mb-1 h-px w-[30px] bg-border-strong" />
        <button
          onClick={() => setShortcutsOpen(true)}
          className={railBtn(false)}
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
        >
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1">
            <circle cx="14" cy="14" r="10" />
            <path d="M11.2 11a3 3 0 1 1 4 2.9v1.7M15 20h.01" />
          </svg>
        </button>
      </div>
    </div>}
    <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

    {/* ── phone action bar (TradingView keeps its controls at the thumb) ── */}
    {/*
      `data-phone-nav` is not decoration: the floating theme toggle is fixed to
      the same corner, and globals.css uses this attribute to lift it clear of
      the bar. Both read `--ts-phone-nav-height`, so the two cannot drift.
    */}
    {moreOpen && isMobile && (
      <div role="menu" aria-label="More chart tools"
        className="tvc-menu fixed inset-x-2 bottom-[var(--ts-phone-nav-height)] z-40 p-1">
        <button role="menuitem" className="tvc-menu-row flex min-h-[44px] w-full items-center px-3 text-left text-sm text-ink"
          onClick={() => { togglePanel("correlation"); setMoreOpen(false); }}>
          Correlation
        </button>
        <button role="menuitem" className="tvc-menu-row flex min-h-[44px] w-full items-center px-3 text-left text-sm text-ink"
          onClick={() => { togglePanel("objects"); setMoreOpen(false); }}>
          Object tree and Data window
        </button>
        {props.onMaximizeFocused && (
          <button role="menuitem" className="tvc-menu-row flex min-h-[44px] w-full items-center px-3 text-left text-sm text-ink"
            onClick={() => { props.onMaximizeFocused?.(); setMoreOpen(false); }}>
            Maximize focused pane
          </button>
        )}
      </div>
    )}
    <nav data-phone-nav
      className="fixed inset-x-0 bottom-0 z-30 flex min-h-[var(--ts-phone-nav-height)] items-stretch justify-around border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      {([
        ["tools", "Draw", props.toolsOpen, () => { setMoreOpen(false); props.onToolsOpen(!props.toolsOpen); props.onClosePanel(); },
          <path d="M4 20l4-1 9-9-3-3-9 9zM15 5l3 3 2-2-3-3z" />],
        ["watchlist", "Watchlist", props.panel === "watchlist", () => togglePanel("watchlist"),
          <path d="M4 7h16M4 12h16M4 17h10" />],
        ["ma", "MAs", props.panel === "ma", () => togglePanel("ma"),
          <path d="M3 15c3-7 6 3 9-4s6 2 9-3" />],
        ["indicators", "Studies", props.panel === "indicators", () => togglePanel("indicators"),
          <><path d="M3 17l5-6 4 4 3-4 6 6" /><path d="M3 20h18" /></>],
        ["alerts", "Automate", props.panel === "alerts", () => togglePanel("alerts"),
          <path d="M13 2L4 14h7l-1 8 9-12h-7z" />],
        ["more", "More", moreOpen, () => setMoreOpen((open) => !open),
          <><path d="M5 12h.01M12 12h.01M19 12h.01" /><path d="M4 5h16v14H4z" /></>],
      ] as const).map(([id, label, isActive, onClick, icon]) => (
        <button
          key={id}
          onClick={onClick}
          disabled={props.replayBlocksLiveActions && id === "alerts"}
          title={props.replayBlocksLiveActions && id === "alerts" ? "Exit Replay to manage live automation" : undefined}
          aria-label={label}
          aria-pressed={isActive}
          className={`relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] ${
            props.replayBlocksLiveActions && id === "alerts"
              ? "cursor-not-allowed text-ink-faint opacity-40"
              : isActive ? "font-medium text-ink" : "text-ink-muted"
          }`}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
          {label}
          {/* accent-is-meaning: a count badge — how many, not which one is open. */}
          {id === "ma" && props.maAlerts.length > 0 && (
            <span className="absolute right-1/4 top-0.5 rounded-full bg-accent px-1 text-[8px] font-semibold text-white">
              {props.maAlerts.length}
            </span>
          )}
        </button>
      ))}
    </nav>

    </>
  );
}
