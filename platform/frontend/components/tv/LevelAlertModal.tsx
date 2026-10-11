"use client";
import { useEffect, useState } from "react";
import { ResolutionNotice } from "@/components/tv/ResolutionNotice";
import { Modal } from "@/components/Modal";
import { Button, FIELD } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { AlertNoteField } from "@/components/tv/AlertNoteField";
import { AlertArmedField } from "@/components/tv/AlertArmedField";
import {
  AlertFiltersField, emptyFilters, filterRequest, filterRequestForEdit,
  type AlertFilterState,
} from "@/components/tv/AlertFiltersField";
import {
  api,
  type AlertFrequency, type MaAlert, type MaAlertMode, type PivotType, type SrSide,
} from "@/lib/api";
import type { Interval } from "@/lib/types";
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
  /** Which of the two level families to open on, when the caller already knows. */
  initialKind?: "sr_zone" | "pivot_level";
  /** The alerts already on this symbol, so Save cannot silently re-arm one. */
  existing?: readonly MaAlert[];
  onSaved: (message: string) => void;
}) {
  const [kind, setKind] = useState<"sr_zone" | "pivot_level">(initialKind);
  const [timeframes, setTimeframes] = useState<Interval[]>([defaultTimeframe]);
  const [srSide, setSrSide] = useState<SrSide>("support");
  const [pivotType, setPivotType] = useState<PivotType>("Fibonacci");
  const [levelName, setLevelName] = useState("any");
  const [anchor, setAnchor] = useState<Interval>("1d");
  const [mode, setMode] = useState<MaAlertMode>("near_above");
  const [nearMinPct, setNearMinPct] = useState(0.2);
  const [nearMaxPct, setNearMaxPct] = useState(0.5);
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
  const matches = existing.filter((a) =>
    a.conditionKind === kind
    && a.mode === mode
    && timeframes.includes(a.timeframe)
    && (kind === "sr_zone" ? a.srSide === srSide : a.pivotLevelName === levelName));
  const matchedArmed = matches.length > 0 && matches.every((a) => a.enabled === matches[0]!.enabled)
    ? matches[0]!.enabled : null;

  const [frequency, setFrequency] = useState<AlertFrequency>("once_per_bar_close");
  const [cooldownMin, setCooldownMin] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FailureCopy | null>(null);

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
    }
  }, [open, defaultTimeframe, initialKind]);

  const isNear = mode === "near_above" || mode === "near_below";
  const toggleTf = (tf: Interval): void =>
    setTimeframes((cur) => cur.includes(tf) ? cur.filter((t) => t !== tf) : [...cur, tf]);

  const save = async () => {
    if (timeframes.length === 0) { setErr(said("Pick at least one timeframe.")); return; }
    if (isNear && nearMaxPct <= nearMinPct) {
      setErr(said("The far edge of the band must be larger than the near edge."));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // One alert per timeframe. The notification names the timeframe it fired
      // on, which is only meaningful if each timeframe is its own alert.
      for (const timeframe of timeframes) {
        const body = {
          symbol, timeframe, conditionKind: kind, mode,
          nearMinPct, nearMaxPct, frequency, cooldownMin,
          ...(kind === "sr_zone"
            ? { srSide }
            : { pivotType, levelName, anchor }),
          note: note.trim() || null,
          enabled: armed,
        };
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
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <span className="text-sm text-ink-muted">{label}</span>
      {children}
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<>Level alert on {displayTicker(symbol)}</>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="contrast" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : `Create ${timeframes.length || ""}`}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Row label="Watch">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={box}>
            <option value="sr_zone">Support / resistance zones</option>
            <option value="pivot_level">Pivot points</option>
          </select>
        </Row>

        {kind === "sr_zone" ? (
          <Row label="Side">
            <select value={srSide} onChange={(e) => setSrSide(e.target.value as SrSide)} className={box}>
              <option value="support">Nearest support below price</option>
              <option value="resistance">Nearest resistance above price</option>
              <option value="either">Whichever is nearer</option>
            </select>
          </Row>
        ) : (
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

        <div className="my-1 border-t border-border" />

        <Row label="Condition">
          <select value={mode} onChange={(e) => setMode(e.target.value as MaAlertMode)} className={box}>
            {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
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
