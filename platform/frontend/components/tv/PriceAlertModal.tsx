"use client";
import { useEffect, useState } from "react";
import { ResolutionNotice } from "@/components/tv/ResolutionNotice";
import { Modal } from "@/components/Modal";
import { Button, Dropdown, FIELD } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { AlertArmedField } from "@/components/tv/AlertArmedField";
import {
  AlertFiltersField, emptyFilters, filtersFromAlert, filterRequest, filterRequestForEdit,
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

const DIRECTION_LABELS: Record<PriceDirection, string> = {
  either: "Price reaches the level, from either side",
  cross_up: "Price crosses up through the level",
  cross_down: "Price crosses down through the level",
};

/*
 * What the runner actually evaluates, in the user's words.
 *
 * The three entries below are the three `PriceDirection` values the backend
 * has. A dialog that offered five — "Crossing", "Greater than", "Less than"
 * alongside the two cross directions — was offering two conditions that do not
 * exist and quietly folding them onto `either`, which is a different alert
 * from the one the label promised. The list and the semantics are the same
 * length for exactly that reason.
 */
const DIRECTION_HELP: Record<PriceDirection, string> = {
  either: "Fires as soon as the candle's range reaches the level — a wick is enough.",
  cross_up: "Fires when a candle closes above the level after closing below it.",
  cross_down: "Fires when a candle closes below the level after closing above it.",
};

/** The cooldown a fresh price alert opens with, named so the initial value
 *  and the reopen reset cannot drift apart. */
const DEFAULT_COOLDOWN_MIN = 60;

/*
 * `Row` and `Disclosure` are module-level because a component declared inside
 * a render is a new type on every render, and React unmounts and remounts a
 * changed type — which for a dialog whose first field is a number input means
 * losing the caret after each keystroke.
 */
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[110px_1fr] items-center gap-3">
    <span className="text-sm text-ink-muted">{label}</span>
    {children}
  </div>
);

const Disclosure = ({ label, value, open: expanded, onToggle, children }: {
  label: string; value?: string; open: boolean; onToggle: () => void; children?: React.ReactNode;
}) => (
  <div className="border-b border-border/70">
    <button type="button" onClick={onToggle} aria-expanded={expanded}
      className="flex min-h-8 w-full items-center justify-between py-1 text-left text-[13px] text-ink">
      <span>{label}</span>
      <span className="flex items-center gap-1 text-ink-muted"><span>{value}</span><span aria-hidden="true">{expanded ? "⌃" : "›"}</span></span>
    </button>
    {expanded && <div className="pb-2">{children}</div>}
  </div>
);

/**
 * Arm an alert on a price level.
 *
 * The level is pre-filled from wherever the user came from — the price they
 * clicked on the chart, or the last price — because the number they mean is
 * almost always the one already on screen, and retyping it is both friction and
 * an opportunity to fat-finger a decimal.
 */
export function PriceAlertModal({
  open, onClose, symbol, chartTimeframe, resolutionNotice = null, initialPrice, lastPrice,
  lastPriceNotice = null, existing,
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
  const [conditionOpen, setConditionOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

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
      /*
       * Editing goes through PATCH, not the upsert.
       *
       * The gates are part of what identifies an alert — two alerts differing
       * only in their gates are two alerts, deliberately. So an upsert whose
       * gates the user just changed no longer matches the row it came from and
       * would arm a SECOND alert beside it, leaving the original in place with
       * the old gates. `match` is found by the condition alone, which is
       * exactly the row the dialog is editing.
       */
      const body = {
        symbol, timeframe, conditionKind: "price" as const,
        targetPrice: target, priceDirection: direction, frequency, cooldownMin,
        note: note.trim() || null,
        enabled: armed,
      };
      const row = match
        ? await api.updateMaAlert(match.id, { ...body, ...filterRequestForEdit(filters) })
        : await api.createMaAlert({ ...body, ...filterRequest(filters) });
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2">Price alert <span className="text-accent">{displayTicker(symbol)}</span></span>}
      panelClassName="w-[480px] max-h-[500px]"
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
      <div className="space-y-1">
        {/*
          The alert source was a two-value control — Price, Studies — wired to
          `onChange={() => undefined}`. Studies alerts are a real family, armed
          from the indicator dialog under their own condition kinds; nothing in
          this dialog could ever have created one, and the option existed only
          to look like it could. This dialog creates `conditionKind: "price"`,
          which is what its title says.
        */}
        <Row label="Condition">
          <div className="grid gap-1.5">
            {/*
              The shared Dropdown, not a native select.
              
              The contract forbids a native `<select>` inside a dialog (§3), and
              the reason is visible the moment one is opened beside the others:
              the OS draws its own chevron and its own popup, at its own row
              height, in its own font. This dialog reverted to two of them while
              a truth repair was being made to it; the repair stays, the control
              goes back.
            */}
            <Dropdown
              value={direction}
              label="Alert condition"
              width={180}
              onChange={(v) => setDirection(v as PriceDirection)}
              options={(Object.keys(DIRECTION_LABELS) as PriceDirection[]).map((d) => (
                { value: d, label: DIRECTION_LABELS[d] }
              ))}
            />
            <div className="flex items-center gap-1.5">
              <input type="number" step="any" min="0" value={price} autoFocus onChange={(e) => setPrice(e.target.value)}
                aria-label="Alert price level" className={box} />
              <button type="button" onClick={onPickFromChart} title="Pick the level on the chart"
                className="h-8 shrink-0 rounded border border-border px-2 text-xs text-ink-muted hover:border-accent hover:text-ink">Pick</button>
            </div>
          </div>
        </Row>
        <p className="pl-[122px] text-xs text-ink-faint">{DIRECTION_HELP[direction]}</p>
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
          <p role="status" data-last-price-notice="true" className="pl-[122px] text-xs text-warn">{lastPriceNotice}</p>
        )}
        {impossible && (
          <p className="pl-[122px] text-xs text-down">
            Price is already {direction === "cross_up" ? "above" : "below"} this level. The alert
            will wait until price crosses back and then through it again.
          </p>
        )}

        <button type="button" aria-expanded={conditionOpen} onClick={() => setConditionOpen((v) => !v)}
          className="flex h-8 items-center gap-1 text-[13px] text-ink-muted hover:text-ink">＋ Add condition</button>
        {conditionOpen && <div className="pb-1"><AlertFiltersField value={filters} onChange={setFilters} /></div>}

        <ResolutionNotice notice={resolutionNotice} using={timeframe} />
        <Row label="Timeframe">
          <Dropdown
            value={timeframe}
            label="Alert timeframe"
            width={180}
            onChange={(v) => setTimeframe(v as Interval)}
            options={ALERT_INTERVAL_VALUES.map((tf) => ({
              value: tf,
              label: `${tf}${resolutionNotice === null && tf === chartTimeframe ? " — same as chart" : ""}`,
            }))}
          />
        </Row>

        {/*
          Frequency is the shared field, not a label that cycles through four
          words on click. What it fires on is a promise about what a
          notification MEANS, and the intrabar modes carry a warning the user
          has to be able to read before accepting them — a collapsed row that
          never opened could not show it.
        */}
        <div className="pt-1"><FrequencyField value={frequency} onChange={setFrequency} timeframe={timeframe} /></div>

        <Disclosure label="Message" value={note ? "Custom" : `${displayTicker(symbol)} alert`} open={messageOpen} onToggle={() => setMessageOpen((v) => !v)}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={240} rows={2}
            aria-label="Alert note" placeholder={`Write a message for ${displayTicker(symbol)}`} className={`w-full resize-none ${box}`} />
        </Disclosure>
        {/*
          Two checkboxes, "App notifications" and "Toasts", were both bound to
          `armed`: unticking either one paused the alert entirely. One piece of
          state gets one control, and the shared field is the one that says in
          words what each position means.
        */}
        <Disclosure label="Notifications" value={armed ? "Armed" : "Paused"} open={notificationsOpen} onToggle={() => setNotificationsOpen((v) => !v)}>
          <div className="space-y-1 pt-1">
            <AlertArmedField value={armed} onChange={setArmed} />
            <label className="flex items-center gap-2 text-[13px] text-ink-muted">Cooldown <input type="number" min="0" step="5" value={cooldownMin}
              aria-label="Cooldown in minutes" onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))} className="w-20 rounded border border-border bg-transparent px-2 py-1" /> min</label>
          </div>
        </Disclosure>

        {/* accent-is-meaning: this sentence changes what Save will do, so it is
            the dialog talking about its own primary action. */}
        {match && (
          <p className="pt-1 text-xs text-accent">
            This level already has a {timeframe} alert for that condition; saving updates it.
          </p>
        )}
        {err && <p className="text-sm text-down" role="alert" title={err.detail || undefined}>{err.headline}</p>}
      </div>
    </Modal>
  );
}
