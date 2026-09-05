"use client";
/**
 * The live price of one dataset, from the feed the chart already draws from.
 *
 * ── Why this is not another store ──────────────────────────────────────────
 *
 * `lib/marketFeed` is the tab's one kline authority: one socket per
 * `SYMBOL|interval`, however many consumers attach to it. This attaches one
 * more listener to the SAME subscription the pane is already using, so the
 * workspace's Last price and the pane's candles are fed by the identical
 * frames and cannot disagree. Nothing new is opened, nothing is polled, and
 * there is no second market-price cache to go stale on its own.
 *
 * ── Cross-dataset safety ───────────────────────────────────────────────────
 *
 * The price is cleared the instant the requested symbol or interval changes,
 * before any frame for the new one has arrived. A price is only ever recorded
 * from a frame whose own symbol and interval match what this hook was asked
 * for, so the last instrument's price can neither survive the switch nor be
 * written by a straggling frame from the feed being detached.
 *
 * A feed that drops or goes silent clears the price too: a quote is only as
 * current as the socket that delivered it, which is the rule
 * `lib/useBookQuote` already holds itself to.
 */
import { useEffect, useState } from "react";
import { marketFeed, type FeedState, type KlineTick } from "./marketFeed";
import { datasetKey } from "./liveDataset";
import type { Interval } from "./types";

export interface LivePriceState {
  /** Newest live close for this dataset, or null before a valid frame. */
  price: number | null;
  /** Exchange event time of the frame that carried it. */
  at: number | null;
  /** Open time of the bar that frame belongs to. */
  openTime: number | null;
}

const EMPTY: LivePriceState = { price: null, at: null, openTime: null };

export function useLivePrice(
  symbol: string, interval: Interval, options: { enabled?: boolean } = {}
): LivePriceState {
  const enabled = options.enabled !== false;
  const [state, setState] = useState<LivePriceState>(EMPTY);

  useEffect(() => {
    // Switching instrument invalidates the previous price immediately. Showing
    // the last symbol's price under this symbol's name is the whole defect.
    setState(EMPTY);
    if (!enabled || !symbol || typeof window === "undefined") return;
    const wanted = datasetKey({ symbol, interval });
    return marketFeed.subscribe(symbol, interval, {
      onTick: (tick: KlineTick) => {
        // A frame is only news about the dataset it names.
        if (datasetKey(tick) !== wanted) return;
        if (!Number.isFinite(tick.close) || tick.close <= 0) return;
        setState({ price: tick.close, at: tick.closeTime, openTime: tick.openTime });
      },
      onStatus: (_status, feed: FeedState) => {
        // Reconnecting or silent: what we hold is no longer the market.
        if (feed.status === "reconnecting" || feed.status === "stale") setState(EMPTY);
      },
    });
  }, [symbol, interval, enabled]);

  return state;
}
