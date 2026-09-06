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
import type { ReactNode } from "react";
import { type Resolution } from "@/lib/resolution";
import { allNavLinks, PRODUCT_NAME } from "@/lib/navigation";
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

export type ChartPanel =
  | "watchlist" | "alerts" | "indicators" | "ma" | "manual" | "correlation" | null;

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
  canOpenNewPane?: boolean;
  onSymbolsChanged: () => void;
  replayQuote: ReplayQuote | null;

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
  navOpen: boolean;
  onCloseNav: () => void;
}

export function ChartSidePanel(props: ChartSidePanelProps): ReactNode {
  const railBtn = (isActive: boolean): string =>
    `flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
      isActive ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
    }`;

  /** Phone drawers are mutually exclusive — two overlays at once hides the chart. */
  const togglePanel = (p: ChartPanel): void => {
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
        <div className="fixed bottom-[52px] right-0 top-0 z-40 md:static md:bottom-auto md:right-auto md:z-auto md:h-auto">
          {props.panel === "watchlist" && (
            <Watchlist symbols={props.symbols} selected={props.symbol}
              onSelect={props.onSelectSymbol}
              onSymbolsChanged={props.onSymbolsChanged} replayQuote={props.replayQuote}
              onOpenInNewPane={props.onOpenSymbolInNewPane}
              onAddAlert={props.onAddSymbolAlert}
              canOpenNewPane={props.canOpenNewPane ?? false}
              replayActive={props.replayActive} />
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
              <aside className="flex h-full w-[85vw] max-w-[300px] shrink-0 items-center justify-center border-l border-border bg-surface p-4 text-xs text-ink-faint md:w-[300px]">
                Preparing this pane&apos;s studies…
              </aside>
            )
          )}
          {props.panel === "manual" && !props.replayActive && <ManualTradingPanel symbol={props.tradingSymbol}
            lastPrice={props.tradingLastPrice}
            targetNotice={props.tradingNotice}
            onStagedChange={props.onTicketStagedChange}
            onClose={props.onClosePanel}
            onStateChange={props.onManualState} />}
          {props.panel === "ma" && (
            <aside className="flex h-full w-[85vw] max-w-[300px] shrink-0 flex-col border-l border-border bg-surface md:w-[300px]">
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
    <div className="hidden w-12 shrink-0 flex-col items-center gap-1 border-l border-border bg-surface py-2 md:flex">
      <button
        onClick={() => props.onPanel((p) => (p === "watchlist" ? null : "watchlist"))}
        className={railBtn(props.panel === "watchlist")}
        title="Watchlist"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "manual" ? null : "manual"))}
        disabled={props.replayBlocksLiveActions}
        className={railBtn(props.panel === "manual")}
        title={props.replayBlocksLiveActions ? "Exit Replay to trade" : "Manual Binance Spot trading"}
        aria-label={props.replayBlocksLiveActions ? "Exit Replay to trade" : "Manual Binance Spot trading"}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M4 7h16M7 12h10M9 17h6" /><path d="M17 4l3 3-3 3M7 14l-3 3 3 3" />
        </svg>
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "indicators" ? null : "indicators"))}
        className={railBtn(props.panel === "indicators")}
        title="Indicators"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M3 17l5-6 4 4 3-4 6 6" /><path d="M3 20h18" />
        </svg>
        {props.indicatorCount > 0 && (
          <span className="absolute ml-6 -mt-4 rounded-full bg-accent px-1 text-[9px] font-semibold text-white">
            {props.indicatorCount}
          </span>
        )}
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "ma" ? null : "ma"))}
        className={railBtn(props.panel === "ma")}
        title="Moving averages and the alerts armed on them"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M3 15c3-7 6 3 9-4s6 2 9-3" />
        </svg>
        {props.maAlerts.length > 0 && (
          <span className="absolute ml-6 -mt-4 rounded-full bg-accent px-1 text-[9px] font-semibold text-white">
            {props.maAlerts.length}
          </span>
        )}
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "correlation" ? null : "correlation"))}
        className={railBtn(props.panel === "correlation")}
        title="Correlation — how the watchlist's instruments move together"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
          <path d="M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17" />
        </svg>
      </button>
      <button
        onClick={() => props.onPanel((p) => (p === "alerts" ? null : "alerts"))}
        disabled={props.replayBlocksLiveActions}
        className={railBtn(props.panel === "alerts")}
        title={props.replayBlocksLiveActions ? "Exit Replay to manage live automation" : "Automations — running strategies and their order log"}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="12" cy="13" r="7" /><path d="M12 10v3l2 2M5 4L3 6M19 4l2 2" />
        </svg>
      </button>
    </div>

    {/* ── phone action bar (TradingView keeps its controls at the thumb) ── */}
    <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      {([
        ["tools", "Draw", props.toolsOpen, () => { props.onToolsOpen(!props.toolsOpen); props.onClosePanel(); },
          <path d="M4 20l4-1 9-9-3-3-9 9zM15 5l3 3 2-2-3-3z" />],
        ["watchlist", "Watchlist", props.panel === "watchlist", () => togglePanel("watchlist"),
          <path d="M4 7h16M4 12h16M4 17h10" />],
        ["ma", "MAs", props.panel === "ma", () => togglePanel("ma"),
          <path d="M3 15c3-7 6 3 9-4s6 2 9-3" />],
        ["indicators", "Studies", props.panel === "indicators", () => togglePanel("indicators"),
          <><path d="M3 17l5-6 4 4 3-4 6 6" /><path d="M3 20h18" /></>],
        ["alerts", "Automate", props.panel === "alerts", () => togglePanel("alerts"),
          <path d="M13 2L4 14h7l-1 8 9-12h-7z" />],
      ] as const).map(([id, label, isActive, onClick, icon]) => (
        <button
          key={id}
          onClick={onClick}
          disabled={props.replayBlocksLiveActions && id === "alerts"}
          title={props.replayBlocksLiveActions && id === "alerts" ? "Exit Replay to manage live automation" : undefined}
          className={`relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] ${
            props.replayBlocksLiveActions && id === "alerts"
              ? "cursor-not-allowed text-ink-faint opacity-40"
              : isActive ? "text-accent" : "text-ink-muted"
          }`}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
          {label}
          {id === "ma" && props.maAlerts.length > 0 && (
            <span className="absolute right-1/4 top-0.5 rounded-full bg-accent px-1 text-[8px] font-semibold text-white">
              {props.maAlerts.length}
            </span>
          )}
        </button>
      ))}
    </nav>

    {/* Site navigation, reachable from the phone toolbar's ☰ */}
    {props.navOpen && (
      <>
        <button aria-label="Close menu" onClick={props.onCloseNav}
          className="fixed inset-0 z-40 bg-black/60 md:hidden" />
        <div className="fixed left-0 top-0 z-50 flex h-full w-64 flex-col border-r border-border bg-surface p-3 md:hidden">
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className="inline-block h-2 w-2 rounded-full bg-accent" />{PRODUCT_NAME}
            </span>
            <button onClick={props.onCloseNav} aria-label="Close"
              className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4l16 16M20 4L4 20" />
              </svg>
            </button>
          </div>
          {allNavLinks().map(({ href, label }) => (
            <a key={href} href={href}
              className="rounded-md px-3 py-2 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink">
              {label}
            </a>
          ))}
          <button
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
              window.location.href = "/login";
            }}
            className="mt-auto rounded-md px-3 py-2 text-left text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </>
    )}    </>
  );
}
