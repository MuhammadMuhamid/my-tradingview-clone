"use client";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { api, type MaAlert } from "@/lib/api";
import type {
  FilterSide, MaAlertMode, MacdTarget, MaType, PivotType, PriceDirection,
  RsiTarget, SrSide, StAtrMethod,
} from "@/lib/api";
import {
  ALERT_FAMILY_LABELS, EDIT_INTERVALS, PIVOT_ANCHORS, PIVOT_TYPES,
  alertEditForm, alertEditRequest, hasAlertChanges, modeLabel, modesFor,
  pivotLevelNames, usesBand, usesGates, validateAlertForm, type AlertEditForm,
} from "@/lib/alertEditing";
import { describeAlert, alertColor } from "@/lib/alerts";
import type { Interval } from "@/lib/types";

/**
 * The one editor every armed alert opens into.
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
  const [form, setForm] = useState<AlertEditForm | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
    if (problem) { setErr(problem); return; }
    if (!patch || !dirty) { onClose(); return; }
    setBusy("save");
    setErr(null);
    try {
      // The server's row, not the form's — anything it normalised or refused to
      // change must be what the list shows afterwards.
      const updated = await api.updateMaAlert(alert.id, patch);
      onSaved(updated, `Updated ${updated.symbol} · ${describeAlert(updated)}`);
      onClose();
    } catch (e) {
      // Deliberately leaves the dialog open with the server's values still
      // behind it: a failed save must never look like a committed one.
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (!onDeleted) return;
    if (!window.confirm(
      `Delete this alert on ${alert.symbol}?\n\n${describeAlert(alert)}\n\nThis cannot be undone.`
    )) return;
    setBusy("delete");
    setErr(null);
    try {
      await api.deleteMaAlert(alert.id);
      onDeleted(alert, `Deleted ${alert.symbol} · ${describeAlert(alert)}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-[3px] w-4 shrink-0 rounded-full"
            style={{ background: alertColor(alert) }}
            aria-hidden="true"
          />
          Edit alert
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
          <Button variant="primary" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" ? "Saving…" : dirty ? "Save changes" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        {/* ── what it watches ── */}
        <p className="rounded-md border border-border bg-surface-2/50 px-2.5 py-2 text-xs text-ink-muted">
          Currently: <span className="text-ink">{describeAlert(alert)}</span> on{" "}
          <span className="text-ink">{alert.symbol} {alert.timeframe}</span>.
          {" "}The alert type is fixed — delete and re-create it to watch something else.
        </p>

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
          <select
            value={form.timeframe}
            onChange={(e) => update("timeframe", e.target.value as Interval)}
            aria-label="Alert timeframe"
            className={BOX}
          >
            {EDIT_INTERVALS.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </Row>

        <Divider />

        {/* ── family-specific configuration ── */}
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
            <Row label="Direction">
              <select
                value={form.priceDirection}
                onChange={(e) => update("priceDirection", e.target.value as PriceDirection)}
                aria-label="Price direction"
                className={BOX}
              >
                <option value="either">Reaches the level, from either side</option>
                <option value="cross_up">Crosses up through the level</option>
                <option value="cross_down">Crosses down through the level</option>
              </select>
            </Row>
          </>
        )}

        {(kind === "ma" || kind === "ma_vs_ma") && (
          <Row label={kind === "ma_vs_ma" ? "Fast MA" : "Line"}>
            <div className="flex items-center gap-2">
              <select
                value={form.maType}
                onChange={(e) => update("maType", e.target.value as MaType)}
                aria-label="Moving-average type"
                className={`${BOX} w-[92px]`}
              >
                <option value="ema">EMA</option>
                <option value="sma">SMA</option>
              </select>
              <input
                type="number" min={1} max={1000} value={form.maLength}
                onChange={(e) => update("maLength", intOf(e.target.value))}
                aria-label="Moving-average length"
                className={BOX}
              />
            </div>
          </Row>
        )}

        {kind === "ma_vs_ma" && (
          <Row label="Slow MA">
            <div className="flex items-center gap-2">
              <select
                value={form.ma2Type}
                onChange={(e) => update("ma2Type", e.target.value as MaType)}
                aria-label="Slow moving-average type"
                className={`${BOX} w-[92px]`}
              >
                <option value="ema">EMA</option>
                <option value="sma">SMA</option>
              </select>
              <input
                type="number" min={1} max={1000} value={form.ma2Length}
                onChange={(e) => update("ma2Length", intOf(e.target.value))}
                aria-label="Slow moving-average length"
                className={BOX}
              />
            </div>
          </Row>
        )}

        {kind === "sr_zone" && (
          <>
            <Row label="Side">
              <select
                value={form.srSide}
                onChange={(e) => update("srSide", e.target.value as SrSide)}
                aria-label="Support or resistance side"
                className={BOX}
              >
                <option value="support">Nearest support below price</option>
                <option value="resistance">Nearest resistance above price</option>
                <option value="either">Whichever is nearer</option>
              </select>
            </Row>
            <Row label="Swing length">
              <input
                type="number" min={2} max={100} value={form.pivotLength}
                onChange={(e) => update("pivotLength", intOf(e.target.value))}
                aria-label="Swing pivot length"
                className={BOX}
              />
            </Row>
            <Row label="Invalidated by">
              <select
                value={form.invalidation}
                onChange={(e) => update("invalidation", e.target.value as "close" | "wick")}
                aria-label="Zone invalidation"
                className={BOX}
              >
                <option value="close">A close through the zone</option>
                <option value="wick">Any wick through the zone</option>
              </select>
            </Row>
          </>
        )}

        {kind === "pivot_level" && (
          <>
            <Row label="Pivot type">
              <select
                value={form.pivotType}
                onChange={(e) => {
                  const next = e.target.value as PivotType;
                  setForm((f) => f && ({
                    ...f, pivotType: next,
                    // Fibonacci defines no R4/R5, so a level the new type does
                    // not have must not survive the switch.
                    levelName: pivotLevelNames(next).includes(f.levelName) ? f.levelName : "any",
                  }));
                }}
                aria-label="Pivot type"
                className={BOX}
              >
                {PIVOT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Row>
            <Row label="Level">
              <select
                value={form.levelName}
                onChange={(e) => update("levelName", e.target.value)}
                aria-label="Pivot level"
                className={BOX}
              >
                {pivotLevelNames(form.pivotType).map((l) => (
                  <option key={l} value={l}>{l === "any" ? "Whichever is nearest" : l}</option>
                ))}
              </select>
            </Row>
            <Row label="Pivots from">
              <select
                value={form.anchor}
                onChange={(e) => update("anchor", e.target.value)}
                aria-label="Pivot anchor period"
                className={BOX}
              >
                {PIVOT_ANCHORS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Row>
          </>
        )}

        {kind === "rsi" && (
          <>
            <Row label="RSI length">
              <input
                type="number" min={1} max={1000} value={form.rsiLength}
                onChange={(e) => update("rsiLength", intOf(e.target.value))}
                aria-label="RSI length"
                className={BOX}
              />
            </Row>
            <Row label="Crosses">
              <select
                value={form.rsiTarget}
                onChange={(e) => update("rsiTarget", e.target.value as RsiTarget)}
                aria-label="What the RSI crosses"
                className={BOX}
              >
                <option value="level">A fixed level</option>
                <option value="sma">Its own SMA</option>
              </select>
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
                <input
                  type="number" min={1} max={1000} value={form.rsiMaLength}
                  onChange={(e) => update("rsiMaLength", intOf(e.target.value))}
                  aria-label="RSI moving-average length"
                  className={BOX}
                />
              </Row>
            )}
          </>
        )}

        {kind === "macd" && (
          <>
            <Row label="Crosses">
              <select
                value={form.macdTarget}
                onChange={(e) => update("macdTarget", e.target.value as MacdTarget)}
                aria-label="What the MACD crosses"
                className={BOX}
              >
                <option value="signal">The signal line</option>
                <option value="zero">The zero line</option>
              </select>
            </Row>
            <Row label="Lengths">
              <div className="flex items-center gap-2">
                <input
                  type="number" min={1} value={form.macdFast} aria-label="MACD fast length"
                  onChange={(e) => update("macdFast", intOf(e.target.value))} className={BOX} />
                <input
                  type="number" min={1} value={form.macdSlow} aria-label="MACD slow length"
                  onChange={(e) => update("macdSlow", intOf(e.target.value))} className={BOX} />
                <input
                  type="number" min={1} value={form.macdSignal} aria-label="MACD signal length"
                  onChange={(e) => update("macdSignal", intOf(e.target.value))} className={BOX} />
              </div>
            </Row>
            <Hint>fast · slow · signal</Hint>
          </>
        )}

        {kind === "supertrend" && (
          <>
            <Row label="ATR period">
              <input
                type="number" min={1} max={1000} value={form.stPeriod}
                onChange={(e) => update("stPeriod", intOf(e.target.value))}
                aria-label="Supertrend ATR period"
                className={BOX} />
            </Row>
            <Row label="Multiplier">
              <input
                type="number" min="0.1" max="100" step="0.1" value={form.stMultiplier}
                onChange={(e) => update("stMultiplier", numOf(e.target.value))}
                aria-label="Supertrend ATR multiplier"
                className={BOX} />
            </Row>
            <Row label="ATR method">
              <select
                value={form.stAtrMethod}
                onChange={(e) => update("stAtrMethod", e.target.value as StAtrMethod)}
                aria-label="Supertrend ATR method"
                className={BOX}
              >
                <option value="rma">Wilder&apos;s (default)</option>
                <option value="sma">Simple average of true range</option>
              </select>
            </Row>
            <Hint>
              The study&apos;s own defaults are 10 and 3. Changing either reshapes
              the bands, so the alert re-seeds and stays quiet until the next
              genuine flip.
            </Hint>
          </>
        )}

        {kind !== "price" && (
          <Row label="Condition">
            <select
              value={form.mode}
              onChange={(e) => update("mode", e.target.value as MaAlertMode)}
              aria-label="Alert condition"
              className={BOX}
            >
              {modesFor(kind).map((m) => (
                <option key={m} value={m}>{modeLabel(kind, m)}</option>
              ))}
            </select>
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

        {usesGates(kind) && (
          <>
            <Divider />
            <div className="text-sm text-ink-muted">Only fire when</div>
            <label className="flex items-center gap-2 py-1 text-sm text-ink">
              <input type="checkbox" checked={form.filterRsi} className="accent-accent"
                onChange={(e) => update("filterRsi", e.target.checked)} />
              RSI filter
            </label>
            {form.filterRsi && (
              <div className="flex items-center gap-2 pl-6">
                <span className="text-sm text-ink-muted">RSI</span>
                <input type="number" min={1} max={1000} value={form.filterRsiLength}
                  aria-label="Filter RSI length" className={`${BOX} w-[70px]`}
                  onChange={(e) => update("filterRsiLength", intOf(e.target.value))} />
                <select value={form.filterRsiSide} aria-label="Filter RSI side"
                  className={`${BOX} w-[92px]`}
                  onChange={(e) => update("filterRsiSide", e.target.value as FilterSide)}>
                  <option value="above">is above</option>
                  <option value="below">is below</option>
                </select>
                <input type="number" min={1} max={99} value={form.filterRsiLevel}
                  aria-label="Filter RSI level" className={`${BOX} w-[70px]`}
                  onChange={(e) => update("filterRsiLevel", numOf(e.target.value))} />
              </div>
            )}
            <label className="flex items-center gap-2 py-1 text-sm text-ink">
              <input type="checkbox" checked={form.filterMa} className="accent-accent"
                onChange={(e) => update("filterMa", e.target.checked)} />
              Moving-average filter
            </label>
            {form.filterMa && (
              <div className="flex items-center gap-2 pl-6">
                <span className="text-sm text-ink-muted">Price</span>
                <select value={form.filterMaSide} aria-label="Filter MA side"
                  className={`${BOX} w-[92px]`}
                  onChange={(e) => update("filterMaSide", e.target.value as FilterSide)}>
                  <option value="above">is above</option>
                  <option value="below">is below</option>
                </select>
                <select value={form.filterMaType} aria-label="Filter MA type"
                  className={`${BOX} w-[80px]`}
                  onChange={(e) => update("filterMaType", e.target.value as MaType)}>
                  <option value="ema">EMA</option>
                  <option value="sma">SMA</option>
                </select>
                <input type="number" min={1} max={1000} value={form.filterMaLength}
                  aria-label="Filter MA length" className={`${BOX} w-[80px]`}
                  onChange={(e) => update("filterMaLength", intOf(e.target.value))} />
              </div>
            )}
            <label className="flex items-center gap-2 py-1 text-sm text-ink">
              <input type="checkbox" checked={form.filterSt} className="accent-accent"
                onChange={(e) => update("filterSt", e.target.checked)} />
              Supertrend filter
            </label>
            {form.filterSt && (
              <>
                <div className="flex items-center gap-2 pl-6">
                  <span className="text-sm text-ink-muted">Price</span>
                  <select value={form.filterStSide} aria-label="Filter Supertrend side"
                    className={`${BOX} w-[92px]`}
                    onChange={(e) => update("filterStSide", e.target.value as FilterSide)}>
                    <option value="above">is above</option>
                    <option value="below">is below</option>
                  </select>
                  <span className="whitespace-nowrap text-sm text-ink-muted">Supertrend</span>
                  <input type="number" min={1} max={1000} value={form.filterStPeriod}
                    aria-label="Filter Supertrend ATR period" className={`${BOX} w-[64px]`}
                    onChange={(e) => update("filterStPeriod", intOf(e.target.value))} />
                  <input type="number" min="0.1" max="100" step="0.1"
                    value={form.filterStMultiplier}
                    aria-label="Filter Supertrend multiplier" className={`${BOX} w-[64px]`}
                    onChange={(e) => update("filterStMultiplier", numOf(e.target.value))} />
                </div>
                <Hint>
                  ATR period · multiplier. Above the Supertrend is its uptrend,
                  below is its downtrend.
                </Hint>
              </>
            )}
            <Hint>
              Measured on this alert&apos;s own timeframe, on the same bar. While a
              filter is not met the alert stays silent — it does not queue up and
              fire later.
            </Hint>
          </>
        )}

        <Divider />

        {/* ── cadence and state ── */}
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
        <Row label="Note">
          <input
            value={form.note}
            onChange={(e) => update("note", e.target.value)}
            placeholder="optional — shown with the notification"
            aria-label="Alert note"
            className={BOX}
          />
        </Row>
        <label className="flex items-center gap-2 py-1 text-sm text-ink">
          <input type="checkbox" checked={form.enabled} className="accent-accent"
            onChange={(e) => update("enabled", e.target.checked)} />
          Armed
          {alert.completedAt !== null && (
            <span className="text-xs text-ink-faint">
              — this once-only alert has already fired; saving it armed re-arms it
            </span>
          )}
        </label>

        {/* State is never signalled by colour alone: the sentence says it. */}
        <p className="text-xs text-ink-faint">
          Saved changes are picked up on the next candle. The alert keeps its history — editing
          it does not create a second one, and both configurations are never live at once.
        </p>

        {err && (
          <p role="alert" className="rounded-md border border-down/30 bg-down/10 px-2.5 py-2 text-sm text-down">
            {err}
          </p>
        )}
      </div>
    </Modal>
  );
}

const BOX =
  "w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink " +
  "outline-none focus:border-accent";

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[104px_1fr] items-center gap-3">
    <span className="text-sm text-ink-muted">{label}</span>
    {children}
  </div>
);

const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className="pl-[116px] text-xs text-ink-faint">{children}</p>
);

const Divider = () => <div className="my-1 border-t border-border" />;

/** Empty and half-typed input is 0 rather than NaN, which the validator names. */
const intOf = (v: string): number => parseInt(v || "0", 10) || 0;
const numOf = (v: string): number => parseFloat(v || "0") || 0;
