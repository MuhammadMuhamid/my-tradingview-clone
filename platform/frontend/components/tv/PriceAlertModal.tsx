"use client";
import { useEffect, useRef, useState } from "react";
import { useAsk } from "@/components/AskDialog";
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

/** A quote or a picked level as the field shows it: eight significant digits. */
const seedText = (level: number): string => String(Number(level.toPrecision(8)));

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
 * The PATCH-shaped description of a price alert, so an edit can be compared
 * field by field against what the dialog opened with.
 */
export type PriceDraft = {
  targetPrice: number; priceDirection: PriceDirection; timeframe: Interval;
  frequency: AlertFrequency; cooldownMin: number; note: string | null; enabled: boolean;
  filters: AlertFilterState;
};

/**
 * What a persisted price alert looks like in this dialog.
 *
 * `enabled` is what the alert is DOING, not the column: a once-only alert that
 * has fired keeps `enabled: true` with `completedAt` set, and watches nothing.
 * Showing that as "Armed ☑" would misreport it — and the server treats an
 * `enabled: true` in a PATCH as "watch this again" and clears `completedAt`,
 * so the honest seed is also what keeps an untouched Save from re-arming it.
 */
function draftFromAlert(a: MaAlert): PriceDraft {
  return {
    targetPrice: a.targetPrice ?? 0,
    priceDirection: a.priceDirection ?? "either",
    timeframe: a.timeframe,
    frequency: a.frequency,
    cooldownMin: a.cooldownMin,
    note: a.note?.trim() ? a.note : null,
    enabled: a.enabled && a.completedAt === null,
    filters: filtersFromAlert(a),
  };
}

/**
 * The keys of `next` that differ from `base` — the only keys an edit sends.
 *
 * The same discipline as `alertEditRequest` for the other families: a PATCH
 * that restates every field cannot be told apart from one that changed them,
 * and for `enabled` restating is itself a change (see `draftFromAlert`).
 * `conditionKind` always goes, because the server refuses any value but the
 * row's own — so a dialog opened on a stale list cannot save a price form
 * onto a row that has since become something else.
 */
export function priceEditRequest(base: PriceDraft, next: PriceDraft): Record<string, unknown> {
  const body: Record<string, unknown> = { conditionKind: "price" };
  for (const key of Object.keys(next) as (keyof PriceDraft)[]) {
    if (key === "filters") continue;
    if (next[key] !== base[key]) body[key] = next[key];
  }
  if (JSON.stringify(next.filters) !== JSON.stringify(base.filters)) {
    Object.assign(body, filterRequestForEdit(next.filters));
  }
  return body;
}

/**
 * Arm an alert on a price level — or edit one already armed.
 *
 * The level is pre-filled from wherever the user came from — the price they
 * clicked on the chart, or the last price — because the number they mean is
 * almost always the one already on screen, and retyping it is both friction and
 * an opportunity to fat-finger a decimal.
 *
 * ── C14: one dialog for creating and editing ──────────────────────────────
 *
 * Editing a price alert opened `AlertEditor`, which was a different product:
 * a free-text Symbol row, separate Price and Direction rows on native
 * selects, the three-checkbox gate model, and no pick-from-chart. A reader who
 * armed an alert here and opened it again met a dialog that did not look like
 * the one they had used. With `editing` set this dialog opens on that alert —
 * its level, condition, timeframe, gates, message and state — under "Edit
 * alert", and saves through PATCH onto the same row, so its id, its event log
 * and its delivery history survive the edit.
 */
export function PriceAlertModal({
  open, onClose, symbol, chartTimeframe, resolutionNotice = null, initialPrice, lastPrice,
  lastPriceNotice = null, existing = [], editing = null, onChart = true,
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
  existing?: MaAlert[];
  /**
   * The armed alert this dialog is editing, or null to create one. While set,
   * the dialog seeds from it rather than from the quote, and saves by PATCH.
   */
  editing?: MaAlert | null;
  /**
   * False where no chart is on screen — the Alerts page — so the timeframe
   * list does not mark one of its entries "same as chart".
   */
  onChart?: boolean;
  /**
   * Close and let the next chart click supply the level. Omitted where there
   * is no chart to click — the Alerts page — and the Pick control with it.
   */
  onPickFromChart?: () => void;
  /** The confirmation, and the server's row when there is one (not on delete). */
  onSaved: (message: string, saved?: MaAlert) => void;
}) {
  const ask = useAsk();
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
   *
   * ── A tick is not a reopen ────────────────────────────────────────────────
   *
   * That list was right and its TRIGGER was not. `lastPrice` sat in the
   * dependency array, and `lastPrice` is the live quote, so "seed the dialog
   * when it opens" ran several times a second on a dialog somebody was filling
   * in. Typing a level and pausing three seconds put the market price back in
   * the field with the caret still in it; adding a gate showed the row for
   * about 1.4 seconds before `setFilters(emptyFilters())` took it away. The
   * dialog could only ever arm the alert it had already pre-filled.
   *
   * So the reset is keyed on the OPENING — the false -> true edge — and not on
   * the props it happens to read while seeding.
   *
   * ── Editing seeds from the alert, and only from the alert ────────────────
   *
   * An opening is keyed by WHAT it opened on — `""` for a create, the alert's
   * id for an edit — so editing one alert and then another is two openings,
   * and a refreshed copy of the same alert arriving mid-edit is not. The
   * level comes from the alert (or from a level just picked off the chart for
   * it), never from the quote: `levelSeededRef` is set here so the quote seed
   * below never runs for an edit at all. The live price ticking while
   * somebody retypes an armed alert's level is the 8446608 defect in its
   * second home.
   */
  const openedRef = useRef<string | null>(null);
  const levelSeededRef = useRef(false);
  /** The edited alert as it was seeded, so Save sends only what changed. */
  const baseRef = useRef<PriceDraft | null>(null);

  useEffect(() => {
    if (!open) {
      openedRef.current = null; levelSeededRef.current = false; baseRef.current = null;
      return;
    }
    const opening = editing?.id ?? "";
    if (openedRef.current === opening) return;
    openedRef.current = opening;
    setErr(null);
    if (editing) {
      const base = draftFromAlert(editing);
      baseRef.current = base;
      levelSeededRef.current = true;
      setPrice(initialPrice !== null ? seedText(initialPrice)
        : editing.targetPrice === null ? "" : String(editing.targetPrice));
      setDirection(base.priceDirection);
      setTimeframe(base.timeframe);
      setFilters(base.filters);
      setNote(base.note ?? "");
      setFrequency(base.frequency);
      setArmed(base.enabled);
      setCooldownMin(base.cooldownMin);
      return;
    }
    baseRef.current = null;
    setPrice("");
    setTimeframe(chartTimeframe);
    setFilters(emptyFilters());
    setNote("");
    setFrequency(DEFAULT_ALERT_FREQUENCY);
    setArmed(true);
    setCooldownMin(DEFAULT_COOLDOWN_MIN);
    // `editing` and `initialPrice` are read at the opening edge only; listing
    // them would make a refreshed copy of the alert, or a new pick, a reopen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chartTimeframe, editing?.id]);

  /*
   * The level is seeded from the FIRST quote this opening sees, and never
   * again. Separate from the reset above because the dialog can open before
   * any quote has arrived — an empty field that never fills would be its own
   * defect — but once a number is in the field it belongs to the reader.
   */
  useEffect(() => {
    if (!open || levelSeededRef.current) return;
    const seed = initialPrice ?? lastPrice;
    if (seed === null) return;
    levelSeededRef.current = true;
    setPrice(seedText(seed));
  }, [open, initialPrice, lastPrice]);

  const target = Number(price);
  const valid = Number.isFinite(target) && target > 0;

  /*
   * Creating onto a row that already exists: an alert on the same level,
   * direction and timeframe. Never while editing — the alert being edited IS
   * the row, and a second match found by its new values would be some other
   * alert this save must not touch.
   */
  const twin = editing ? null : existing.find(
    (a) => a.targetPrice === target && a.priceDirection === direction && a.timeframe === timeframe
  ) ?? null;
  const match = editing ?? twin;

  useEffect(() => {
    if (!twin) return;
    setFrequency(twin.frequency);
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
    setArmed(twin.enabled);
    setCooldownMin(twin.cooldownMin);
    setFilters(filtersFromAlert(twin));
    setNote(twin.note ?? "");
  }, [twin?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A cross alert armed on the wrong side of the current price can never fire
   * until price first travels back through the level. Saying so up front is
   * better than a notification that never arrives.
   */
  const impossible =
    valid && lastPrice !== null &&
    ((direction === "cross_up" && lastPrice > target) ||
     (direction === "cross_down" && lastPrice < target));

  /** The ticker this dialog is about: the edited alert's own, or the chart's. */
  const ticker = displayTicker(editing?.symbol ?? symbol);

  const save = async () => {
    if (!valid) { setErr(said("Enter a price above zero.")); return; }
    /*
     * An edit sends what changed and nothing else. An untouched Save is a
     * close: there is nothing to write, and a request that restated the row
     * would re-arm a spent once-only alert (see `draftFromAlert`).
     */
    const edit = editing && baseRef.current
      ? priceEditRequest(baseRef.current, {
        targetPrice: target, priceDirection: direction, timeframe, frequency, cooldownMin,
        note: note.trim() || null, enabled: armed, filters,
      })
      : null;
    if (edit && Object.keys(edit).length === 1) { onClose(); return; }
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
      const row = editing && edit
        ? await api.updateMaAlert(editing.id, edit)
        : twin
          ? await api.updateMaAlert(twin.id, { ...body, ...filterRequestForEdit(filters) })
          : await api.createMaAlert({ ...body, ...filterRequest(filters) });
      onSaved(`${match ? "Updated" : "Alert set"} — ${ticker} ${timeframe} · ${describeAlert(row)}`, row);
      onClose();
    } catch (e) {
      setErr(describeAction(e, editing ? "save the alert" : "arm the alert"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!match) return;
    // The edit dialog asked before deleting, and a delete cannot be undone;
    // the one dialog both paths now share keeps that question for both.
    if (!await ask.confirm({
      title: `Delete this alert on ${ticker}?`,
      body: <>{describeAlert(match)}<br />This cannot be undone.</>,
      confirmLabel: "Delete", tone: "danger",
    })) return;
    setBusy(true);
    try {
      await api.deleteMaAlert(match.id);
      onSaved(`Alert removed — ${ticker} ${fmtPrice(match.targetPrice)}`);
      onClose();
    } catch (e) {
      setErr(describeAction(e, "delete the alert"));
    } finally {
      setBusy(false);
    }
  };

  const box = `w-full ${FIELD}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      /*
        One title grammar for both paths: what is happening, then the ticker.
        "Edit alert" rather than "Price alert" so a reader who opened an armed
        alert can see they are changing it, not arming a second one.
      */
      title={<span className="flex items-center gap-2">{editing ? "Edit alert" : "Price alert"} <span className="text-accent">{ticker}</span></span>}
      panelClassName="w-[480px] max-h-[500px]"
      footer={
        <>
          {match && <Button onClick={() => void remove()} disabled={busy} className="mr-auto text-down">Delete</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !valid}>
            {busy ? "Saving…" : editing ? "Save" : match ? "Update" : "Create"}
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
              {onPickFromChart && (
                <button type="button" onClick={onPickFromChart} title="Pick the level on the chart"
                  className="h-8 shrink-0 rounded border border-border px-2 text-xs text-ink-muted hover:border-accent hover:text-ink">Pick</button>
              )}
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

        {/*
          One control, as the three sibling dialogs have.

          This one wrapped the gate field in a SECOND disclosure, so the dialog
          showed two stacked buttons 56px apart that both offered to add a
          condition — and spelled the plus two different ways, the outer one as
          a typed `＋` (U+FF0B), which the contract forbids in as many words.
          `AlertFiltersField` already owns its own collapsed affordance and
          opens itself when the alert being edited carries gates; the extra
          layer added nothing but a second thing to press.
        */}
        <div className="my-1 border-t border-border" />
        <AlertFiltersField value={filters} onChange={setFilters} />

        <ResolutionNotice notice={resolutionNotice} using={timeframe} />
        <Row label="Timeframe">
          <Dropdown
            value={timeframe}
            label="Alert timeframe"
            width={180}
            onChange={(v) => setTimeframe(v as Interval)}
            options={ALERT_INTERVAL_VALUES.map((tf) => ({
              value: tf,
              label: `${tf}${onChart && resolutionNotice === null && tf === chartTimeframe ? " — same as chart" : ""}`,
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

        <Disclosure label="Message" value={note ? "Custom" : `${ticker} alert`} open={messageOpen} onToggle={() => setMessageOpen((v) => !v)}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={240} rows={2}
            aria-label="Alert note" placeholder={`Write a message for ${ticker}`} className={`w-full resize-none ${box}`} />
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
            {editing?.completedAt && !armed && (
              <p className="text-xs text-ink-faint">
                This once-only alert has already fired. Tick Armed and save to watch for it again.
              </p>
            )}
            <label className="flex items-center gap-2 text-[13px] text-ink-muted">Cooldown <input type="number" min="0" step="5" value={cooldownMin}
              aria-label="Cooldown in minutes" onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))} className="w-20 rounded border border-border bg-transparent px-2 py-1" /> min</label>
          </div>
        </Disclosure>

        {/* accent-is-meaning: this sentence changes what Save will do, so it is
            the dialog talking about its own primary action. */}
        {twin && (
          <p className="pt-1 text-xs text-accent">
            This level already has a {timeframe} alert for that condition; saving updates it.
          </p>
        )}
        {/* State is never signalled by the title alone: the sentence says it. */}
        {editing && (
          <p className="pt-1 text-xs text-ink-faint">
            Saving changes this alert in place. It keeps its history — editing it does not
            create a second one.
          </p>
        )}
        {err && <p className="text-sm text-down" role="alert" title={err.detail || undefined}>{err.headline}</p>}
      </div>
    </Modal>
  );
}
