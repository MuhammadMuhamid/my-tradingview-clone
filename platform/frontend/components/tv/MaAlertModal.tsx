"use client";
import { useEffect, useState } from "react";
import { ResolutionNotice } from "@/components/tv/ResolutionNotice";
import { Modal } from "@/components/Modal";
import { Button, Dropdown, FIELD } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import { AlertNoteField } from "@/components/tv/AlertNoteField";
import { AlertArmedField } from "@/components/tv/AlertArmedField";
import {
  AlertFiltersField, emptyFilters, filtersFromAlert, filterRequest, filterRequestForEdit,
  type AlertFilterState,
} from "@/components/tv/AlertFiltersField";
import {
  api, DEFAULT_ALERT_FREQUENCY,
  type AlertFrequency, type MaAlert, type MaAlertMode, type MaType,
} from "@/lib/api";
import { ALERT_INTERVAL_VALUES, type Interval } from "@/lib/types";
import { maColor, maLabel } from "@/lib/movingAverages";
import { displayTicker } from "@/lib/instrument";
import { describeAction, said, type FailureCopy } from "@/lib/errorCopy";

/** Every timeframe the backend supports, in the order the toolbar shows them. */


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
 * The crossover family's subject is a LINE, not the close.
 *
 * `MODE_LABELS`/`MODE_HELP` above all begin "Price …", which is exactly right
 * for `ma`, where the close is what crosses. An `ma_vs_ma` alert evaluates one
 * moving average against another — `evaluateSeriesCross` in the backend says
 * so outright, and `describeCondition` writes the fired notification as
 * "EMA 21 crosses above the SMA 200". Reusing the price wording here would put
 * a sentence on the dialog that the alert it creates then contradicts.
 */
const CROSS_MODES = ["cross_up", "cross_down"] as const;
type CrossMode = (typeof CROSS_MODES)[number];

const isCrossMode = (m: MaAlertMode): m is CrossMode =>
  m === "cross_up" || m === "cross_down";

const crossLabel = (mode: MaAlertMode, fast: string, slow: string): string =>
  `${fast} crosses ${mode === "cross_down" ? "below" : "above"} the ${slow}`;

const crossHelp = (mode: MaAlertMode, fast: string, slow: string): string =>
  `Fires on the bar where the ${fast} finishes ${mode === "cross_down" ? "below" : "above"} `
  + `the ${slow} having finished on the other side of it. The close is not the subject — `
  + `the two lines are.`;

/**
 * Arm one moving-average line. Deliberately one MA per alert: that is what
 * lets the 200 SMA and the 15 SMA on the same chart carry different
 * conditions, different timeframes and different cooldowns.
 */
export function MaAlertModal({
  open, onClose, symbol, chartTimeframe, resolutionNotice = null, maType, maLength, existing,
  onSaved,
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
  maType: MaType;
  maLength: number;
  /** Alerts already armed on this exact line, so the dialog can edit instead of duplicate. */
  existing: MaAlert[];
  onSaved: (message: string) => void;
}) {
  const [mode, setMode] = useState<MaAlertMode>("touch");
  const [family, setFamily] = useState<"ma" | "ma_vs_ma">("ma");
  const [ma2Type, setMa2Type] = useState<MaType>("sma");
  const [ma2Length, setMa2Length] = useState(200);
  const [timeframe, setTimeframe] = useState<Interval>(chartTimeframe);
  const [nearMinPct, setNearMinPct] = useState(0.2);
  const [nearMaxPct, setNearMaxPct] = useState(0.5);
  const [cooldownMin, setCooldownMin] = useState(60);
  const [frequency, setFrequency] = useState<AlertFrequency>(DEFAULT_ALERT_FREQUENCY);
  const [filters, setFilters] = useState<AlertFilterState>(emptyFilters);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FailureCopy | null>(null);

  // Reopening on a different line must not inherit the previous line's timeframe.
  useEffect(() => {
    if (open) {
      setTimeframe(chartTimeframe);
      setFamily("ma");
      setMode("touch");
      setMa2Type("sma");
      setMa2Length(Math.max(200, maLength + 1));
      setFilters(emptyFilters());
      setNote("");
      setErr(null);
    }
  }, [open, chartTimeframe, maType, maLength]);

  // Editing rather than creating: load the matching alert's settings.
  const match = existing.find((a) => a.conditionKind === family
    && a.mode === mode && a.timeframe === timeframe
    && (family === "ma" || (a.ma2Type === ma2Type && a.ma2Length === ma2Length))) ?? null;
  useEffect(() => {
    if (match) {
      setNearMinPct(match.nearMinPct);
      setNearMaxPct(match.nearMaxPct);
      setCooldownMin(match.cooldownMin);
      setFrequency(match.frequency);
      // Including whether it is currently armed: an untouched Update on a
      // paused alert used to re-arm it silently.
      setArmed(match.enabled);
      if (match.conditionKind === "ma_vs_ma") {
        setFamily("ma_vs_ma");
        setMa2Type(match.ma2Type ?? "sma");
        setMa2Length(match.ma2Length ?? 200);
      }
      // Saving here upserts, so the dialog must show what the existing alert
      // actually holds — otherwise an untouched Update would silently strip the
      // gates and the note it was armed with.
      setFilters(filtersFromAlert(match));
      setNote(match.note ?? "");
    }
  }, [match?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isNear = family === "ma" && (mode === "near_above" || mode === "near_below");
  const label = maLabel(maType, maLength);

  const slowLabel = maLabel(ma2Type, ma2Length);

  const save = async () => {
    if (isNear && nearMaxPct <= nearMinPct) {
      setErr(said("The far edge of the band must be larger than the near edge."));
      return;
    }
    if (family === "ma_vs_ma") {
      /*
       * The number field can be emptied, which reads back as 0, and the
       * backend's range check is only `Number.isInteger` despite its message
       * naming 1..1000 — so an armed alert on a zero-length average is
       * reachable from here and would simply never fire. Two conditions that
       * cannot happen are refused where the reader can still fix them.
       */
      if (!Number.isInteger(ma2Length) || ma2Length < 1 || ma2Length > 1000) {
        setErr(said("The second moving average needs a length between 1 and 1000."));
        return;
      }
      if (ma2Type === maType && ma2Length === maLength) {
        setErr(said(`${label} cannot cross itself — choose a different second moving average.`));
        return;
      }
    }
    setBusy(true);
    setErr(null);
    try {
      /*
       * Editing goes through PATCH, not the upsert: gates are part of what
       * identifies an alert, so an upsert whose gates just changed would arm a
       * SECOND alert and leave the original behind with the old gates. `match`
       * is found by the condition alone, which is the row being edited.
       */
      const body = {
        symbol, timeframe, conditionKind: family, maType, maLength,
        ...(family === "ma_vs_ma"
          ? {
              ma2Type, ma2Length,
              mode: (mode === "cross_down" ? "cross_down" : "cross_up") as MaAlertMode,
            }
          : { mode }),
        nearMinPct, nearMaxPct, cooldownMin, frequency,
        note: note.trim() || null,
        enabled: armed,
      };
      if (match) {
        await api.updateMaAlert(match.id, { ...body, ...filterRequestForEdit(filters) });
      } else {
        await api.createMaAlert({ ...body, ...filterRequest(filters) });
      }
      onSaved(
        // The condition belongs in the confirmation for both families: "Alert
        // set — BTCUSDT 1h EMA 21" does not say what was armed, and an
        // untouched Update on the wrong row reads identically.
        `${match ? "Updated" : "Alert set"} — ${displayTicker(symbol)} ${timeframe} `
        + (family === "ma_vs_ma"
          ? crossLabel(mode, label, slowLabel)
          : `${label} · ${MODE_LABELS[mode].toLowerCase()}`)
      );
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
      onSaved(`Alert removed — ${displayTicker(symbol)} ${timeframe} ${label}`);
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
      title={
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-5 rounded-sm" style={{ background: maColor(maLength) }} />
          Alert on {label}
          <span>{displayTicker(symbol)}</span>
        </span>
      }
      footer={
        <>
          {match && (
            <Button onClick={remove} disabled={busy} className="mr-auto text-down">Delete</Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="contrast" onClick={save} disabled={busy}>
            {busy ? "Saving…" : match ? "Update" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Row label="Condition">
          {/*
            A native select element renders the OS's own popup — a different
            font, row height and selection colour — which the UI contract
            forbids inside a dialog. These four were the last of them here.
          */}
          <Dropdown
            value={family}
            label="Alert condition family"
            width={180}
            options={[
              { value: "ma", label: "Price versus moving average" },
              { value: "ma_vs_ma", label: "Moving average crossover" },
            ]}
            onChange={(v) => {
              const next = v as "ma" | "ma_vs_ma";
              setFamily(next);
              setMode(next === "ma_vs_ma" ? "cross_up" : "touch");
            }}
          />
        </Row>
        <Row label={family === "ma_vs_ma" ? "Cross" : "Condition"}>
          <Dropdown
            value={mode}
            label={family === "ma_vs_ma" ? "Moving-average crossing direction" : "Price versus moving-average condition"}
            width={180}
            options={(family === "ma_vs_ma"
              ? (CROSS_MODES as readonly MaAlertMode[])
              : (Object.keys(MODE_LABELS) as MaAlertMode[])
            ).map((m) => ({
              value: m,
              label: family === "ma_vs_ma" ? crossLabel(m, label, slowLabel) : MODE_LABELS[m],
            }))}
            onChange={(v) => setMode(v as MaAlertMode)}
          />
        </Row>
        <p className="pl-[122px] text-xs text-ink-faint">
          {family === "ma_vs_ma" && isCrossMode(mode)
            ? crossHelp(mode, label, slowLabel)
            : MODE_HELP[mode]}
        </p>

        {family === "ma_vs_ma" && (
          <Row label="Slow MA">
            <div className="flex items-center gap-2">
              <Dropdown
                value={ma2Type}
                label="Second moving-average type"
                width={92}
                options={[
                  { value: "ema", label: "EMA" },
                  { value: "sma", label: "SMA" },
                ]}
                onChange={(v) => setMa2Type(v as MaType)}
              />
              <input type="number" min={1} max={1000} value={ma2Length}
                onChange={(e) => setMa2Length(parseInt(e.target.value || "0", 10))}
                className={box} aria-label="Second moving-average length" />
            </div>
          </Row>
        )}

        <ResolutionNotice notice={resolutionNotice} using={timeframe} />
        <Row label="Timeframe">
          <Dropdown
            value={timeframe}
            label="Alert timeframe"
            width={180}
            options={ALERT_INTERVAL_VALUES.map((tf) => ({
              value: tf,
              label: `${tf}${resolutionNotice === null && tf === chartTimeframe ? " — same as chart" : ""}`,
            }))}
            onChange={(v) => setTimeframe(v as Interval)}
          />
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
        <AlertFiltersField value={filters} onChange={setFilters} />

        <div className="my-1 border-t border-border" />
        <AlertNoteField value={note} onChange={setNote} />

        <AlertArmedField value={armed} onChange={setArmed} />

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
        {/* accent-is-meaning: this sentence changes what Save will do, so it is
            the dialog talking about its own primary action. */}
        {match && (
          <p className="text-xs text-accent">
            This line already has a {timeframe} alert for that condition; saving updates it.
          </p>
        )}
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
    <div className="grid grid-cols-[110px_1fr] items-center gap-3">
      <span className="text-sm text-ink-muted">{label}</span>
      {children}
    </div>
  );
}
