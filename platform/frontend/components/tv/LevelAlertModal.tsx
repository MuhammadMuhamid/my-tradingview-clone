"use client";
import { useCallback, useEffect, useState } from "react";
import { ResolutionNotice } from "@/components/tv/ResolutionNotice";
import { Modal } from "@/components/Modal";
import { Button, FIELD } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { AlertNoteField } from "@/components/tv/AlertNoteField";
import { AlertArmedField } from "@/components/tv/AlertArmedField";
import { AlertScopeField, type AlertScopeStatus } from "@/components/tv/AlertScopeField";
import { armAcross, armingSummary, feedBudget, planArming } from "@/lib/alertScope";
import {
  AlertFiltersField, emptyFilters, filterRequest, filterRequestForEdit,
  type AlertFilterState,
} from "@/components/tv/AlertFiltersField";
import {
  api,
  type AlertFrequency, type MaAlert, type MaAlertMode, type PivotType, type SrSide,
} from "@/lib/api";
import type { Interval } from "@/lib/types";
import { AUTO_FIB_DEFAULTS, AUTO_FIB_LEVELS } from "@/lib/ta/core";
import type { ObZone } from "@/lib/api";

/** The level families this dialog arms. */
export type LevelKind =
  | "sr_zone" | "pivot_level" | "fib_level" | "msb" | "order_block" | "liquidity_swing";
import { displayTicker } from "@/lib/instrument";
import { describeAction, said, type FailureCopy } from "@/lib/errorCopy";

/**
 * Arm a support/resistance or pivot-level alert.
 *
 * Separate from the MA dialog because the thing being watched is chosen
 * differently: an MA alert names a line that is already on the chart, while
 * these name a rule the server resolves to whichever level price is actually
 * approaching.
 */

/** The timeframes the user asked to cover, plus the ones either side. */
const TIMEFRAMES: Interval[] = ["5m", "15m", "1h", "4h"];

/** Pivot anchors the platform stores candles for. */
const ANCHORS: { id: Interval; label: string }[] = [
  { id: "1d", label: "Daily" },
  { id: "12h", label: "12 hours" },
  { id: "6h", label: "6 hours" },
  { id: "4h", label: "4 hours" },
];

/** Fibonacci defines P and three levels either side — no R4/R5. */
const FIB_LEVELS = ["any", "P", "R1", "S1", "R2", "S2", "R3", "S3"];

const MODES: { id: MaAlertMode; label: string }[] = [
  { id: "near_above", label: "Approaches from above" },
  { id: "near_below", label: "Approaches from below" },
  { id: "touch", label: "Touches the level" },
  { id: "cross_up", label: "Crosses above" },
  { id: "cross_down", label: "Crosses below" },
];

export function LevelAlertModal({
  open, onClose, symbol, defaultTimeframe, resolutionNotice = null,
  initialKind = "sr_zone", existing = [], onSaved,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  defaultTimeframe: Interval;
  /** Why the chart's resolution is not this alert's timeframe, or null. */
  resolutionNotice?: string | null;
  /** Which level family to open on, when the caller already knows. */
  initialKind?: LevelKind;
  /** The alerts already on this symbol, so Save cannot silently re-arm one. */
  existing?: readonly MaAlert[];
  onSaved: (message: string) => void;
}) {
  const [kind, setKind] = useState<LevelKind>(initialKind);
  const [timeframes, setTimeframes] = useState<Interval[]>([defaultTimeframe]);
  const [srSide, setSrSide] = useState<SrSide>("support");
  const [pivotType, setPivotType] = useState<PivotType>("Fibonacci");
  const [levelName, setLevelName] = useState("any");
  const [anchor, setAnchor] = useState<Interval>("1d");
  const [mode, setMode] = useState<MaAlertMode>("near_above");
  const [nearMinPct, setNearMinPct] = useState(0.2);
  const [nearMaxPct, setNearMaxPct] = useState(0.5);
  // Auto Fib Retracement — the indicator's own defaults, and the 0.618.
  const [fibLevel, setFibLevel] = useState(0.618);
  const [fibDeviation, setFibDeviation] = useState<number>(AUTO_FIB_DEFAULTS.deviation);
  const [fibDepth, setFibDepth] = useState<number>(AUTO_FIB_DEFAULTS.depth);
  const [fibReverse, setFibReverse] = useState(false);
  // MSB-OB and Liquidity Swings — the owner's indicator settings.
  const [msbZigzagLength, setMsbZigzagLength] = useState(9);
  const [msbFibFactor, setMsbFibFactor] = useState(0.33);
  const [obZone, setObZone] = useState<ObZone>("any");
  const [lsLength, setLsLength] = useState(20);
  const [lsArea, setLsArea] = useState<"wick" | "full">("full");
  const [lsSide, setLsSide] = useState<"high" | "low" | "either">("either");
  const [filters, setFilters] = useState<AlertFilterState>(emptyFilters);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(true);
  /*
   * TVP8: which existing alerts this dialog's Save would land on.
   *
   * `api.createMaAlert` is an UPSERT — `ON CONFLICT (symbol, timeframe,
   * sr_side, mode) DO UPDATE SET enabled = EXCLUDED.enabled` — so "creating"
   * an alert whose condition already exists overwrites that row. This dialog
   * armed at `true` unconditionally and never looked, which meant opening it
   * on a condition the user had deliberately PAUSED and pressing Save re-armed
   * it, silently. `PriceAlertModal` and `MaAlertModal` already prefill from
   * the matched row and say why (`PriceAlertModal.tsx`, the comment on
   * `setArmed(match.enabled)`); these two were the pair that did not.
   *
   * It covers several timeframes at once, so there can be several matches.
   * Arming follows them only when they AGREE — a mixed selection has no one
   * truthful value, and the notice below says so instead of picking one.
   */
  /**
   * Whether an existing alert is the one this dialog describes. For a fib, the
   * ratio AND the zig-zag inputs: a different depth anchors a different swing,
   * so it is a different level even at the same ratio.
   */
  const sameLevel = (a: MaAlert): boolean =>
    kind === "sr_zone" ? a.srSide === srSide
      : kind === "pivot_level" ? a.pivotLevelName === levelName
        : kind === "msb" ? a.msbZigzagLength === msbZigzagLength && a.msbFibFactor === msbFibFactor
          : kind === "order_block" ? a.msbZigzagLength === msbZigzagLength
            && a.msbFibFactor === msbFibFactor && a.obZone === obZone
            : kind === "liquidity_swing" ? a.lsLength === lsLength && a.lsArea === lsArea && a.lsSide === lsSide
              : a.fibLevel === fibLevel && a.fibDeviation === fibDeviation
                && a.fibDepth === fibDepth && a.fibReverse === fibReverse;
  const matches = existing.filter((a) =>
    a.conditionKind === kind
    && a.mode === mode
    && timeframes.includes(a.timeframe)
    && sameLevel(a));
  const matchedArmed = matches.length > 0 && matches.every((a) => a.enabled === matches[0]!.enabled)
    ? matches[0]!.enabled : null;

  const [frequency, setFrequency] = useState<AlertFrequency>("once_per_bar_close");
  const [cooldownMin, setCooldownMin] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FailureCopy | null>(null);
  /*
   * Which coins Save arms. "This coin only" keeps the save path this dialog
   * always had; a watchlist or every tracked coin fans the same alert out —
   * see `AlertScopeField` and `lib/alertScope.ts`.
   */
  const thisCoinOnly = useCallback(
    (): AlertScopeStatus => ({ scope: { kind: "symbol" }, symbols: [symbol], ready: true }),
    [symbol]);
  const [scope, setScope] = useState<AlertScopeStatus>(thisCoinOnly);
  const [progress, setProgress] = useState<string | null>(null);
  /** The per-coin twin of `matches`: same family, mode, timeframe and side or level. */
  const sameAlert = useCallback(
    (a: MaAlert, timeframe: Interval) =>
      a.conditionKind === kind && a.mode === mode && a.timeframe === timeframe
      && sameLevel(a),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, mode, srSide, levelName, fibLevel, fibDeviation, fibDepth, fibReverse,
      msbZigzagLength, msbFibFactor, obZone, lsLength, lsArea, lsSide]);

  // Follow the matched rows, so an untouched Save cannot change what they hold.
  useEffect(() => {
    if (matchedArmed !== null) setArmed(matchedArmed);
  }, [matchedArmed]);

  useEffect(() => {
    // Reopening from a specific rail row should land on that family, not on
    // whatever the previous visit happened to leave selected.
    if (open) {
      setTimeframes([defaultTimeframe]);
      setKind(initialKind);
      setNote("");
      setErr(null);
      setScope(thisCoinOnly());
      setProgress(null);
    }
  }, [open, defaultTimeframe, initialKind, thisCoinOnly]);

  // "Alert me when price reaches the 0.618" is a touch. Chosen when the fib
  // family is, so the user starts from what they asked for.
  useEffect(() => {
    // A structure break and a zone entry are events: they start on the
    // either-direction break and on the one entry event respectively.
    if (kind === "fib_level" || kind === "msb" || kind === "order_block") setMode("touch");
    if (kind === "liquidity_swing") setMode("touch");
  }, [kind]);
  const modes = kind === "msb"
    ? [{ id: "cross_up" as const, label: "Bullish break" }, { id: "cross_down" as const, label: "Bearish break" },
      { id: "touch" as const, label: "Either direction" }]
    : kind === "order_block" ? [{ id: "touch" as const, label: "Price enters the zone" }]
      : MODES;

  const isNear = mode === "near_above" || mode === "near_below";
  const toggleTf = (tf: Interval): void =>
    setTimeframes((cur) => cur.includes(tf) ? cur.filter((t) => t !== tf) : [...cur, tf]);

  /** The request for one coin on one timeframe — the same fields whichever coin. */
  const bodyFor = (sym: string, timeframe: Interval) => ({
    symbol: sym, timeframe, conditionKind: kind, mode,
    nearMinPct, nearMaxPct, frequency, cooldownMin,
    ...(kind === "sr_zone"
      ? { srSide }
      : kind === "pivot_level"
        ? { pivotType, levelName, anchor }
        : kind === "msb" ? { msbZigzagLength, msbFibFactor }
          : kind === "order_block" ? { msbZigzagLength, msbFibFactor, obZone }
            : kind === "liquidity_swing" ? { lsLength, lsArea, lsSide }
              : { fibLevel, fibDeviation, fibDepth, fibReverse }),
    note: note.trim() || null,
    enabled: armed,
  });

  /**
   * Save across several coins. Re-reads every alert at the moment of saving —
   * the counts the field showed may be a minute old — and refuses outright if
   * the alert engine could not watch the result.
   */
  const saveAcross = async (): Promise<void> => {
    const existingAll = await api.listMaAlerts();
    const plan = planArming(scope.symbols, timeframes, existingAll, sameAlert);
    const budget = feedBudget(existingAll, plan, armed);
    if (!budget.fits) {
      setErr(said(
        `That needs ${budget.after} live feeds and the alert engine watches at most ${budget.cap}. `
        + "Choose fewer coins or timeframes, or save them paused."));
      return;
    }
    const result = await armAcross(plan, async (item) => {
      const body = bodyFor(item.symbol, item.timeframe);
      if (item.existingId) {
        await api.updateMaAlert(item.existingId, { ...body, ...filterRequestForEdit(filters) });
      } else {
        await api.createMaAlert({ ...body, ...filterRequest(filters) });
      }
    }, (done, total) => setProgress(`Arming ${done} of ${total}…`));
    setProgress(null);
    const summary = armingSummary(result, timeframes, armed ? "armed" : "saved");
    if (result.failed.length > 0) {
      // Kept on screen, not flashed in a toast: the user needs to see which
      // coins did not take. Everything that succeeded stays saved.
      setErr(said(summary));
      return;
    }
    onSaved(summary);
    onClose();
  };

  const save = async () => {
    if (timeframes.length === 0) { setErr(said("Pick at least one timeframe.")); return; }
    if (isNear && nearMaxPct <= nearMinPct) {
      setErr(said("The far edge of the band must be larger than the near edge."));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (scope.scope.kind !== "symbol") { await saveAcross(); return; }
      // One alert per timeframe. The notification names the timeframe it fired
      // on, which is only meaningful if each timeframe is its own alert.
      for (const timeframe of timeframes) {
        const body = bodyFor(symbol, timeframe);
        /*
         * An existing alert on this timeframe is EDITED, not upserted.
         *
         * Gates are part of what identifies an alert, so an upsert whose gates
         * the user just changed would arm a second alert on the same level and
         * leave the first behind still carrying the old gates. `matches` is
         * found by the condition alone, which is the row being edited.
         */
        const existingHere = matches.find((a) => a.timeframe === timeframe);
        if (existingHere) {
          await api.updateMaAlert(existingHere.id, {
            ...body, ...filterRequestForEdit(filters),
          });
        } else {
          // An omitted gate list means "no gate", which is what every alert
          // created before this feature has.
          await api.createMaAlert({ ...body, ...filterRequest(filters) });
        }
      }
      onSaved(
        `${timeframes.length} alert${timeframes.length === 1 ? "" : "s"} armed on ${displayTicker(symbol)} · ` +
        `${timeframes.join(", ")}`
      );
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
      title={<>Level alert on {displayTicker(symbol)}</>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="contrast" onClick={() => void save()}
            disabled={busy || !scope.ready || timeframes.length === 0}>
            {busy ? (progress ?? "Saving…")
              : `Create ${timeframes.length * scope.symbols.length || ""}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Row label="Watch">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={box}>
            <option value="sr_zone">Support / resistance zones</option>
            <option value="pivot_level">Pivot points</option>
            <option value="fib_level">Auto fib retracement</option>
            <option value="msb">Market structure break (MSB-OB)</option>
            <option value="order_block">Order block zone (MSB-OB)</option>
            <option value="liquidity_swing">Liquidity swing level (LuxAlgo)</option>
          </select>
        </Row>

        {(kind === "msb" || kind === "order_block") && (
          <>
            {kind === "order_block" && (
              <Row label="Zone">
                <select value={obZone} aria-label="Order block zone"
                  onChange={(e) => setObZone(e.target.value as ObZone)} className={box}>
                  <option value="any">Any zone</option>
                  <option value="bullish">Any bullish zone (Bu-OB, Bu-BB)</option>
                  <option value="bearish">Any bearish zone (Be-OB, Be-BB)</option>
                  <option value="bu_ob">Bullish order block (Bu-OB)</option>
                  <option value="be_ob">Bearish order block (Be-OB)</option>
                  <option value="bu_bb">Bullish breaker (Bu-BB / Bu-MB)</option>
                  <option value="be_bb">Bearish breaker (Be-BB / Be-MB)</option>
                </select>
              </Row>
            )}
            <Row label="ZigZag length">
              <input type="number" min="1" max="500" step="1" value={msbZigzagLength}
                aria-label="ZigZag length"
                onChange={(e) => setMsbZigzagLength(parseInt(e.target.value || "0", 10))} className={box} />
            </Row>
            <Row label="Fib factor">
              <input type="number" min="0" max="1" step="0.01" value={msbFibFactor}
                aria-label="Fib factor for breakout confirmation"
                onChange={(e) => setMsbFibFactor(parseFloat(e.target.value || "0"))} className={box} />
            </Row>
            <p className="text-xs text-ink-faint">
              {kind === "msb"
                ? "Fires on the bar the MSB-OB indicator marks a market structure break, on each alert timeframe."
                : "Fires on the bar price first enters a zone the MSB-OB indicator draws — once per entry, not on every bar inside it."}
            </p>
          </>
        )}

        {kind === "liquidity_swing" && (
          <>
            <Row label="Level">
              <select value={lsSide} aria-label="Liquidity level"
                onChange={(e) => setLsSide(e.target.value as typeof lsSide)} className={box}>
                <option value="either">Whichever is nearest</option>
                <option value="high">Swing high</option>
                <option value="low">Swing low</option>
              </select>
            </Row>
            <Row label="Pivot lookback">
              <input type="number" min="1" max="500" step="1" value={lsLength}
                aria-label="Pivot lookback"
                onChange={(e) => setLsLength(parseInt(e.target.value || "0", 10))} className={box} />
            </Row>
            <Row label="Swing area">
              <select value={lsArea} aria-label="Swing area"
                onChange={(e) => setLsArea(e.target.value as typeof lsArea)} className={box}>
                <option value="full">Full Range</option>
                <option value="wick">Wick Extremity</option>
              </select>
            </Row>
            <p className="text-xs text-ink-faint">
              The latest swing level no candle has closed beyond — the solid line the
              Liquidity Swings indicator draws.
            </p>
          </>
        )}

        {kind === "fib_level" ? (
          <>
            <Row label="Level">
              <select value={String(fibLevel)} aria-label="Fib level"
                onChange={(e) => setFibLevel(Number(e.target.value))} className={box}>
                {AUTO_FIB_LEVELS.map((l) => (
                  <option key={l.value} value={String(l.value)}>{l.value}</option>
                ))}
              </select>
            </Row>
            <Row label="Deviation">
              <input type="number" min="0" max="100" step="0.1" value={fibDeviation}
                aria-label="Fib deviation"
                onChange={(e) => setFibDeviation(parseFloat(e.target.value || "0"))} className={box} />
            </Row>
            <Row label="Depth">
              <input type="number" min="2" max="500" step="1" value={fibDepth}
                aria-label="Fib depth"
                onChange={(e) => setFibDepth(parseInt(e.target.value || "0", 10))} className={box} />
            </Row>
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input type="checkbox" className="accent-accent" checked={fibReverse}
                onChange={(e) => setFibReverse(e.target.checked)} />
              Reverse (swap which end of the swing is 0)
            </label>
            <p className="text-xs text-ink-faint">
              The level of the latest zig-zag swing on each alert timeframe — the same
              swing the Auto fib retracement indicator draws with these settings. It
              moves when a new swing confirms, as the indicator does.
            </p>
          </>
        ) : kind === "sr_zone" ? (
          <Row label="Side">
            <select value={srSide} onChange={(e) => setSrSide(e.target.value as SrSide)} className={box}>
              <option value="support">Nearest support below price</option>
              <option value="resistance">Nearest resistance above price</option>
              <option value="either">Whichever is nearer</option>
            </select>
          </Row>
        ) : kind !== "pivot_level" ? null : (
          <>
            <Row label="Type">
              <select value={pivotType} onChange={(e) => setPivotType(e.target.value as PivotType)} className={box}>
                {["Fibonacci", "Traditional", "Classic", "Woodie", "Camarilla"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </Row>
            <Row label="Level">
              <select value={levelName} onChange={(e) => setLevelName(e.target.value)} className={box}>
                {(pivotType === "Fibonacci" ? FIB_LEVELS : [
                  "any", "P", "R1", "S1", "R2", "S2", "R3", "S3", "R4", "S4", "R5", "S5",
                ]).map((l) => (
                  <option key={l} value={l}>{l === "any" ? "Whichever is nearest" : l}</option>
                ))}
              </select>
            </Row>
            <Row label="Pivots from">
              <select value={anchor} onChange={(e) => setAnchor(e.target.value as Interval)} className={box}>
                {ANCHORS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Row>
          </>
        )}

        <div className="my-1 border-t border-border" />

        <ResolutionNotice notice={resolutionNotice}
          using={timeframes.join(", ") || defaultTimeframe} />
        <div className="text-sm text-ink-muted">Timeframes</div>
        <div className="flex flex-wrap gap-1.5">
          {TIMEFRAMES.map((tf) => {
            const on = timeframes.includes(tf);
            return (
              <button
                key={tf}
                type="button"
                onClick={() => toggleTf(tf)}
                className="tvc-control rounded-md border border-control-border px-3 py-1.5
                  text-sm text-ink-muted hover:text-ink"
                aria-pressed={on}
              >
                {tf}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-ink-faint">
          One alert is created per timeframe, and each notification names the timeframe it fired on.
        </p>

        <AlertScopeField
          symbol={symbol}
          timeframes={timeframes}
          armed={armed}
          value={scope.scope}
          onChange={setScope}
          sameAlert={sameAlert}
        />

        <div className="my-1 border-t border-border" />

        <Row label="Condition">
          <select value={mode} onChange={(e) => setMode(e.target.value as MaAlertMode)} className={box}>
            {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Row>

        {isNear && (
          <>
            <Row label="Band">
              <div className="flex items-center gap-2">
                <input type="number" step="0.05" min="0" value={nearMinPct}
                  onChange={(e) => setNearMinPct(parseFloat(e.target.value || "0"))} className={box} />
                <span className="text-sm text-ink-faint">to</span>
                <input type="number" step="0.05" min="0" value={nearMaxPct}
                  onChange={(e) => setNearMaxPct(parseFloat(e.target.value || "0"))} className={box} />
                <span className="text-sm text-ink-muted">%</span>
              </div>
            </Row>
            <p className="pl-[132px] text-xs text-ink-faint">
              Notify while price is {nearMinPct}–{nearMaxPct}%{" "}
              {mode === "near_above" ? "above" : "below"} the level — approaching it, not touching it.
            </p>
          </>
        )}

        <div className="my-1 border-t border-border" />

        <AlertFiltersField value={filters} onChange={setFilters} />

        <div className="my-1 border-t border-border" />

        <AlertNoteField value={note} onChange={setNote} />

        <AlertArmedField value={armed} onChange={setArmed} />

        <FrequencyField value={frequency} onChange={setFrequency} timeframe={timeframes[0] ?? defaultTimeframe} />

        <Row label="Cooldown">
          <div className="flex items-center gap-2">
            <input type="number" min="0" step="5" value={cooldownMin}
              onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))} className={box} />
            <span className="whitespace-nowrap text-sm text-ink-muted">minutes</span>
          </div>
        </Row>

        {err && <p className="text-sm text-down" title={err.detail || undefined}>{err.headline}</p>}
      </div>
    </Modal>
  );
}

/**
 * A labelled row. Declared at MODULE level, never inside the dialog: a
 * component created during render is a new type on every render, so React
 * remounted this row — and the focused <input> inside it — on each keystroke.
 * Typing "30" landed "3" and dropped the caret. `alertInputsKeepFocus.test.tsx`.
 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <span className="text-sm text-ink-muted">{label}</span>
      {children}
    </div>
  );
}
