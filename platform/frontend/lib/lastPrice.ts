/**
 * What "Last" means, stated once.
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 *
 * The workspace derived its Last price — the toolbar readout AND the value the
 * price-alert dialog prefills — from a page-level copy of the candle history.
 * That copy is loaded once and never receives live klines: only the PANE's
 * copy is fed by `mergeLiveBars`. So the number beside "Last", and the number
 * a user was about to arm an alert at, were the close of whatever bar the
 * history happened to end on when the page loaded. On a stale window (see
 * `lib/historyFreshness`) that could be hours old, presented with no
 * qualification at all.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * There are three sources, in strict precedence:
 *
 *   REPLAY   while Replay is active the only truthful price is the replayed
 *            bar's close. Live prices must never leak into a replayed session,
 *            so this outranks everything and no live frame can displace it.
 *
 *   LIVE     after a valid live frame for THIS symbol and interval, that frame
 *            is the market. It comes from the same kline feed the chart draws
 *            from — there is no second market-price store.
 *
 *   HISTORY  before any live frame, the newest stored close, marked as what it
 *            is. A fallback that says so is useful; one that passes for live
 *            is the defect.
 *
 * `source` exists so the UI can say which of the three it is showing, and so
 * the alert dialog can refuse to pretend a history close is a live price.
 */

export type LastPriceSource = "replay" | "live" | "history" | "none";

export interface LastPrice {
  price: number | null;
  source: LastPriceSource;
  /** True only for `live` — the one source that is the market right now. */
  live: boolean;
  /** The window this price came from is behind the interval grid. */
  stale: boolean;
}

export interface LastPriceInputs {
  /** Replay's visible bar close, or null when Replay is off. */
  replayClose?: number | null;
  /** Whether Replay is active at all — a Replay with no bar yet still bars live. */
  replayActive?: boolean;
  /** Newest live kline close for the dataset on screen, or null before one. */
  liveClose?: number | null;
  /** Newest stored close for the dataset on screen, or null. */
  historyClose?: number | null;
  /** The stored window is slots behind the grid. */
  historyStale?: boolean;
}

const NONE: LastPrice = { price: null, source: "none", live: false, stale: false };

function usable(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveLastPrice(inputs: LastPriceInputs): LastPrice {
  if (inputs.replayActive) {
    return usable(inputs.replayClose)
      ? { price: inputs.replayClose, source: "replay", live: false, stale: false }
      : NONE;
  }
  if (usable(inputs.liveClose)) {
    return { price: inputs.liveClose, source: "live", live: true, stale: false };
  }
  if (usable(inputs.historyClose)) {
    return {
      price: inputs.historyClose, source: "history", live: false,
      stale: inputs.historyStale === true,
    };
  }
  return NONE;
}

/** The toolbar's word for this price. Names the source rather than implying live. */
export function lastPriceLabel(resolved: LastPrice): string {
  switch (resolved.source) {
    case "replay": return "Replay";
    case "live": return "Last";
    case "history": return resolved.stale ? "Last stored" : "Last close";
    default: return "Last";
  }
}

/**
 * What to say about a price that is not live, or null when nothing is owed.
 *
 * Deliberately not a severity or a banner: this is the one sentence a readout
 * or an alert dialog needs so a number that is not the market cannot be read
 * as one.
 */
export function lastPriceNotice(resolved: LastPrice): string | null {
  if (resolved.source === "history") {
    return resolved.stale
      ? "No live frame yet, and the stored history is behind the market."
      : "No live frame yet — this is the newest stored close.";
  }
  return null;
}
