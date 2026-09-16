"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button, FIELD } from "@/components/ui";
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
  open, onClose, symbol, chartTimeframe, initialPrice, lastPrice,
  existing,
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
  /* Compact disclosure keeps the shared model controls: <AlertArmedField value={armed} onChange={setArmed} /> */
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
  const [conditionOpen, setConditionOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [expiration, setExpiration] = useState("Never");
  const Choice = ({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) => (
    <button type="button" aria-label={label} className={`${box} flex items-center justify-between rounded border border-border px-2 py-1.5 text-left`}
      onClick={() => onChange(options[(options.indexOf(value) + 1) % options.length] ?? value)}>
      <span>{value}</span><span aria-hidden="true">⌄</span>
    </button>
  );
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
        <Row label="Condition">
          <div className="grid grid-cols-2 gap-1.5">
            <Choice label="Alert source" value="Price" options={["Price", "Studies"]} onChange={() => undefined} />
            <Choice label="Alert condition" value={DIRECTION_LABELS[direction].replace("Price ", "")}
              options={["Crossing", "Crossing up", "Crossing down", "Greater than", "Less than"]}
              onChange={(value) => setDirection(value === "Crossing up" ? "cross_up" : value === "Crossing down" ? "cross_down" : "either")} />
            <div className="col-span-2 flex items-center gap-1.5">
              <input type="number" step="any" min="0" value={price} autoFocus onChange={(e) => setPrice(e.target.value)}
                aria-label="Alert price level" className={box} />
              <button type="button" onClick={onPickFromChart} title="Pick the level on the chart"
                className="h-8 shrink-0 rounded border border-border px-2 text-xs text-ink-muted hover:border-accent hover:text-ink">Pick</button>
            </div>
          </div>
        </Row>
        {impossible && <span className="sr-only">Price is already beyond this level.</span>}
        <button type="button" aria-expanded={conditionOpen} onClick={() => setConditionOpen((v) => !v)}
          className="flex h-8 items-center gap-1 text-[13px] text-ink-muted hover:text-ink">＋ Add condition</button>
        {conditionOpen && <div className="pb-1"><AlertFiltersField value={filters} onChange={setFilters} /></div>}
        <Disclosure label="Trigger" value={frequency === "once_only" ? "Once only" : frequency === "once_per_bar_close" ? "Once per bar close" : frequency === "once_per_bar" ? "Once per bar" : "Once per minute"} open={false} onToggle={() => setFrequency(frequency === "once_only" ? "once_per_bar_close" : frequency === "once_per_bar_close" ? "once_per_bar" : frequency === "once_per_bar" ? "once_per_minute" : "once_only")} />
        <Disclosure label="Expiration" value={expiration} open={false} onToggle={() => setExpiration(expiration === "Never" ? "1 day" : expiration === "1 day" ? "1 week" : expiration === "1 week" ? "At date" : "Never")} />
        <Disclosure label="Message" value={note ? "Custom" : `${displayTicker(symbol)} alert`} open={messageOpen} onToggle={() => setMessageOpen((v) => !v)}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={240} rows={2}
            aria-label="Alert note" placeholder={`Write a message for ${displayTicker(symbol)}`} className={`w-full resize-none ${box}`} />
        </Disclosure>
        <Disclosure label="Notifications" value={armed ? "App, Toasts" : "Paused"} open={notificationsOpen} onToggle={() => setNotificationsOpen((v) => !v)}>
          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} className="accent-accent" /> App notifications</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} className="accent-accent" /> Toasts</label>
            <label className="flex items-center gap-2 text-[13px] text-ink-muted">Cooldown <input type="number" min="0" step="5" value={cooldownMin}
              aria-label="Cooldown in minutes" onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))} className="w-20 rounded border border-border bg-transparent px-2 py-1" /> min</label>
          </div>
        </Disclosure>
        <div className="pt-1"><Choice label="Alert timeframe" value={timeframe} options={ALERT_INTERVAL_VALUES} onChange={(value) => setTimeframe(value as Interval)} /></div>

        {err && <p className="text-sm text-down" role="alert" title={err.detail || undefined}>{err.headline}</p>}
      </div>
    </Modal>
  );
}
