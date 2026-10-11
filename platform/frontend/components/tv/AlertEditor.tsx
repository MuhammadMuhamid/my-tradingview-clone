"use client";
import { useEffect, useMemo, useState } from "react";
import { useAsk } from "@/components/AskDialog";
import { Modal } from "@/components/Modal";
import { Button, Dropdown, FIELD } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { AlertNoteField } from "@/components/tv/AlertNoteField";
import { AlertArmedField } from "@/components/tv/AlertArmedField";
import { AlertFiltersField } from "@/components/tv/AlertFiltersField";
import { api, type MaAlert } from "@/lib/api";
import type {
  BollingerBand, MaAlertMode, MacdTarget, MaType, PivotType,
  PriceDirection, RsiTarget, SrSide, StAtrMethod, StochasticTarget,
} from "@/lib/api";
import {
  ALERT_FAMILY_LABELS, EDIT_INTERVALS, PIVOT_ANCHORS, PIVOT_TYPES,
  alertEditForm, alertEditRequest, hasAlertChanges, modeLabel, modesFor,
  pivotLevelNames, usesBand, usesGates, validateAlertForm, type AlertEditForm,
} from "@/lib/alertEditing";
import { describeAlert, alertColor } from "@/lib/alerts";
import { displayTicker } from "@/lib/instrument";
import type { Interval } from "@/lib/types";
import { describeAction, said, type FailureCopy } from "@/lib/errorCopy";

/** The two moving-average shapes, as every MA control in the product offers them. */
const MA_TYPES = [
  { value: "ema", label: "EMA" },
  { value: "sma", label: "SMA" },
] as const;

/**
 * The one editor every armed alert of a family without its own editing mode
 * opens into.
 *
 * One component, not one per family, because an alert is edited from two
 * places — the Alerts inventory and the chart's rail — and the fields a family
 * has must be the same in both. What differs per family is only which block of
 * rows is rendered; the identity, cadence and state rows are shared, and the
 * rules live in `lib/alertEditing.ts` so they can be tested without a DOM.
 *
 * The alert keeps its id. This is a PATCH onto the existing row, so the event
 * log, the once-only retirement flag and the delivery history all survive an
 * edit — which is the difference between changing an alert and replacing it.
 *
 * ── C14: the create dialogs' grammar ─────────────────────────────────────
 *
 * Price alerts now edit in `PriceAlertModal` itself (`editsInPriceDialog`).
 * The other families are edited here, and this dialog was a different product
 * from the ones that armed them: native `<select>`s, which the contract
 * forbids inside a dialog because the OS draws their chevron, popup, row
 * height and font; the three-checkbox gate model, which could not show a
 * second gate of one kind, a gate on another timeframe, or — for a row that
 * carries the list — any gate at all; and a title without the ticker. The
 * selects are the shared `Dropdown`, the gates are the shared
 * `AlertFiltersField`, the state is the shared `AlertArmedField`, and the
 * title reads "Edit alert TICKER" as the price dialog's does.
 */
export function AlertEditor({
  alert, onClose, onSaved, onDeleted,
}: {
  /** The alert to edit; null closes the dialog. */
  alert: MaAlert | null;
  onClose: () => void;
  /** Receives the authoritative row the server returned. */
  onSaved: (updated: MaAlert, message: string) => void;
  /** Omit to hide Delete — the chart rail offers it, a bulk list need not. */
  onDeleted?: (deleted: MaAlert, message: string) => void;
}) {
  const ask = useAsk();
  const [form, setForm] = useState<AlertEditForm | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [err, setErr] = useState<FailureCopy | null>(null);

  // Refill from the server's copy every time a different alert is opened, so a
  // dialog can never show values left over from the previous one.
  useEffect(() => {
    if (!alert) { setForm(null); return; }
    setForm(alertEditForm(alert));
    setErr(null);
  }, [alert]);

  const kind = alert?.conditionKind ?? "price";
  const patch = useMemo(
    () => (alert && form ? alertEditRequest(alert, form) : null),
    [alert, form]
  );
  const dirty = patch !== null && hasAlertChanges(patch);

  if (!alert || !form) {
    return <Modal open={false} onClose={onClose} title="Edit alert">{null}</Modal>;
  }

  const update = <K extends keyof AlertEditForm>(key: K, value: AlertEditForm[K]): void =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const save = async (): Promise<void> => {
    const problem = validateAlertForm(kind, form);
    if (problem) { setErr(said(problem)); return; }
    if (!patch || !dirty) { onClose(); return; }
    setBusy("save");
    setErr(null);
    try {
      // The server's row, not the form's — anything it normalised or refused to
      // change must be what the list shows afterwards.
      const updated = await api.updateMaAlert(alert.id, patch);
      onSaved(updated, `Updated ${displayTicker(updated.symbol)} · ${describeAlert(updated)}`);
      onClose();
    } catch (e) {
      // Deliberately leaves the dialog open with the server's values still
      // behind it: a failed save must never look like a committed one.
      setErr(describeAction(e, "save the alert"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (!onDeleted) return;
    if (!await ask.confirm({
      title: `Delete this alert on ${displayTicker(alert.symbol)}?`,
      body: <>{describeAlert(alert)}<br />This cannot be undone.</>,
      confirmLabel: "Delete", tone: "danger",
    })) return;
    setBusy("delete");
    setErr(null);
    try {
      await api.deleteMaAlert(alert.id);
      onDeleted(alert, `Deleted ${displayTicker(alert.symbol)} · ${describeAlert(alert)}`);
      onClose();
    } catch (e) {
      setErr(describeAction(e, "delete the alert"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      /*
        "Edit alert", then the ticker — the price dialog's own title shape —
        and the family as a quiet badge, because this one dialog serves ten of
        them and which one is open is the first thing to know.
      */
      title={
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-[3px] w-4 shrink-0 rounded-full"
            style={{ background: alertColor(alert) }}
            aria-hidden="true"
          />
          Edit alert <span>{displayTicker(alert.symbol)}</span>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
            {ALERT_FAMILY_LABELS[kind]}
          </span>
        </span>
      }
      footer={
        <>
          {onDeleted && (
            <Button
              variant="danger"
              onClick={() => void remove()}
              disabled={busy !== null}
              className="mr-auto"
            >
              {busy === "delete" ? "Deleting…" : "Delete"}
            </Button>
          )}
          <Button onClick={onClose} disabled={busy !== null}>Cancel</Button>
          <Button variant="contrast" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        {/* ── the condition, first, as every create dialog opens ── */}
        {kind === "price" && (
          <>
            <Row label="Price">
              <input
                type="text"
                inputMode="decimal"
                value={form.targetPrice}
                onChange={(e) => update("targetPrice", e.target.value)}
                aria-label="Target price"
                className={BOX}
              />
            </Row>
            <Row label="Condition">
              <Dropdown
                value={form.priceDirection}
                label="Price direction"
                width={WIDE}
                onChange={(v) => update("priceDirection", v as PriceDirection)}
                options={[
                  { value: "either", label: "Price reaches the level, from either side" },
                  { value: "cross_up", label: "Price crosses up through the level" },
                  { value: "cross_down", label: "Price crosses down through the level" },
                ]}
              />
            </Row>
          </>
        )}

        {(kind === "ma" || kind === "ma_vs_ma") && (
          <Row label={kind === "ma_vs_ma" ? "Fast MA" : "Line"}>
            <div className="flex items-center gap-2">
              <Dropdown
                value={form.maType}
                label="Moving-average type"
                width={92}
                onChange={(v) => update("maType", v as MaType)}
                options={MA_TYPES}
              />
              <IntInput value={form.maLength} onChange={(n) => update("maLength", n)} label="Moving-average length" />
            </div>
          </Row>
        )}

        {kind === "ma_vs_ma" && (
          <Row label="Slow MA">
            <div className="flex items-center gap-2">
              <Dropdown
                value={form.ma2Type}
                label="Slow moving-average type"
                width={92}
                onChange={(v) => update("ma2Type", v as MaType)}
                options={MA_TYPES}
              />
              <IntInput value={form.ma2Length} onChange={(n) => update("ma2Length", n)} label="Slow moving-average length" />
            </div>
          </Row>
        )}

        {kind === "sr_zone" && (
          <>
            <Row label="Side">
              <Dropdown
                value={form.srSide}
                label="Support or resistance side"
                width={WIDE}
                onChange={(v) => update("srSide", v as SrSide)}
                options={[
                  { value: "support", label: "Nearest support below price" },
                  { value: "resistance", label: "Nearest resistance above price" },
                  { value: "either", label: "Whichever is nearer" },
                ]}
              />
            </Row>
            <Row label="Swing length">
              <IntInput value={form.pivotLength} onChange={(n) => update("pivotLength", n)} label="Swing pivot length" min={2} max={100} />
            </Row>
            <Row label="Invalidated by">
              <Dropdown
                value={form.invalidation}
                label="Zone invalidation"
                width={WIDE}
                onChange={(v) => update("invalidation", v as "close" | "wick")}
                options={[
                  { value: "close", label: "A close through the zone" },
                  { value: "wick", label: "Any wick through the zone" },
                ]}
              />
            </Row>
          </>
        )}

        {kind === "pivot_level" && (
          <>
            <Row label="Pivot type">
              <Dropdown
                value={form.pivotType}
                label="Pivot type"
                width={WIDE}
                onChange={(v) => {
                  const next = v as PivotType;
                  setForm((f) => f && ({
                    ...f, pivotType: next,
                    // Fibonacci defines no R4/R5, so a level the new type does
                    // not have must not survive the switch.
                    levelName: pivotLevelNames(next).includes(f.levelName) ? f.levelName : "any",
                  }));
                }}
                options={PIVOT_TYPES.map((t) => ({ value: t, label: t }))}
              />
            </Row>
            <Row label="Level">
              <Dropdown
                value={form.levelName}
                label="Pivot level"
                width={WIDE}
                onChange={(v) => update("levelName", v)}
                options={pivotLevelNames(form.pivotType).map((l) => (
                  { value: l, label: l === "any" ? "Whichever is nearest" : l }
                ))}
              />
            </Row>
            <Row label="Pivots from">
              <Dropdown
                value={form.anchor}
                label="Pivot anchor period"
                width={WIDE}
                onChange={(v) => update("anchor", v)}
                options={PIVOT_ANCHORS.map((a) => ({ value: a.id, label: a.label }))}
              />
            </Row>
          </>
        )}

        {kind === "rsi" && (
          <>
            <Row label="RSI length">
              <IntInput value={form.rsiLength} onChange={(n) => update("rsiLength", n)} label="RSI length" />
            </Row>
            <Row label="Crosses">
              <Dropdown
                value={form.rsiTarget}
                label="What the RSI crosses"
                width={WIDE}
                onChange={(v) => update("rsiTarget", v as RsiTarget)}
                options={[
                  { value: "level", label: "A fixed level" },
                  { value: "sma", label: "Its own SMA" },
                ]}
              />
            </Row>
            {form.rsiTarget === "level" ? (
              <Row label="Level">
                <input
                  type="number" min={1} max={99} value={form.rsiLevel}
                  onChange={(e) => update("rsiLevel", numOf(e.target.value))}
                  aria-label="RSI level"
                  className={BOX}
                />
              </Row>
            ) : (
              <Row label="SMA length">
                <IntInput value={form.rsiMaLength} onChange={(n) => update("rsiMaLength", n)} label="RSI moving-average length" />
              </Row>
            )}
          </>
        )}

        {kind === "macd" && (
          <>
            <Row label="Crosses">
              <Dropdown
                value={form.macdTarget}
                label="What the MACD crosses"
                width={WIDE}
                onChange={(v) => update("macdTarget", v as MacdTarget)}
                options={[
                  { value: "signal", label: "The signal line" },
                  { value: "zero", label: "The zero line" },
                ]}
              />
            </Row>
            <Row label="Lengths">
              <div className="flex items-center gap-2">
                <IntInput value={form.macdFast} onChange={(n) => update("macdFast", n)} label="MACD fast length" />
                <IntInput value={form.macdSlow} onChange={(n) => update("macdSlow", n)} label="MACD slow length" />
                <IntInput value={form.macdSignal} onChange={(n) => update("macdSignal", n)} label="MACD signal length" />
              </div>
            </Row>
            <Hint>fast · slow · signal</Hint>
          </>
        )}

        {kind === "supertrend" && (
          <>
            <Row label="ATR period">
              <IntInput value={form.stPeriod} onChange={(n) => update("stPeriod", n)} label="Supertrend ATR period" />
            </Row>
            <Row label="Multiplier">
              <input
                type="number" min="0.1" max="100" step="0.1" value={form.stMultiplier}
                onChange={(e) => update("stMultiplier", numOf(e.target.value))}
                aria-label="Supertrend ATR multiplier"
                className={BOX} />
            </Row>
            <Row label="ATR method">
              <Dropdown
                value={form.stAtrMethod}
                label="Supertrend ATR method"
                width={WIDE}
                onChange={(v) => update("stAtrMethod", v as StAtrMethod)}
                options={[
                  { value: "rma", label: "Wilder's (default)" },
                  { value: "sma", label: "Simple average of true range" },
                ]}
              />
            </Row>
            <Hint>
              The study&apos;s own defaults are 10 and 3. Changing either reshapes
              the bands, so the alert re-seeds and stays quiet until the next
              genuine flip.
            </Hint>
          </>
        )}

        {kind === "bollinger" && (
          <>
            <Row label="Band">
              <Dropdown
                value={form.bbBand}
                label="Which Bollinger band"
                width={WIDE}
                onChange={(v) => update("bbBand", v as BollingerBand)}
                options={[
                  { value: "upper", label: "Upper" },
                  { value: "basis", label: "Basis" },
                  { value: "lower", label: "Lower" },
                ]}
              />
            </Row>
            <Row label="Length">
              <IntInput value={form.bbLength} onChange={(n) => update("bbLength", n)} label="Bollinger length" min={2} />
            </Row>
            <Row label="Multiplier">
              <input
                type="number" min="0.1" max="100" step="0.1" value={form.bbMult}
                onChange={(e) => update("bbMult", numOf(e.target.value))}
                aria-label="Bollinger standard deviations"
                className={BOX} />
            </Row>
            <Row label="Basis">
              <Dropdown
                value={form.bbMaType}
                label="Bollinger basis type"
                width={WIDE}
                onChange={(v) => update("bbMaType", v as MaType)}
                options={[
                  { value: "sma", label: "Simple (default)" },
                  { value: "ema", label: "Exponential" },
                ]}
              />
            </Row>
            <Hint>
              The study&apos;s own defaults are 20 and 2. This alert watches PRICE
              against the band, so it offers the same touch and approach
              conditions a moving-average alert does.
            </Hint>
          </>
        )}

        {kind === "stochastic" && (
          <>
            <Row label="Crosses">
              <Dropdown
                value={form.stochTarget}
                label="What the Stochastic crosses"
                width={WIDE}
                onChange={(v) => update("stochTarget", v as StochasticTarget)}
                options={[
                  { value: "signal", label: "Its %D signal line" },
                  { value: "level", label: "A fixed level" },
                ]}
              />
            </Row>
            {form.stochTarget === "level" && (
              <Row label="Level">
                <input
                  type="number" min={1} max={99} value={form.stochLevel}
                  onChange={(e) => update("stochLevel", numOf(e.target.value))}
                  aria-label="Stochastic level"
                  className={BOX} />
              </Row>
            )}
            <Row label="Lengths">
              <div className="flex items-center gap-2">
                <IntInput value={form.stochKLength} onChange={(n) => update("stochKLength", n)} label="Stochastic %K length" />
                <IntInput value={form.stochKSmooth} onChange={(n) => update("stochKSmooth", n)} label="Stochastic %K smoothing" />
                <IntInput value={form.stochDSmooth} onChange={(n) => update("stochDSmooth", n)} label="Stochastic %D smoothing" />
              </div>
            </Row>
            <Hint>%K length · %K smoothing · %D smoothing</Hint>
          </>
        )}

        {kind === "adx" && (
          <>
            <Row label="Level">
              <input
                type="number" min={1} max={99} value={form.adxLevel}
                onChange={(e) => update("adxLevel", numOf(e.target.value))}
                aria-label="ADX level"
                className={BOX} />
            </Row>
            <Row label="Lengths">
              <div className="flex items-center gap-2">
                <IntInput value={form.adxDiLength} onChange={(n) => update("adxDiLength", n)} label="ADX DI length" />
                <IntInput value={form.adxSmoothing} onChange={(n) => update("adxSmoothing", n)} label="ADX smoothing" />
              </div>
            </Row>
            <Hint>
              DI length · smoothing. ADX measures trend STRENGTH and has no
              direction, so &ldquo;rises through&rdquo; means the trend is firming
              and &ldquo;falls through&rdquo; that it is fading.
            </Hint>
          </>
        )}

        {kind !== "price" && (
          <Row label="Condition">
            <Dropdown
              value={form.mode}
              label="Alert condition"
              width={WIDE}
              onChange={(v) => update("mode", v as MaAlertMode)}
              options={modesFor(kind).map((m) => ({ value: m, label: modeLabel(kind, m) }))}
            />
          </Row>
        )}

        {usesBand(kind, form.mode) && (
          <>
            <Row label="Band">
              <div className="flex items-center gap-2">
                <input
                  type="number" step="0.05" min="0" value={form.nearMinPct}
                  onChange={(e) => update("nearMinPct", numOf(e.target.value))}
                  aria-label="Near band inner edge, percent"
                  className={BOX} />
                <span className="text-sm text-ink-faint">to</span>
                <input
                  type="number" step="0.05" min="0" value={form.nearMaxPct}
                  onChange={(e) => update("nearMaxPct", numOf(e.target.value))}
                  aria-label="Near band outer edge, percent"
                  className={BOX} />
                <span className="text-sm text-ink-muted">%</span>
              </div>
            </Row>
            <Hint>
              Notify while price is {form.nearMinPct}–{form.nearMaxPct}%{" "}
              {form.mode === "near_above" ? "above" : "below"} the level — approaching it, not
              touching it.
            </Hint>
          </>
        )}

        {/*
          The gates, as the LIST the create dialogs edit — the same component,
          so a gate armed there is shown and changed here exactly as it was
          built. It opens expanded when the alert carries any.
        */}
        {usesGates(kind) && (
          <>
            <Divider />
            <AlertFiltersField value={form.gates} onChange={(next) => update("gates", next)} />
          </>
        )}

        <Divider />

        {/* ── where it runs: the instrument and the timeframe ── */}
        <Row label="Symbol">
          <input
            value={form.symbol}
            onChange={(e) => update("symbol", e.target.value.toUpperCase())}
            aria-label="Alert symbol"
            className={BOX}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
        </Row>
        <Row label="Timeframe">
          <Dropdown
            value={form.timeframe}
            label="Alert timeframe"
            width={WIDE}
            onChange={(v) => update("timeframe", v as Interval)}
            options={EDIT_INTERVALS.map((tf) => ({ value: tf, label: tf }))}
          />
        </Row>

        {/* ── cadence, message and state, in the create dialogs' order ── */}
        <FrequencyField
          value={form.frequency}
          onChange={(next) => update("frequency", next)}
          timeframe={form.timeframe}
        />
        {form.frequency === "once_per_bar_close" && (
          <Row label="Cooldown">
            <div className="flex items-center gap-2">
              <input type="number" min={0} step={5} value={form.cooldownMin}
                onChange={(e) => update("cooldownMin", intOf(e.target.value))}
                aria-label="Cooldown minutes"
                className={BOX} />
              <span className="whitespace-nowrap text-sm text-ink-muted">minutes</span>
            </div>
          </Row>
        )}
        {/* The same field the creation dialogs offer, rather than a one-line
            input: this is a 280-character message, and the counter and the
            "shown at the end of the notification" hint are the two things that
            make the limit and the purpose obvious while typing. */}
        <AlertNoteField value={form.note} onChange={(next) => update("note", next)} />
        <AlertArmedField
          value={form.enabled}
          onChange={(next) => update("enabled", next)}
          disabledNote={alert.completedAt !== null
            ? "This once-only alert has already fired; saving it armed re-arms it."
            : "Saved changes are picked up on the next candle."}
        />

        {/* State is never signalled by colour alone: the sentence says it. */}
        <p className="text-xs text-ink-faint">
          The alert keeps its history — editing it does not create a second one, and both
          configurations are never live at once. The alert type is fixed; delete and
          re-create it to watch something else.
        </p>

        {err && (
          <p role="alert" title={err.detail || undefined}
            className="rounded-md border border-down/30 bg-down/10 px-2.5 py-2 text-sm text-down">
            {err.headline}
          </p>
        )}
      </div>
    </Modal>
  );
}

const BOX = `w-full ${FIELD}`;

/**
 * A whole-number field. Module-level, like `Row`, because a component
 * declared inside a render is a new type on every render, and React remounts
 * a changed type — which for a number input means losing the caret after
 * each keystroke.
 */
const IntInput = ({ value, onChange, label, min = 1, max = 1000 }: {
  value: number; onChange: (next: number) => void; label: string; min?: number; max?: number;
}) => (
  <input
    type="number" min={min} max={max} value={value}
    onChange={(e) => onChange(intOf(e.target.value))}
    aria-label={label}
    className={BOX}
  />
);

/** The wide Dropdown width, the reference's 180. */
const WIDE = 180;

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[110px_1fr] items-center gap-3">
    <span className="text-sm text-ink-muted">{label}</span>
    {children}
  </div>
);

const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className="pl-[122px] text-xs text-ink-faint">{children}</p>
);

const Divider = () => <div className="my-1 border-t border-border" />;

/** Empty and half-typed input is 0 rather than NaN, which the validator names. */
const intOf = (v: string): number => parseInt(v || "0", 10) || 0;
const numOf = (v: string): number => parseFloat(v || "0") || 0;
