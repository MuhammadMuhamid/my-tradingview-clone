"use client";
/**
 * The workspace's bottom drawer: Positions & Orders, the Strategy Tester and
 * the Pine Editor.
 *
 * Positions & Orders is the trader-state area — what the account holds and
 * what is in flight, read-only, from the same Bot-authoritative read the
 * ticket makes. It is the first tab because it is the one a trader looks at
 * after ordering; the tester and the editor are research tools. On an install
 * where that read fails before it has ever succeeded — manual trading not
 * enabled here, which is the normal case, or the Bot unreachable — the drawer
 * opens on the Strategy Tester instead, so the first thing under the chart is
 * not a permanent "unavailable" notice. The tab stays where the user puts it.
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
import { useCallback, useEffect, useRef, useState } from "react";
import { recall, remember } from "@/lib/browserStorage";
import { type Resolution } from "@/lib/resolution";
import { PineEditor } from "@/components/tv/PineEditor";
import { StrategyTester } from "@/components/tv/StrategyTester";
import { TradingStateStrip, tradingStateFreshness } from "@/components/tv/TradingStateStrip";
import type { StrategyProperties } from "@/components/tv/StrategySettingsModal";
import type { PineParams } from "@/lib/indicators";
import type { ManualTradingState, PineScript } from "@/lib/api";
import type { OpenTrade, Strategy, StrategyParams, Trade } from "@/lib/types";

/**
 * Bottom-panel preference key. Phones and desktops store it separately so one
 * form factor's choice never dictates the other's opening layout.
 */
const bottomKey = (): string =>
  typeof window !== "undefined" && window.innerWidth < 768
    ? "tv.bottomCollapsed.mobile"
    : "tv.bottomCollapsed";

/*
 * ── TVP8: the panel's height ───────────────────────────────────────────────
 *
 * Every body in here was a hard-coded height — `h-[380px]` for the editor,
 * `h-[180px]` for the tester's notice — and the panel could only be collapsed
 * or not. The reference's bottom panel drags from its top edge and has a
 * maximize chevron beside the collapse one, and both matter here for the same
 * reason they matter there: the Pine editor at 380px shows about eighteen
 * lines, and reading a strategy test means giving it the screen for a minute
 * and then giving it back.
 */
const HEIGHT_KEY = "tv.bottomHeight";
const MIN_HEIGHT = 140;
const DEFAULT_HEIGHT = 380;
/** Never take the whole window: the chart must stay legible behind it. */
const MAX_HEIGHT_FRACTION = 0.8;

function storedHeight(): number {
  try {
    const raw = recall(HEIGHT_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= MIN_HEIGHT ? parsed : DEFAULT_HEIGHT;
  } catch { return DEFAULT_HEIGHT; }
}

export interface ChartBottomPanelProps {
  /** The focused pane's instrument and resolution. */
  symbol: string;
  interval: Resolution;
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
  /** When `manualState` was last read successfully; null until a first read. */
  manualReadAt: number | null;
  manualUnavailable: string | null;
  /** The instrument the ticket points at (the focused pane, unless pinned). */
  tradingSymbol: string;
  onOpenTicket: () => void;
}

export type BottomTab = "trading" | "tester" | "pine";

export function ChartBottomPanel(props: ChartBottomPanelProps) {
  const [tab, setTab] = useState<BottomTab>("trading");
  /** Collapsed to just its tab strip, so the chart gets the full height. */
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  /** The height to restore to when maximize is turned off. */
  const [restoreHeight, setRestoreHeight] = useState<number | null>(null);
  const maximized = restoreHeight !== null;
  /** Once the user has picked a tab, no default moves it. */
  const userChoseTab = useRef(false);

  /*
   * The default tab is decided once the first read has an answer. A failure
   * before any success ("unavailable": no state, only a reason) means
   * Positions & Orders would be a notice and nothing else, so the drawer
   * moves to the nearest working tab. Once a read has succeeded the tab can
   * function, even if a later read fails — the strip then says the state is
   * retained. It never moves back on its own: a tab changing under a user is
   * worse than one click.
   */
  const { manualState, manualUnavailable } = props;
  useEffect(() => {
    if (userChoseTab.current || tradingStateFreshness(manualState, manualUnavailable) !== "unavailable") return;
    setTab((current) => (current === "trading" ? "tester" : current));
  }, [manualState, manualUnavailable]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = recall(bottomKey());
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
  useEffect(() => { setHeight(storedHeight()); }, []);

  /*
   * Drag the top edge. Pointer events rather than mouse, so this works on a
   * tablet — the same gap `DrawingCanvas` had.
   */
  const dragFrom = useRef<{ y: number; height: number } | null>(null);
  const onResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragFrom.current = { y: event.clientY, height };
    setRestoreHeight(null);   // dragging is an explicit height; un-maximize
  }, [height]);

  const onResizeMove = useCallback((event: React.PointerEvent) => {
    const from = dragFrom.current;
    if (!from) return;
    // Dragging UP makes it taller, which is why the delta is inverted.
    const next = Math.round(from.height + (from.y - event.clientY));
    const cap = Math.round(window.innerHeight * MAX_HEIGHT_FRACTION);
    setHeight(Math.max(MIN_HEIGHT, Math.min(cap, next)));
  }, []);

  const onResizeEnd = useCallback(() => {
    if (!dragFrom.current) return;
    dragFrom.current = null;
    remember(HEIGHT_KEY, String(height));
  }, [height]);

  const toggleMaximized = useCallback(() => {
    setCollapsed(false);
    setRestoreHeight((current) => {
      if (current !== null) { setHeight(current); return null; }
      const kept = height;
      setHeight(Math.round(window.innerHeight * MAX_HEIGHT_FRACTION));
      return kept;
    });
  }, [height]);

  const toggleBottom = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      remember(bottomKey(), next ? "1" : "0");
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
      {/*
        TVP8: the drag handle, on the panel's own top edge as the reference
        has it. `separator` with an orientation and a value is what makes it
        legible to a screen reader and operable from the keyboard; a bare
        `cursor-ns-resize` div is neither.
      */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the bottom panel"
          aria-valuenow={height}
          aria-valuemin={MIN_HEIGHT}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 80 : 16;
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const cap = Math.round(window.innerHeight * MAX_HEIGHT_FRACTION);
            setRestoreHeight(null);
            setHeight((current) => {
              const next = Math.max(MIN_HEIGHT,
                Math.min(cap, current + (e.key === "ArrowUp" ? step : -step)));
              remember(HEIGHT_KEY, String(next));
              return next;
            });
          }}
          className="h-1.5 cursor-ns-resize bg-transparent transition-colors hover:bg-state-active focus-visible:bg-state-active"
        />
      )}
      <div role="tablist" aria-label="Bottom workstation"
        className="flex items-center gap-1 border-b border-border px-2">
        {([["trading", "Positions & Orders"], ["tester", "Strategy Tester"], ["pine", "Pine Editor"]] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            /*
             * TVP7: `role="tab"` and `aria-selected`, and the workstation's own
             * selected chip instead of an accent-blue underline. The two INNER
             * strips in this panel (the tester's result tabs, the trading
             * strip's sub-tabs) already carried tab semantics; the outermost
             * ones — the only three a user meets on load — carried none.
             *
             * This used to end "and were the last accent-blue selection in the
             * shell". They were not: the tester's result tabs, the strategy
             * dialog's tabs and the order-type tabs all kept an accent
             * underline for another two waves, because the rule that was
             * supposed to catch them only matched a ternary written on one
             * line. All three are on this chip now.
             */
            aria-selected={tab === id && !collapsed}
            onClick={() => {
              userChoseTab.current = true;
              // Clicking the active tab while collapsed reopens it, which
              // is what a collapsed tab strip invites you to do.
              if (tab === id) toggleBottom();
              else {
                setTab(id);
                setCollapsed(false);
                remember(bottomKey(), "0");
              }
            }}
            // 22px measured on a phone. The tab strip is also the handle
            // that brings a collapsed panel back, so it has to be pressable
            // with a thumb, not only clickable with a pointer.
            className={`tvc-control flex min-h-[32px] items-center px-2 text-[13px] font-medium ${
              tab === id && !collapsed ? "text-ink" : "text-ink-muted hover:text-ink"
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
          {/* TVP8: maximize, beside collapse, as the reference pairs them. */}
          {!collapsed && (
            <button
              onClick={toggleMaximized}
              title={maximized ? "Restore panel" : "Maximize panel"}
              aria-label={maximized ? "Restore panel" : "Maximize panel"}
              aria-pressed={maximized}
              className="flex h-7 w-7 items-center justify-center rounded text-ink-faint hover:bg-state-hover hover:text-ink"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                {maximized
                  ? <><path d="M5 12h14" /><path d="M9 8l3-3 3 3" /></>
                  : <><path d="M5 12h14" /><path d="M9 6l3-3 3 3" /><path d="M9 18l3 3 3-3" /></>}
              </svg>
            </button>
          )}
          <button
            onClick={toggleBottom}
            title={collapsed ? "Expand panel" : "Minimize panel"}
            aria-label={collapsed ? "Expand panel" : "Minimize panel"}
            // 20x20 measured below the 24x24 minimum a pointer target
            // needs, and it is the control that hides the panel covering
            // the chart — the one a phone user reaches for most.
            className="flex h-7 w-7 items-center justify-center rounded text-ink-faint hover:bg-state-hover hover:text-ink"
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
          readAt={props.manualReadAt}
          symbol={props.tradingSymbol}
          onOpenTicket={props.onOpenTicket}
          unavailable={props.manualUnavailable}
        />
      ) : tab === "tester" && props.replayActive ? (
        <div style={{ height: Math.min(height, 180) }}
          className="flex items-center justify-center px-6 text-center text-sm text-ink-muted">
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
        // TVP8: the dragged height, not a literal 380.
        <div style={{ height }}>
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
