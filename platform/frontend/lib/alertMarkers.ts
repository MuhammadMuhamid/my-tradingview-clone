"use client";
/**
 * Alerts that actually fired, marked on the bar they fired on.
 *
 * ── Only what the server recorded ──────────────────────────────────────────
 *
 * Every mark here comes from `ma_alert_events` — a row the alert runner wrote
 * when it delivered. Nothing is derived from the chart's own bars, and nothing
 * is inferred by re-evaluating an alert's condition against history. That
 * distinction is the whole design: re-evaluating would produce marks on bars
 * where the alert *would have* fired, which is a different and much weaker
 * claim than "this fired", and it would put fabricated history on a chart the
 * user reads to decide what actually happened.
 *
 * The consequence is that an alert armed today shows no marks in the past, and
 * that is correct. `markerNotice` says so rather than leaving the absence to be
 * read as "this never triggered".
 *
 * ── Armed lines are unchanged ──────────────────────────────────────────────
 *
 * The horizontal lines a chart already draws for ARMED price alerts are a
 * different thing entirely — a level being watched, not an event that
 * happened — and this does not touch them.
 *
 * ── Notifications never trade ──────────────────────────────────────────────
 *
 * A marker is a record of a notification. Nothing here can place, stage or
 * prepare an order, and the shape of the data makes that structural rather
 * than a rule someone has to remember.
 */
import type { ChartMarker } from "@/components/CandleChart";
import type { MaAlert, MaAlertEvent } from "@/lib/api";
import { sameInstrument } from "@/lib/instrument";
import { INTERVAL_MS, type Candle, type Interval } from "@/lib/types";

/** One fired alert, placed on a bar of this chart. */
export interface PlacedAlertEvent {
  event: MaAlertEvent;
  /** The alert it belongs to, when this client still holds it. */
  alert: MaAlert | null;
  /** Bar open time in seconds. */
  time: number;
  /** How many events landed on this same bar. */
  stacked: number;
}

/**
 * Place fired events onto this chart's bars.
 *
 * Three filters, each of which prevents a specific wrong mark:
 *
 *   the alert must be for THIS instrument, or a BTCUSDT alert would appear on
 *     a SOLUSDT chart;
 *   it must be for THIS timeframe, or a 1h alert would be marked on a 1m chart
 *     at a bar it has no relationship to;
 *   its bar must exist in the loaded window, or the mark would be clamped onto
 *     an edge bar and claim an event happened there.
 *
 * Events are DEDUPED per alert per bar. A `once_per_bar` alert can deliver to
 * several devices and an intrabar frequency can fire repeatedly inside one
 * candle; marking each would stack a dozen arrows on one bar and say nothing
 * more than one arrow does. The count rides along so the label can say it.
 */
export function placeAlertEvents(
  events: readonly MaAlertEvent[],
  alerts: readonly MaAlert[],
  symbol: string,
  timeframe: Interval,
  candles: readonly Candle[]
): PlacedAlertEvent[] {
  if (candles.length === 0 || events.length === 0) return [];
  const byId = new Map(alerts.map((a) => [a.id, a]));
  const step = INTERVAL_MS[timeframe];
  const first = candles[0]!.openTime;
  const last = candles[candles.length - 1]!.openTime;

  const grouped = new Map<string, PlacedAlertEvent>();
  for (const event of events) {
    const alert = byId.get(event.alertId) ?? null;
    // An event whose alert this client no longer holds — deleted since it
    // fired — is still a real event, but it cannot be attributed to an
    // instrument, so it is not placed rather than being placed on a guess.
    if (!alert) continue;
    if (!sameInstrument(alert.symbol, symbol)) continue;
    if (alert.timeframe !== timeframe) continue;

    const barTime = new Date(event.barTime).getTime();
    if (!Number.isFinite(barTime)) continue;
    // Snap to this timeframe's grid: the event records the bar it fired on,
    // and an intrabar event records the bar that was forming.
    const openTime = Math.floor(barTime / step) * step;
    if (openTime < first || openTime > last) continue;

    const key = `${event.alertId}|${openTime}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.stacked += 1;
      // Keep the EARLIEST event on the bar: that is when the condition was
      // first true, which is the fact a reader is looking for.
      if (new Date(event.firedAt).getTime() < new Date(existing.event.firedAt).getTime()) {
        existing.event = event;
      }
      continue;
    }
    grouped.set(key, { event, alert, time: Math.floor(openTime / 1000), stacked: 1 });
  }
  return [...grouped.values()].sort((a, b) => a.time - b.time);
}

/**
 * Chart markers for placed events.
 *
 * Deliberately concise: the bar, the direction the alert was watching, and the
 * alert's own title. The full body is in the Alerts panel, and a chart marker
 * that carried it would cover the candles it is annotating.
 */
export function alertEventMarkers(placed: readonly PlacedAlertEvent[]): ChartMarker[] {
  return placed.map(({ event, alert, stacked }) => {
    const up = alert?.mode === "cross_up" || alert?.priceDirection === "cross_up";
    const down = alert?.mode === "cross_down" || alert?.priceDirection === "cross_down";
    return {
      time: Math.floor(new Date(event.barTime).getTime() / 1000),
      position: down ? "aboveBar" : "belowBar",
      color: up ? "#2ebd85" : down ? "#f6465d" : "#f0b90b",
      // "Alert" rather than a bell glyph: a dingbat renders as a different
      // symbol, or as nothing, depending on the font that resolves.
      text: stacked > 1 ? `Alert ×${stacked}` : "Alert",
      shape: up ? "arrowUp" : down ? "arrowDown" : "circle",
    };
  });
}

/**
 * What the reader is owed about these marks, or null.
 *
 * The absence of marks in the past is the thing most likely to be misread, so
 * it is the thing said out loud.
 */
export function markerNotice(
  placed: readonly PlacedAlertEvent[], armed: number
): string | null {
  if (armed === 0) return null;
  if (placed.length > 0) return null;
  return "No alert has fired on these bars. Marks appear only for alerts the " +
    "server actually delivered — nothing is reconstructed from history.";
}
