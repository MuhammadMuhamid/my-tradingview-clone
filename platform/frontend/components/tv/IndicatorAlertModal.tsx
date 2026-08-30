"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { FrequencyField } from "@/components/tv/FrequencyField";
import {
  api, MACD_DEFAULTS, RSI_DEFAULTS,
  type AlertFrequency, type MacdTarget, type RsiTarget,
} from "@/lib/api";
import type { Interval } from "@/lib/types";

/** The timeframes a level or oscillator alert can be armed on in one pass. */
const TIMEFRAMES: Interval[] = ["5m", "15m", "1h", "4h"];

export type IndicatorKind = "rsi" | "macd";

/**
 * Arming an RSI or MACD alert.
 *
 * Both families cross an oscillator rather than a price, so this dialog offers
 * only `cross_up`/`cross_down` — there is no "touch" or percentage band to
 * offer, and showing one would imply the alert could do something it cannot.
 */
export function IndicatorAlertModal({
  open, onClose, symbol, defaultTimeframe, kind, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  defaultTimeframe: Interval;
  kind: IndicatorKind;
  onSaved: (message: string) => void;
}) {
  const [timeframes, setTimeframes] = useState<Interval[]>([defaultTimeframe]);
  const [direction, setDirection] = useState<"cross_up" | "cross_down">("cross_up");

  const [rsiLength, setRsiLength] = useState<number>(RSI_DEFAULTS.length);
  const [rsiTarget, setRsiTarget] = useState<RsiTarget>("level");
  const [rsiLevel, setRsiLevel] = useState<number>(RSI_DEFAULTS.level);
  const [rsiMaLength, setRsiMaLength] = useState<number>(RSI_DEFAULTS.maLength);

  const [macdFast, setMacdFast] = useState<number>(MACD_DEFAULTS.fast);
  const [macdSlow, setMacdSlow] = useState<number>(MACD_DEFAULTS.slow);
  const [macdSignal, setMacdSignal] = useState<number>(MACD_DEFAULTS.signal);
  const [macdTarget, setMacdTarget] = useState<MacdTarget>("signal");

  const [frequency, setFrequency] = useState<AlertFrequency>("once_per_bar_close");
  const [cooldownMin, setCooldownMin] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setTimeframes([defaultTimeframe]); setErr(null); }
  }, [open, defaultTimeframe, kind]);

  const toggleTf = (tf: Interval): void =>
    setTimeframes((prev) =>
      prev.includes(tf) ? prev.filter((t) => t !== tf) : [...prev, tf]
    );

  const save = async (): Promise<void> => {
    if (timeframes.length === 0) { setErr("Pick at least one timeframe"); return; }
    // Refused here as well as by the server, so the user is told before the
    // round trip rather than by a 400 they did not expect.
    if (kind === "rsi" && rsiTarget === "level" && !(rsiLevel > 0 && rsiLevel < 100)) {
      setErr("RSI level must be between 0 and 100 — the oscillator cannot leave that range");
      return;
    }
    if (kind === "macd" && macdFast >= macdSlow) {
      setErr("Fast length must be below slow length, or the oscillator's sign inverts");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      for (const timeframe of timeframes) {
        await api.createMaAlert({
          symbol, timeframe, conditionKind: kind, mode: direction,
          frequency, cooldownMin,
          ...(kind === "rsi"
            ? { rsiLength, target: rsiTarget, rsiLevel, rsiMaLength }
            : { macdFast, macdSlow, macdSignal, target: macdTarget }),
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

  /** The sentence the alert will actually watch for, echoed back before saving. */
  const summary = kind === "rsi"
    ? `RSI ${rsiLength} crosses ${direction === "cross_up" ? "above" : "below"} ` +
      (rsiTarget === "level" ? `${rsiLevel}` : `its SMA ${rsiMaLength}`)
    : `MACD crosses ${direction === "cross_up" ? "above" : "below"} ` +
      (macdTarget === "zero" ? "zero" : "the signal line");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <>
          {kind === "rsi" ? "RSI" : "MACD"} alert on <span className="text-accent">{symbol}</span>
        </>
      }
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
        {kind === "rsi" ? (
          <>
            <Row label="RSI length">
              <input type="number" min="1" max="1000" value={rsiLength}
                onChange={(e) => setRsiLength(parseInt(e.target.value || "0", 10))} className={box} />
            </Row>
            <Row label="Crosses">
              <select
                value={rsiTarget}
                onChange={(e) => setRsiTarget(e.target.value as RsiTarget)}
                className={box}
              >
                <option value="level">A fixed level</option>
                <option value="sma">Its own SMA</option>
              </select>
            </Row>
            {rsiTarget === "level" ? (
              <Row label="Level">
                <input type="number" min="1" max="99" step="1" value={rsiLevel}
                  onChange={(e) => setRsiLevel(parseFloat(e.target.value || "0"))} className={box} />
              </Row>
            ) : (
              <Row label="SMA length">
                <input type="number" min="1" max="1000" value={rsiMaLength}
                  onChange={(e) => setRsiMaLength(parseInt(e.target.value || "0", 10))} className={box} />
              </Row>
            )}
          </>
        ) : (
          <>
            <Row label="Crosses">
              <select
                value={macdTarget}
                onChange={(e) => setMacdTarget(e.target.value as MacdTarget)}
                className={box}
              >
                <option value="signal">The signal line</option>
                <option value="zero">The zero line</option>
              </select>
            </Row>
            <Row label="Lengths">
              <div className="flex items-center gap-2">
                <input type="number" min="1" value={macdFast} aria-label="Fast length"
                  onChange={(e) => setMacdFast(parseInt(e.target.value || "0", 10))} className={box} />
                <input type="number" min="1" value={macdSlow} aria-label="Slow length"
                  onChange={(e) => setMacdSlow(parseInt(e.target.value || "0", 10))} className={box} />
                <input type="number" min="1" value={macdSignal} aria-label="Signal length"
                  onChange={(e) => setMacdSignal(parseInt(e.target.value || "0", 10))} className={box} />
              </div>
            </Row>
            <p className="pl-[132px] text-xs text-ink-faint">fast · slow · signal</p>
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

        <Row label="Direction">
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
            className={box}
          >
            <option value="cross_up">Crosses above</option>
            <option value="cross_down">Crosses below</option>
          </select>
        </Row>

        <p className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-xs text-ink-muted">
          Notify when <span className="text-ink">{summary}</span>.
          {" "}A cross needs a previous bar to compare against, so this stays quiet
          until the oscillator actually moves across the line — it will not fire
          just because it is already on one side.
        </p>

        <FrequencyField
          value={frequency}
          onChange={setFrequency}
          timeframe={timeframes[0] ?? defaultTimeframe}
        />

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
