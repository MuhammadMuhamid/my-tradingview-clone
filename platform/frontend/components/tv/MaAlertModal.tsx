"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import {
  api, DEFAULT_ALERT_FREQUENCY,
  type AlertFrequency, type MaAlert, type MaAlertMode, type MaType,
} from "@/lib/api";
import type { Interval } from "@/lib/types";
import { maColor, maLabel } from "@/lib/movingAverages";

/** Every timeframe the backend supports, in the order the toolbar shows them. */
const INTERVALS: Interval[] = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"];

const MODE_LABELS: Record<MaAlertMode, string> = {
  touch: "Price touches the line",
  cross_up: "Price crosses above the line",
  cross_down: "Price crosses below the line",
  near_above: "Price comes near, just above the line",
  near_below: "Price comes near, just below the line",
};

const MODE_HELP: Record<MaAlertMode, string> = {
  touch: "Fires when the candle's range reaches the line — the wick is enough.",
  cross_up: "Fires when a candle closes above the line after closing below it.",
  cross_down: "Fires when a candle closes below the line after closing above it.",
  near_above: "Fires while the close sits inside the band above the line, without reaching it — the approach warning.",
  near_below: "Fires while the close sits inside the band below the line, without reaching it.",
};

/**
 * Arm one moving-average line. Deliberately one MA per alert: that is what
 * lets the 200 SMA and the 15 SMA on the same chart carry different
 * conditions, different timeframes and different cooldowns.
 */
export function MaAlertModal({
  open, onClose, symbol, chartTimeframe, maType, maLength, existing, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  chartTimeframe: Interval;
  maType: MaType;
  maLength: number;
  /** Alerts already armed on this exact line, so the dialog can edit instead of duplicate. */
  existing: MaAlert[];
  onSaved: (message: string) => void;
}) {
  const [mode, setMode] = useState<MaAlertMode>("touch");
  const [timeframe, setTimeframe] = useState<Interval>(chartTimeframe);
  const [nearMinPct, setNearMinPct] = useState(0.2);
  const [nearMaxPct, setNearMaxPct] = useState(0.5);
  const [cooldownMin, setCooldownMin] = useState(60);
  const [frequency, setFrequency] = useState<AlertFrequency>(DEFAULT_ALERT_FREQUENCY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reopening on a different line must not inherit the previous line's timeframe.
  useEffect(() => {
    if (open) { setTimeframe(chartTimeframe); setErr(null); }
  }, [open, chartTimeframe, maType, maLength]);

  // Editing rather than creating: load the matching alert's settings.
  const match = existing.find((a) => a.mode === mode && a.timeframe === timeframe) ?? null;
  useEffect(() => {
    if (match) {
      setNearMinPct(match.nearMinPct);
      setNearMaxPct(match.nearMaxPct);
      setCooldownMin(match.cooldownMin);
      setFrequency(match.frequency);
    }
  }, [match?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isNear = mode === "near_above" || mode === "near_below";
  const label = maLabel(maType, maLength);

  const save = async () => {
    if (isNear && nearMaxPct <= nearMinPct) {
      setErr("The far edge of the band must be larger than the near edge.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createMaAlert({
        symbol, timeframe, conditionKind: "ma", maType, maLength, mode,
        nearMinPct, nearMaxPct, cooldownMin, frequency,
      });
      onSaved(
        `${match ? "Updated" : "Alert set"} — ${symbol} ${timeframe} ${label} · ${MODE_LABELS[mode].toLowerCase()}`
      );
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
      onSaved(`Alert removed — ${symbol} ${timeframe} ${label}`);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const box = "w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-ink outline-none focus:border-accent";
  const Row = ({ label: l, children }: { label: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[110px_1fr] items-center gap-3">
      <span className="text-sm text-ink-muted">{l}</span>
      {children}
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-5 rounded-sm" style={{ background: maColor(maLength) }} />
          Alert on {label}
          <span className="text-accent">{symbol}</span>
        </span>
      }
      footer={
        <>
          {match && (
            <Button onClick={remove} disabled={busy} className="mr-auto text-down">Delete</Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : match ? "Update" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Row label="Condition">
          <select value={mode} onChange={(e) => setMode(e.target.value as MaAlertMode)} className={box}>
            {(Object.keys(MODE_LABELS) as MaAlertMode[]).map((m) => (
              <option key={m} value={m}>{MODE_LABELS[m]}</option>
            ))}
          </select>
        </Row>
        <p className="pl-[122px] text-xs text-ink-faint">{MODE_HELP[mode]}</p>

        <Row label="Timeframe">
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Interval)} className={box}>
            {INTERVALS.map((tf) => (
              <option key={tf} value={tf}>
                {tf}{tf === chartTimeframe ? " — same as chart" : ""}
              </option>
            ))}
          </select>
        </Row>

        {isNear && (
          <>
            <div className="my-1 border-t border-border" />
            <Row label="Band">
              <div className="flex items-center gap-2">
                <input type="number" step="0.05" min="0" value={nearMinPct}
                  onChange={(e) => setNearMinPct(parseFloat(e.target.value || "0"))}
                  className={box} />
                <span className="text-sm text-ink-faint">to</span>
                <input type="number" step="0.05" min="0" value={nearMaxPct}
                  onChange={(e) => setNearMaxPct(parseFloat(e.target.value || "0"))}
                  className={box} />
                <span className="text-sm text-ink-muted">%</span>
              </div>
            </Row>
            <p className="pl-[122px] text-xs text-ink-faint">
              Notify while price is {nearMinPct}–{nearMaxPct}%{" "}
              {mode === "near_above" ? "above" : "below"} the {label} — approaching it, not touching it.
            </p>
          </>
        )}

        <div className="my-1 border-t border-border" />
        <FrequencyField value={frequency} onChange={setFrequency} timeframe={timeframe} />

        {/* The cooldown throttles the bar-close mode only. The other three have
            their own cap — a candle, a minute, or a single fire — and stacking a
            60-minute silence on top of "once per bar" at 15m would quietly
            defeat the mode the user just chose. */}
        {frequency === "once_per_bar_close" && (
          <>
            <Row label="Cooldown">
              <div className="flex items-center gap-2">
                <input type="number" min="0" step="5" value={cooldownMin}
                  onChange={(e) => setCooldownMin(parseInt(e.target.value || "0", 10))}
                  className={box} />
                <span className="whitespace-nowrap text-sm text-ink-muted">minutes</span>
              </div>
            </Row>
            <p className="pl-[122px] text-xs text-ink-faint">
              Silence after a fire, so a slow approach is not re-announced on every closing bar. 0 = notify on every qualifying bar.
            </p>
          </>
        )}

        <p className="pt-1 text-xs text-ink-faint">
          Evaluated server-side on {timeframe} candles and pushed to every device you have
          enabled notifications on — the chart does not need to be open.
        </p>
        {match && (
          <p className="text-xs text-accent">
            This line already has a {timeframe} alert for that condition; saving updates it.
          </p>
        )}
        {err && <p className="text-sm text-down">{err}</p>}
      </div>
    </Modal>
  );
}
