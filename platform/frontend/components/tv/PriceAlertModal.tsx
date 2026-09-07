"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { AlertNoteField } from "@/components/tv/AlertNoteField";
import {
  AlertFiltersField, emptyFilters, filtersFromAlert, filterRequest,
  
} from "@/components/tv/AlertFiltersField";
import {
  api, isBulkResult,
  type AlertFilter, DEFAULT_ALERT_FREQUENCY,
  type AlertFrequency, type MaAlert, type PriceDirection,
} from "@/lib/api";
import { describeAlert } from "@/lib/alerts";
import { fmtPrice } from "@/lib/format";
import type { Interval } from "@/lib/types";

/** Every timeframe the backend supports, in the order the toolbar shows them. */
const INTERVALS: Interval[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"];

const DIRECTION_LABELS: Record<PriceDirection, string> = {
  either: "Price reaches the level, from either side",
  cross_up: "Price crosses up through the level",
  cross_down: "Price crosses down through the level",
};

const DIRECTION_HELP: Record<PriceDirection, string> = {
  either: "Fires as soon as the candle's range reaches the level — a wick is enough.",
  cross_up: "Fires when a candle closes above the level after closing below it.",
  cross_down: "Fires when a candle closes below the level after closing above it.",
};

/**
 * Arm an alert on a price level.
 *
 * The level is pre-filled from wherever the user came from — the price they
 * clicked on the chart, or the last price — because the number they mean is
 * almost always the one already on screen, and retyping it is both friction and
 * an opportunity to fat-finger a decimal.
 */
export function PriceAlertModal({
  open, onClose, symbol, chartTimeframe, initialPrice, lastPrice, lastPriceNotice, existing,
  onPickFromChart, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  chartTimeframe: Interval;
  /** The clicked level, when the user picked one off the chart. */
  initialPrice: number | null;
  /** Latest close, used as the fallback level and to sanity-check direction. */
  lastPrice: number | null;
  /** Set when `lastPrice` is a stored close rather than a live frame. */
  lastPriceNotice?: string | null;
  /** Price alerts already armed on this symbol, so the dialog edits rather than duplicates. */
  existing: MaAlert[];
  /** Close and let the next chart click supply the level. */
  onPickFromChart: () => void;
  onSaved: (message: string) => void;
}) {
  const [price, setPrice] = useState("");
  const [direction, setDirection] = useState<PriceDirection>("either");
  const [timeframe, setTimeframe] = useState<Interval>(chartTimeframe);
  const [frequency, setFrequency] = useState<AlertFrequency>(DEFAULT_ALERT_FREQUENCY);
  const [filters, setFilters] = useState<AlertFilter[]>(emptyFilters);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reopening must not inherit the previous level, so everything the dialog
  // pre-fills is recomputed from the props it opened with.
  useEffect(() => {
    if (!open) return;
    const seed = initialPrice ?? lastPrice;
    setPrice(seed === null ? "" : String(Number(seed.toPrecision(8))));
    setTimeframe(chartTimeframe);
    setFilters(emptyFilters());
    setNote("");
    setErr(null);
  }, [open, initialPrice, lastPrice, chartTimeframe]);

  const target = Number(price);
  const valid = Number.isFinite(target) && target > 0;

  // Editing rather than creating: an alert on the same level and direction.
  const match = existing.find(
    (a) => a.targetPrice === target && a.priceDirection === direction && a.timeframe === timeframe
  ) ?? null;

  useEffect(() => {
    if (!match) return;
    setFrequency(match.frequency);
    // Saving upserts onto the matched row, so the dialog must show what that
    // row holds — otherwise an untouched Update strips its gates and its note.
    setFilters(filtersFromAlert(match));
    setNote(match.note ?? "");
  }, [match?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A cross alert armed on the wrong side of the current price can never fire
   * until price first travels back through the level. Saying so up front is
   * better than a notification that never arrives.
   */
  const impossible =
    valid && lastPrice !== null &&
    ((direction === "cross_up" && lastPrice > target) ||
     (direction === "cross_down" && lastPrice < target));

  const save = async () => {
    if (!valid) { setErr("Enter a price above zero."); return; }
    setBusy(true);
    setErr(null);
    try {
      const row = await api.createMaAlert({
        symbol, timeframe, conditionKind: "price",
        targetPrice: target, priceDirection: direction, frequency,
        ...filterRequest(filters),
        note: note.trim() || null,
      });
      // A price alert is always one symbol — the bulk shape cannot occur here,
      // and offering it would arm forty coins on a level true of one.
      if (isBulkResult(row)) throw new Error("unexpected bulk response for a price alert");
      onSaved(`${match ? "Updated" : "Alert set"} — ${symbol} ${timeframe} · ${describeAlert(row)}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!match) return;
    setBusy(true);
    try {
      await api.deleteMaAlert(match.id);
      onSaved(`Alert removed — ${symbol} ${fmtPrice(match.targetPrice)}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const box = "w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent";
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[110px_1fr] items-center gap-3">
      <span className="text-sm text-ink-muted">{label}</span>
      {children}
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2">Price alert <span className="text-accent">{symbol}</span></span>}
      footer={
        <>
          {match && <Button onClick={remove} disabled={busy} className="mr-auto text-down">Delete</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !valid}>
            {busy ? "Saving…" : match ? "Update" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Row label="Price">
          <div className="flex items-center gap-2">
            <input
              type="number" step="any" min="0" value={price} autoFocus
              onChange={(e) => setPrice(e.target.value)}
              aria-label="Alert price level"
              className={box}
            />
            <button
              type="button"
              onClick={onPickFromChart}
              title="Close this and click the level on the chart"
              className="shrink-0 whitespace-nowrap rounded-md border border-border px-2.5 py-2 text-xs text-ink-muted hover:border-accent hover:text-ink"
            >
              Pick on chart
            </button>
          </div>
        </Row>
        {lastPrice !== null && (
          <p className="pl-[122px] text-xs text-ink-faint">
            Last price {fmtPrice(lastPrice)}
            {valid && ` · ${(((target - lastPrice) / lastPrice) * 100).toFixed(2)}% away`}
          </p>
        )}
        {/*
          A prefill taken from stored history is not the market. Saying so is
          the difference between a helpful default and a number the operator
          arms an alert at believing it is current.
        */}
        {lastPrice !== null && lastPriceNotice && (
          <p className="pl-[122px] text-xs text-warn">{lastPriceNotice}</p>
        )}

        <Row label="Condition">
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as PriceDirection)}
            aria-label="Alert condition"
            className={box}
          >
            {(Object.keys(DIRECTION_LABELS) as PriceDirection[]).map((d) => (
              <option key={d} value={d}>{DIRECTION_LABELS[d]}</option>
            ))}
          </select>
        </Row>
        <p className="pl-[122px] text-xs text-ink-faint">{DIRECTION_HELP[direction]}</p>
        {impossible && (
          <p className="pl-[122px] text-xs text-down">
            Price is already {direction === "cross_up" ? "above" : "below"} this level. The alert
            will wait until price crosses back and then through it again.
          </p>
        )}

        <Row label="Timeframe">
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as Interval)}
            aria-label="Alert timeframe"
            className={box}
          >
            {INTERVALS.map((tf) => (
              <option key={tf} value={tf}>{tf}{tf === chartTimeframe ? " — same as chart" : ""}</option>
            ))}
          </select>
        </Row>

        <div className="my-1 border-t border-border" />
        <AlertFiltersField value={filters} onChange={setFilters} chartTimeframe={timeframe} />

        <div className="my-1 border-t border-border" />
        <AlertNoteField value={note} onChange={setNote} />

        <div className="my-1 border-t border-border" />
        <FrequencyField value={frequency} onChange={setFrequency} timeframe={timeframe} />

        {match && (
          <p className="text-xs text-accent">
            This level already has a {timeframe} alert for that condition; saving updates it.
          </p>
        )}
        {err && <p className="text-sm text-down" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}
