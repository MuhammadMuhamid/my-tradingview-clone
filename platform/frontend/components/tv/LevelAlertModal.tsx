"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { AlertNoteField } from "@/components/tv/AlertNoteField";
import {
  AlertFiltersField, emptyFilters, filterRequest, type AlertFilterState,
} from "@/components/tv/AlertFiltersField";
import {
  api,
  type AlertFrequency, type MaAlertMode, type PivotType, type SrSide,
} from "@/lib/api";
import type { Interval } from "@/lib/types";

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
  open, onClose, symbol, defaultTimeframe, initialKind = "sr_zone", onSaved,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  defaultTimeframe: Interval;
  /** Which of the two level families to open on, when the caller already knows. */
  initialKind?: "sr_zone" | "pivot_level";
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

  const [frequency, setFrequency] = useState<AlertFrequency>("once_per_bar_close");
  const [cooldownMin, setCooldownMin] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    if (timeframes.length === 0) { setErr("Pick at least one timeframe."); return; }
    if (isNear && nearMaxPct <= nearMinPct) {
      setErr("The far edge of the band must be larger than the near edge.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // One alert per timeframe. The notification names the timeframe it fired
      // on, which is only meaningful if each timeframe is its own alert.
      for (const timeframe of timeframes) {
        await api.createMaAlert({
          symbol, timeframe, conditionKind: kind, mode,
          nearMinPct, nearMaxPct, frequency, cooldownMin,
          ...(kind === "sr_zone"
            ? { srSide }
            : { pivotType, levelName, anchor }),
          // Only the enabled gates are sent; an omitted one means "no gate",
          // which is what every alert created before this feature has.
          ...filterRequest(filters),
          note: note.trim() || null,
        });
      }
      onSaved(
        `${timeframes.length} alert${timeframes.length === 1 ? "" : "s"} armed on ${symbol} · ` +
        `${timeframes.join(", ")}`
      );
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const box = "w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent";
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
      title={<>Level alert on <span className="text-accent">{symbol}</span></>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
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

        <div className="text-sm text-ink-muted">Timeframes</div>
        <div className="flex flex-wrap gap-1.5">
          {TIMEFRAMES.map((tf) => {
            const on = timeframes.includes(tf);
            return (
              <button
                key={tf}
                type="button"
                onClick={() => toggleTf(tf)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  on ? "border-accent bg-accent/15 text-accent" : "border-border text-ink-muted hover:text-ink"
                }`}
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

        <FrequencyField value={frequency} onChange={setFrequency} timeframe={timeframes[0] ?? defaultTimeframe} />

        <Row label="Cooldown">
          <div className="flex items-center gap-2">
            <input type="number" min="0" step="5" value={cooldownMin}
              onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))} className={box} />
            <span className="whitespace-nowrap text-sm text-ink-muted">minutes</span>
          </div>
        </Row>

        {err && <p className="text-sm text-down">{err}</p>}
      </div>
    </Modal>
  );
}
