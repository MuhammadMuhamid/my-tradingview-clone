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
import { useCallback, useEffect, useState } from "react";
import { fmtPrice } from "@/lib/format";
import { LegendTimeframe, type ResolutionPreferences } from "@/components/tv/TimeframePicker";
import type { Resolution } from "@/lib/resolution";
import type { PaneCompare } from "@/lib/workspace";
import {
  displayDescription, displayName, displaySymbol, displayTicker, displayVenue,
  legacyBinanceSpotTicker,
} from "@/lib/instrument";
import {
  FLAG_COLOURS, FLAGS_CHANGED_EVENT, flagHex, readFlags, setFlag, type FlagColour,
} from "@/lib/watchlistFlags";
import type { StatusTitleForm } from "@/lib/chartSettings";
import { DerivativeIdentity } from "@/components/tv/DerivativeIdentity";
import { EquityIdentity } from "@/components/tv/EquityIdentity";
import { TraditionalIdentity } from "@/components/tv/TraditionalIdentity";

export interface PaneLegendProps {
  paneId: string;
  symbol: string;
  interval: Resolution;
  /** Null until this pane's window has loaded. */
  lastClose: number | null;
  /** The loaded window is behind the market. */
  stale: boolean;
  /** The chart's own OHLC row is showing, so this legend need not repeat `C`. */
  ohlcVisible: boolean;
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
  /**
   * Which form of the instrument's name the headline carries (R6 SL-2).
   *
   * ── R3b-25: the three forms the reference offers ──────────────────────────
   *
   * TradingView's `Title` dropdown is `Name` / `Ticker` / `Description`, and
   * this offered `Name` / `Full symbol` — where `Full symbol` rendered
   * `BINANCE:BTC/USDT · SPOT`, a form the reference does not have and which
   * §5 keeps out of primary copy in the first place. So the stored value
   * `symbol` now resolves to the TICKER (`BTCUSDT`), which is what the
   * reference's second option prints; the key is unchanged, so a workspace
   * that stored it keeps working and simply stops printing the qualified id.
   * `description` is the third, and resolves to `displayName` until
   * `lib/instrument` knows a longer description — the same string, never a
   * canonical id.
   *
   * ── Why `ticker` draws `displayName` and not `displayTicker` ─────────────
   *
   * The reference's `Title` dropdown reads `Name`, and TVP8 R3-14 already made
   * this headline the NAME: `Solana / TetherUS · 15m · Binance`, with the
   * listing code left to the toolbar pill where the control grammar belongs.
   * `tests/dom/shellDensity.test.tsx` pins that, and the contract's own rule
   * is that current intent wins over an older reading. So the default value —
   * still keyed `ticker` because that is what a workspace has stored — renders
   * what the chart drew before this control existed, and `symbol` is the
   * opt-in to the qualified form. `displayName` can never answer with a
   * canonical `instrument:v1:…` id, which is the rule §5 exists for.
   */
  titleForm?: StatusTitleForm;

  onOpenSymbolSearch: (paneId: string) => void;
  onInterval: (paneId: string, interval: Resolution) => void;
  onOpenCompareSettings?: () => void;
  /**
   * E6: the series' own `More`, opened at the button.
   *
   * On the reference this is the chart's context menu — the same rows a
   * right-click on the plot offers — anchored under the control. So it is
   * handed the anchor and nothing else; the menu is the chart's.
   */
  onOpenSeriesMenu?: (at: { x: number; y: number }) => void;
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
  /*
   * TVP7. The legend led with `BINANCE:BTC/USDT · SPOT` — a venue, a
   * colon, a pair and an asset-class word, before any price. TradingView's
   * status line is `Bitcoin / TetherUS · 4h · Binance`: the
   * instrument first, then the context, in descending weight.
   *
   * So the button is the ticker, the venue trails it in muted type beside the
   * interval, and the qualified identity — which is the thing a support
   * request needs — is the control's tooltip and accessible name. The asset
   * class keeps its own badge (`DerivativeIdentity` and friends below), which
   * says more than the word SPOT did and is Trading Scene's own.
   */
  const symbolLabel = displaySymbol(symbol);
  const tickerLabel = displayTicker(symbol);
  /*
   * TVP8 R3-14: the headline says what the instrument IS.
   *
   * The reference's status line opens `Bitcoin / TetherUS · 1h · Binance` at
   * 16px/400. This opened `BTCUSDT` at 14px/600 — the CONTROL grammar, which
   * belongs on the toolbar pill and in a watchlist row, promoted to the
   * chart's headline and set heavier than the price beside it. `displayName`
   * answers with the descriptive name where this installation genuinely knows
   * one and with the ticker where it does not; it can never answer with a
   * canonical `instrument:v1:…` id, which is the rule §5 exists for. The
   * ticker stays the accessible name and the tooltip, so nothing that was
   * findable before stops being findable.
   */
  const nameLabel = displayName(symbol);
  /*
   * R6 SL-2: the dialog's `Title` row chooses between them.
   *
   * `nameLabel` above is still what the descriptive form resolves to and is
   * kept for the tooltip, where a reader who wants "Solana / TetherUS" can
   * still find it.
   */
  const titleLabel = props.titleForm === "symbol"
    ? tickerLabel
    : props.titleForm === "description"
      ? displayDescription(symbol)
      : nameLabel;
  const venueLabel = displayVenue(symbol);
  /*
   * R4b-06: the chip that SAYS a comparison is on opens how it is DRAWN.
   *
   * Choosing the instrument is the symbol search in compare mode (the `+`
   * control's job); changing the mode or the window, or taking the comparison
   * off, is a small menu on the chip that announces it. Two decisions, two
   * surfaces, neither of them a form with a regex in it.
   */
  const pickInterval = useCallback((next: Resolution) => {
    props.onInterval(paneId, next);
  }, [props, paneId]);
  /*
   * E6: `Flag symbol`, the same marking the watchlist row sets.
   *
   * Keyed exactly as the watchlist keys it (the listing ticker where there is
   * one), so flagging BTCUSDT here puts the stub on its watchlist row and the
   * row's `Unflag` clears this. Read after mount — storage does not exist on
   * the server render — and again whenever any surface writes a flag.
   */
  const flagSymbol = legacyBinanceSpotTicker(symbol) ?? symbol;
  const [flag, setFlagState] = useState<FlagColour | null>(null);
  useEffect(() => {
    const sync = (): void => setFlagState(readFlags()[flagSymbol] ?? null);
    sync();
    window.addEventListener(FLAGS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(FLAGS_CHANGED_EVENT, sync);
  }, [flagSymbol]);
  const flagFill = flagHex(flag);

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
        className="pointer-events-none group/series flex max-w-full flex-wrap items-center gap-x-[5px] gap-y-0.5"
      >
        <button
          {...{ className: `${HIT} tvc-control -mx-1 flex h-6 shrink-0 items-center rounded-md px-1 !text-[16px] leading-6 text-ink` }}
          onClick={() => props.onOpenSymbolSearch(paneId)}
          title={`Change this pane's symbol — currently ${tickerLabel} (${nameLabel}, ${symbolLabel}) · ${props.bars.toLocaleString()} bars loaded`}
          aria-label={`Change symbol for the ${symbolLabel} pane`}
        >
          {titleLabel}
        </button>

        <DerivativeIdentity symbol={symbol} dense={dense} />
        <EquityIdentity symbol={symbol} dense={dense} />
        <TraditionalIdentity symbol={symbol} dense={dense} />

        {/*
          The pane's own timeframe, as ONE control.

          It opens the same picker the toolbar opens, reading the same
          favourites and writing the same recents — so a pane is genuinely
          autonomous without being a second, divergent implementation of the
          timeframe UI.
        */}
        {!dense && <span aria-hidden="true" className="shrink-0 text-[16px] text-ink">&middot;</span>}
        {/*
          R3-14: the interval reads as TEXT, at the headline's own size.

          It was an 11px/600 pill with a chevron — a second control shouting
          beside the first, where the reference has `· 1h ·` in the same
          16px/400 as the name. It is still the click target and still opens
          the same picker; `TimeframePicker` owns the button's own classes, so
          the size, the weight and the chevron are corrected from here rather
          than by forking a second timeframe control.
        */}
        <LegendTimeframe
          className={`${HIT} [&>button]:h-6 [&>button]:!text-[16px] [&>button]:font-normal
            [&>button]:!px-0 [&>button]:text-ink [&>button>svg]:hidden`}
          scope={paneId}
          interval={interval}
          onInterval={pickInterval}
          preferences={props.resolutions}
        />

        {venueLabel && !dense && (
          <span className="shrink-0 text-[16px] text-ink" title={symbolLabel}>
            &middot; {venueLabel}
          </span>
        )}

        {/*
          ── E6: the series' hover cluster — `Flag symbol` and `More` ─────────

          The reference reveals 28x22 actions after the venue when the pointer
          is on the series' title, exactly as a study row does; this row
          revealed nothing. Zero-width at rest, like the study cluster (E3), so
          the resting line is unchanged; still focusable, so `focus-within`
          opens it for the keyboard.
        */}
        {!dense && (
          <span data-series-actions=""
            className="flex w-0 shrink-0 items-center overflow-hidden opacity-0 transition-opacity
              focus-within:w-auto focus-within:opacity-100
              group-hover/series:w-auto group-hover/series:opacity-100">
            <button
              type="button"
              {...{ className: `${HIT} flex h-[22px] w-7 items-center justify-center rounded-sm border border-transparent text-ink-faint transition-colors hover:border-border hover:text-ink` }}
              aria-label={flag ? `Unflag ${tickerLabel}` : `Flag ${tickerLabel}`}
              aria-pressed={flag !== null}
              onClick={() => { setFlag(readFlags(), flagSymbol, flag ? null : FLAG_COLOURS[0].id); }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 21V4M6 4.5h11l-2.2 3.8L17 12H6"
                  fill={flagFill ?? "none"} stroke={flagFill ?? "currentColor"} />
              </svg>
            </button>
            {props.onOpenSeriesMenu && (
              <button
                type="button"
                {...{ className: `${HIT} flex h-[22px] w-7 items-center justify-center rounded-sm border border-transparent text-ink-faint transition-colors hover:border-border hover:text-ink` }}
                aria-label={`More for ${tickerLabel}`}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  props.onOpenSeriesMenu?.({ x: Math.round(box.left), y: Math.round(box.bottom + 4) });
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.6" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                  <circle cx="19" cy="12" r="1.6" fill="currentColor" />
                </svg>
              </button>
            )}
          </span>
        )}

        {/*
          The comparison, stated on the pane it belongs to.

          A chart whose price line is a percentage against a second instrument
          is a materially different chart; a reader must be able to see that at
          a glance and undo it in one click.
        */}
        {/*
          TVP7: the comparison states itself only when there IS one.
          A bare lowercase "vs" sat permanently in the status line as the way
          IN to the comparison dialog — two letters of chrome, on the densest
          shared surface there is, saying nothing about the chart. The way in
          is now the toolbar's Compare control, which is where TradingView puts
          it; this stays as the removable chip that says a comparison is on,
          because a chart whose line is a percentage against another instrument
          must say so at a glance.
        */}
        {compare && (
          <button
            {...{ className: `${HIT} tvc-control flex h-5 shrink-0 items-center px-1 text-[11px] font-semibold text-ink` }}
            onClick={props.onOpenCompareSettings}
            title={`Comparing with ${displayTicker(compare.symbol)} — ${compare.mode}`}
            aria-label={`Comparing with ${displayTicker(compare.symbol)}. Change or remove.`}
          >
            vs {displayTicker(compare.symbol)}
          </button>
        )}

        {/*
          The last close, only when the OHLC row below is not already showing
          it as `C`. It was printed unconditionally, so the default chart said
          the same number twice, forty pixels apart.
        */}
        {!dense && !props.ohlcVisible && props.lastClose !== null && (
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
              {...{ className: `${HIT} tvc-control flex h-5 w-5 items-center justify-center rounded-md bg-surface/70 text-ink-faint hover:text-ink` }}
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
              {...{ className: `${HIT} tvc-control flex h-5 w-5 items-center justify-center rounded-md bg-surface/70 text-ink-faint hover:text-ink` }}
              onClick={() => props.onClose(paneId)}
              title="Close this pane"
              aria-label={`Close the ${displaySymbol(symbol)} pane`}
            >
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          )}
        </div>
      )}

    </>
  );
}
