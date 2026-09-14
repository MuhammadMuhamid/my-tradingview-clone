"use client";
import { useEffect, useState } from "react";
import { ResolutionNotice } from "@/components/tv/ResolutionNotice";
import { Modal } from "@/components/Modal";
import { Button, FIELD } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { AlertNoteField } from "@/components/tv/AlertNoteField";
import { AlertArmedField } from "@/components/tv/AlertArmedField";
import {
  AlertFiltersField, emptyFilters, filtersFromAlert, filterRequest,
  type AlertFilterState,
} from "@/components/tv/AlertFiltersField";
import {
  api, DEFAULT_ALERT_FREQUENCY,
  type AlertFrequency, type MaAlert, type PriceDirection,
} from "@/lib/api";
import { describeAlert } from "@/lib/alerts";
import { fmtPrice } from "@/lib/format";
import { ALERT_INTERVAL_VALUES, type Interval } from "@/lib/types";
import { displayTicker } from "@/lib/instrument";
import { describeAction, said, type FailureCopy } from "@/lib/errorCopy";

/** Every timeframe the backend supports, in the order the toolbar shows them. */


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
/** The cooldown a fresh price alert opens with, named so the initial value
 *  and the reopen reset cannot drift apart. */
const DEFAULT_COOLDOWN_MIN = 60;

export function PriceAlertModal({
  open, onClose, symbol, chartTimeframe, resolutionNotice = null, initialPrice, lastPrice,
  lastPriceNotice, existing,
  onPickFromChart, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  chartTimeframe: Interval;
  /**
   * Why the chart's own resolution is not this alert's timeframe, or null.
   * Built by `ChartDialogs` from `nativeOnlyNotice`.
   */
  resolutionNotice?: string | null;
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
  const [filters, setFilters] = useState<AlertFilterState>(emptyFilters);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(true);
  const [cooldownMin, setCooldownMin] = useState(DEFAULT_COOLDOWN_MIN);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FailureCopy | null>(null);

  /*
   * Reopening must not inherit the previous level, so everything the dialog
   * pre-fills is recomputed from the props it opened with.
   *
   * "Everything" once meant five of eight: `frequency`, `armed` and
   * `cooldownMin` were left behind, so an unticked Armed or an edited cooldown
   * carried into the next, unrelated alert the user created. The comment was
   * exactly the kind of stated invariant a later reader trusts instead of
   * re-checking the list, which is how it stayed wrong.
   */
  useEffect(() => {
    if (!open) return;
    const seed = initialPrice ?? lastPrice;
    setPrice(seed === null ? "" : String(Number(seed.toPrecision(8))));
    setTimeframe(chartTimeframe);
    setFilters(emptyFilters());
    setNote("");
    setFrequency(DEFAULT_ALERT_FREQUENCY);
    setArmed(true);
    setCooldownMin(DEFAULT_COOLDOWN_MIN);
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
    /*
     * Saving upserts onto the matched row, so the dialog must show what that
     * row holds — otherwise an untouched Update strips its gates and its note.
     *
     * `enabled` and `cooldownMin` belong in that list and were missing. The
     * consequence was worse than a stale field: opening a PAUSED alert showed
     * "Armed ☑ — starts watching as soon as it is saved", and pressing the
     * button labelled Update re-armed it. A control that misreports live state
     * and then mutates it on an untouched save is worse than the missing
     * control this one was added to be.
     */
    setArmed(match.enabled);
    setCooldownMin(match.cooldownMin);
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
    if (!valid) { setErr(said("Enter a price above zero.")); return; }
    setBusy(true);
    setErr(null);
    try {
      const row = await api.createMaAlert({
        symbol, timeframe, conditionKind: "price",
        targetPrice: target, priceDirection: direction, frequency, cooldownMin,
        ...filterRequest(filters),
        note: note.trim() || null,
        enabled: armed,
      });
      onSaved(`${match ? "Updated" : "Alert set"} — ${displayTicker(symbol)} ${timeframe} · ${describeAlert(row)}`);
      onClose();
    } catch (e) {
      setErr(describeAction(e, "arm the alert"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!match) return;
    setBusy(true);
    try {
      await api.deleteMaAlert(match.id);
      onSaved(`Alert removed — ${displayTicker(symbol)} ${fmtPrice(match.targetPrice)}`);
      onClose();
    } catch (e) {
      setErr(describeAction(e, "arm the alert"));
    } finally {
      setBusy(false);
    }
  };

  const box = `w-full ${FIELD}`;
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
      title={<span className="flex items-center gap-2">Price alert <span className="text-accent">{displayTicker(symbol)}</span></span>}
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

        <ResolutionNotice notice={resolutionNotice} using={timeframe} />
        <Row label="Timeframe">
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as Interval)}
            aria-label="Alert timeframe"
            className={box}
          >
            {ALERT_INTERVAL_VALUES.map((tf) => (
              <option key={tf} value={tf}>{tf}{resolutionNotice === null && tf === chartTimeframe ? " — same as chart" : ""}</option>
            ))}
          </select>
        </Row>

        <div className="my-1 border-t border-border" />
        <AlertFiltersField value={filters} onChange={setFilters} />

        <div className="my-1 border-t border-border" />
        <AlertNoteField value={note} onChange={setNote} />

        <AlertArmedField value={armed} onChange={setArmed} />

        <div className="my-1 border-t border-border" />
        <FrequencyField value={frequency} onChange={setFrequency} timeframe={timeframe} />

        {/*
          Cooldown, which this dialog alone did not offer.
          Level, MA and indicator alerts have all had it; a price alert is the
          one most likely to sit on a level that price chops through, so the
          family that needed it most was the family without it. The server has
          always accepted `cooldownMin` on creation.
        */}
        <Row label="Cooldown">
          <div className="flex items-center gap-2">
            <input type="number" min="0" step="5" value={cooldownMin}
              aria-label="Cooldown in minutes"
              onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))} className={box} />
            <span className="whitespace-nowrap text-sm text-ink-muted">minutes</span>
          </div>
        </Row>

        {/* accent-is-meaning: this sentence changes what Save will do, so it is
            the dialog talking about its own primary action. */}
        {match && (
          <p className="text-xs text-accent">
            This level already has a {timeframe} alert for that condition; saving updates it.
          </p>
        )}
        {err && <p className="text-sm text-down" role="alert" title={err.detail || undefined}>{err.headline}</p>}
      </div>
    </Modal>
  );
}
