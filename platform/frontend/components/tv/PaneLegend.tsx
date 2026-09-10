"use client";
/**
 * What a pane is, said on the chart rather than in a bar above it.
 *
 * ── The duplication this removes ───────────────────────────────────────────
 *
 * A pane used to open with a bordered header row carrying a symbol button and a
 * strip of six interval buttons. In a one-pane workspace that row sat directly
 * under a toolbar carrying a symbol button and a strip of six interval buttons:
 * the same two controls, twice, forty pixels apart, with the chart starting
 * below both. That is the "duplicated symbol/timeframe controls in one visual
 * layer too many" the owner reported, and it is not a matter of taste — it is
 * two live controls for one piece of state.
 *
 * ── What TradingView does, measured ────────────────────────────────────────
 *
 * The benchmark was captured live and cached under `evidence/P1A_tv/`. Its
 * header toolbar carries EXACTLY ONE symbol control and EXACTLY ONE interval
 * control, in one pane and in a 2-across layout alike; the interval control is
 * one button, never a strip. Each pane then names its own instrument and
 * interval INSIDE the chart canvas, at the top-left, as part of the series
 * legend — no border, no background band, no reserved height, and no strip of
 * alternatives. In a 1600×1000 window its chart occupies 89.1 % of the height,
 * with 42 px of chrome above it and nothing else.
 *
 * So the answer was not to delete the pane's own controls — a multi-chart
 * workspace needs them, and TradingView keeps them too. It was to stop
 * rendering them as a second toolbar. This is a legend: it floats over the
 * plot, it costs the chart no height, and it repeats no strip.
 *
 * ── Pointer events ─────────────────────────────────────────────────────────
 *
 * The container is `pointer-events-none` and each control turns them back on
 * for itself. The drawing layer listens on the plot underneath, and a legend
 * that swallowed a drag would break trend lines drawn near the top-left corner
 * — which is where most of them start.
 */
import { useCallback, useState } from "react";
import { fmtPrice } from "@/lib/format";
import { CompareControl } from "@/components/tv/CompareControl";
import { LegendTimeframe, type ResolutionPreferences } from "@/components/tv/TimeframePicker";
import type { Resolution } from "@/lib/resolution";
import type { PaneCompare } from "@/lib/workspace";
import { displaySymbol } from "@/lib/instrument";

export interface PaneLegendProps {
  paneId: string;
  symbol: string;
  interval: Resolution;
  /** Null until this pane's window has loaded. */
  lastClose: number | null;
  /** The loaded window is behind the market. */
  stale: boolean;
  /** The window for this pane is being replaced right now. */
  loading: boolean;
  /** How many bars this pane holds — a readout, not a trading fact. */
  bars: number;
  compare: PaneCompare | null;
  /**
   * Below this the legend drops the price and shows only the identity: a pane
   * in a 4×4 is a hundred pixels tall and a legend must not become the chart.
   */
  dense: boolean;

  onOpenSymbolSearch: (paneId: string) => void;
  onInterval: (paneId: string, interval: Resolution) => void;
  onCompareChange?: (paneId: string, next: PaneCompare | null) => void;
  resolutions: ResolutionPreferences;

  /** Both false in a one-pane workspace, where neither would mean anything. */
  canMaximize: boolean;
  canClose: boolean;
  maximized: boolean;
  onToggleMaximize: (paneId: string) => void;
  onClose: (paneId: string) => void;
}

/** Every legend control: reachable by pointer, invisible to the drawing layer. */
const HIT = "pointer-events-auto";

export function PaneLegend(props: PaneLegendProps) {
  const { paneId, symbol, interval, compare, dense } = props;
  const symbolLabel = displaySymbol(symbol);
  const [compareOpen, setCompareOpen] = useState(false);

  const pickInterval = useCallback((next: Resolution) => {
    props.onInterval(paneId, next);
  }, [props, paneId]);

  return (
    <>
      {/*
        Rendered INTO the chart's own legend column rather than beside it.

        `CandleChart` stacks its overlays — the synthetic-presentation
        disclosure, then the OHLC readout — in one flex column at the plot's
        top-left, with a comment warning that a second overlay pinned to a fixed
        offset gets drawn straight through it. That is exactly what happened the
        first time this legend was written as a sibling: "SOLUSDT 15m" from the
        pane painted over "SOLUSDT · 15m O … H … L …" from the chart. It is the
        same class of defect this whole phase is about, one layer down.

        So the identity is a slot in that column, and the OHLC row no longer
        repeats the symbol and the interval — the row above it names them, and
        that row is the control.
      */}
      <div
        data-pane-legend={paneId}
        className="pointer-events-none flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5"
      >
        <button
          {...{ className: `${HIT} flex h-5 shrink-0 items-center rounded px-1 text-xs font-semibold text-ink hover:bg-surface-2/80` }}
          onClick={() => props.onOpenSymbolSearch(paneId)}
          title={`Change this pane's symbol — currently ${symbolLabel} · ${props.bars.toLocaleString()} bars loaded`}
          aria-label={`Change symbol for the ${symbolLabel} pane`}
        >
          {symbolLabel}
        </button>

        {/*
          The pane's own timeframe, as ONE control.

          It opens the same picker the toolbar opens, reading the same
          favourites and writing the same recents — so a pane is genuinely
          autonomous without being a second, divergent implementation of the
          timeframe UI.
        */}
        <LegendTimeframe
          className={HIT}
          scope={paneId}
          interval={interval}
          onInterval={pickInterval}
          preferences={props.resolutions}
        />

        {/*
          The comparison, stated on the pane it belongs to.

          A chart whose price line is a percentage against a second instrument
          is a materially different chart; a reader must be able to see that at
          a glance and undo it in one click.
        */}
        <button
          {...{ className: `${HIT} flex h-5 shrink-0 items-center rounded px-1 text-[11px] ${
            compare ? "bg-surface-2/80 font-semibold text-ink" : "text-ink-faint hover:bg-surface-2/80 hover:text-ink"
          }` }}
          onClick={() => setCompareOpen(true)}
          title={compare
            ? `Comparing with ${compare.symbol} — ${compare.mode}`
            : "Compare this chart with another instrument"}
          aria-label={compare
            ? `Comparing with ${compare.symbol}. Change or remove.`
            : "Compare with another instrument"}
        >
          {compare ? `vs ${compare.symbol}` : "vs"}
        </button>

        {!dense && props.lastClose !== null && (
          <span
            className={`tabular text-[11px] ${props.stale ? "text-warn" : "text-ink-muted"}`}
            title={props.stale
              ? "This window is behind the market — the tail refresh could not reach the current bar."
              : undefined}
          >
            {fmtPrice(props.lastClose)}
          </span>
        )}
        {!dense && props.loading && (
          <span className="text-[11px] text-ink-faint"
            title={`${props.bars.toLocaleString()} bars loaded`}>
            loading…
          </span>
        )}
      </div>

      {/*
        Pane actions, top-right, revealed on hover or focus.

        Neither exists in a one-pane workspace — there is nothing to maximise
        away from and nothing left if it closes — so this whole cluster is
        absent rather than disabled there.
      */}
      {(props.canMaximize || props.canClose) && (
        <div className="pointer-events-none absolute right-2 top-1.5 z-30 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100">
          {props.canMaximize && (
            <button
              {...{ className: `${HIT} flex h-5 w-5 items-center justify-center rounded bg-surface/70 text-ink-faint hover:bg-surface-2 hover:text-ink` }}
              onClick={() => props.onToggleMaximize(paneId)}
              title={props.maximized ? "Restore the layout" : "Maximize this pane"}
              aria-label={props.maximized ? "Restore the layout" : "Maximize this pane"}
              aria-pressed={props.maximized}
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                strokeWidth="1.4" aria-hidden="true">
                {props.maximized
                  ? <path d="M4.5 1.5v3h-3M7.5 10.5v-3h3" />
                  : <path d="M1.5 4.5v-3h3M10.5 7.5v3h-3" />}
              </svg>
            </button>
          )}
          {props.canClose && (
            <button
              {...{ className: `${HIT} flex h-5 w-5 items-center justify-center rounded bg-surface/70 text-ink-faint hover:bg-surface-2 hover:text-ink` }}
              onClick={() => props.onClose(paneId)}
              title="Close this pane"
              aria-label={`Close the ${symbol} pane`}
            >
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          )}
        </div>
      )}

      <CompareControl
        open={compareOpen}
        current={compare}
        baseSymbol={symbol}
        onClose={() => setCompareOpen(false)}
        onApply={(next) => props.onCompareChange?.(paneId, next)}
      />
    </>
  );
}
