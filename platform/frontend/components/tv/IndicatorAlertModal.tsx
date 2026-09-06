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
  api, ADX_DEFAULTS, BOLLINGER_DEFAULTS, MACD_DEFAULTS, RSI_DEFAULTS,
  STOCHASTIC_DEFAULTS, SUPERTREND_DEFAULTS,
  type AlertFrequency, type BollingerBand, type MacdTarget, type MaAlertMode,
  type RsiTarget, type StAtrMethod, type StochasticTarget,
} from "@/lib/api";
import type { Interval } from "@/lib/types";

/** The timeframes a level or oscillator alert can be armed on in one pass. */
const TIMEFRAMES: Interval[] = ["5m", "15m", "1h", "4h"];

export type IndicatorKind =
  | "rsi" | "macd" | "supertrend" | "bollinger" | "stochastic" | "adx";

/** The title and the two direction words each family reads naturally with. */
const COPY: Record<IndicatorKind, { title: string; up: string; down: string }> = {
  rsi: { title: "RSI", up: "Crosses above", down: "Crosses below" },
  macd: { title: "MACD", up: "Crosses above", down: "Crosses below" },
  // Supertrend does not cross anything — it changes direction. Offering
  // "crosses above" here would describe an event this alert does not watch.
  supertrend: { title: "Supertrend", up: "Flips up (Buy)", down: "Flips down (Sell)" },
  stochastic: { title: "Stochastic", up: "Crosses above", down: "Crosses below" },
  // ADX has no direction of its own: it measures how strong a trend is, not
  // which way it points. "Rises through" says that; "crosses above" invites the
  // reader to think the alert is bullish, which it is not.
  adx: { title: "ADX", up: "Rises through", down: "Falls through" },
  // A Bollinger band is a PRICE line, so this family takes the same
  // touch/cross/near vocabulary the moving-average and level families use
  // rather than the two-direction one the oscillators take.
  bollinger: { title: "Bollinger band", up: "Crosses above", down: "Crosses below" },
};

/** The families whose event is a price meeting a line, not a value crossing one. */
const PRICE_LINE_KINDS: readonly IndicatorKind[] = ["bollinger"];

/**
 * Arming an RSI, MACD or Supertrend alert.
 *
 * All three watch an indicator rather than a price, so this dialog offers only
 * the two directions — there is no "touch" or percentage band to offer, and
 * showing one would imply the alert could do something it cannot.
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

  const [stPeriod, setStPeriod] = useState<number>(SUPERTREND_DEFAULTS.period);
  const [stMultiplier, setStMultiplier] = useState<number>(SUPERTREND_DEFAULTS.multiplier);
  const [stAtrMethod, setStAtrMethod] = useState<StAtrMethod>(SUPERTREND_DEFAULTS.atrMethod);

  const [bbLength, setBbLength] = useState<number>(BOLLINGER_DEFAULTS.length);
  const [bbMult, setBbMult] = useState<number>(BOLLINGER_DEFAULTS.mult);
  const [bbBand, setBbBand] = useState<BollingerBand>(BOLLINGER_DEFAULTS.band);
  const [bbMaType, setBbMaType] = useState<"sma" | "ema">(BOLLINGER_DEFAULTS.maType);
  /** The full level vocabulary, because a band is a moving price line. */
  const [bbMode, setBbMode] = useState<MaAlertMode>("touch");
  /*
   * The approach band, in percent. Only the two `near_*` modes read it, and
   * only Bollinger among the families here offers those — but it was not
   * settable at all, so every "just above the band" alert was pinned to the
   * server's 0.2–0.5 % default whatever the user meant by "just".
   */
  const [nearMinPct, setNearMinPct] = useState<number>(0.2);
  const [nearMaxPct, setNearMaxPct] = useState<number>(0.5);

  const [stochKLength, setStochKLength] = useState<number>(STOCHASTIC_DEFAULTS.kLength);
  const [stochKSmooth, setStochKSmooth] = useState<number>(STOCHASTIC_DEFAULTS.kSmooth);
  const [stochDSmooth, setStochDSmooth] = useState<number>(STOCHASTIC_DEFAULTS.dSmooth);
  const [stochTarget, setStochTarget] = useState<StochasticTarget>("signal");
  const [stochLevel, setStochLevel] = useState<number>(STOCHASTIC_DEFAULTS.level);

  const [adxDiLength, setAdxDiLength] = useState<number>(ADX_DEFAULTS.diLength);
  const [adxSmoothing, setAdxSmoothing] = useState<number>(ADX_DEFAULTS.smoothing);
  const [adxLevel, setAdxLevel] = useState<number>(ADX_DEFAULTS.level);

  const [filters, setFilters] = useState<AlertFilterState>(emptyFilters);
  const [note, setNote] = useState("");

  const [frequency, setFrequency] = useState<AlertFrequency>("once_per_bar_close");
  const [cooldownMin, setCooldownMin] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setTimeframes([defaultTimeframe]); setNote(""); setErr(null); }
  }, [open, defaultTimeframe, kind]);

  const toggleTf = (tf: Interval): void =>
    setTimeframes((prev) =>
      prev.includes(tf) ? prev.filter((t) => t !== tf) : [...prev, tf]
    );

  /**
   * The mode this modal will actually arm.
   *
   * A price-line family carries the level vocabulary; every other family here
   * watches a crossing. Same expression the save uses, so the summary sentence
   * cannot describe a different alert to the one that is stored.
   */
  const armedMode: MaAlertMode = PRICE_LINE_KINDS.includes(kind) ? bbMode : direction;

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
    // At or below zero the two bands collapse onto the midpoint or swap, so the
    // trend would flip on nearly every bar; far above, it never flips at all.
    if (kind === "supertrend" && !(stMultiplier > 0 && stMultiplier <= 100)) {
      setErr("The ATR multiplier must be greater than 0 and at most 100");
      return;
    }
    // A window of one has no deviation, so both bands sit exactly on the basis
    // and every "touch" would be a touch.
    if (kind === "bollinger" && !(Number.isInteger(bbLength) && bbLength >= 2)) {
      setErr("The Bollinger length must be a whole number of at least 2");
      return;
    }
    if (kind === "bollinger" && (bbMode === "near_above" || bbMode === "near_below")
        && !(nearMaxPct > nearMinPct && nearMinPct >= 0)) {
      setErr("The far edge of the band must be larger than the near edge");
      return;
    }
    if (kind === "bollinger" && !(bbMult > 0 && bbMult <= 100)) {
      setErr("The standard-deviation multiplier must be greater than 0 and at most 100");
      return;
    }
    if (kind === "stochastic" && stochTarget === "level"
        && !(stochLevel > 0 && stochLevel < 100)) {
      setErr("The level must be between 0 and 100 — the oscillator cannot leave that range");
      return;
    }
    if (kind === "adx" && !(adxLevel > 0 && adxLevel < 100)) {
      setErr("The ADX threshold must be between 0 and 100 — the index cannot leave that range");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      for (const timeframe of timeframes) {
        await api.createMaAlert({
          symbol, timeframe, conditionKind: kind,
          mode: armedMode,
          frequency, cooldownMin,
          ...(kind === "rsi"
            ? { rsiLength, target: rsiTarget, rsiLevel, rsiMaLength }
            : kind === "macd"
              ? { macdFast, macdSlow, macdSignal, target: macdTarget }
              : kind === "bollinger"
                ? {
                    bbLength, bbMult, bbBand, bbMaType,
                    // Only the two approach modes read the band; sending it
                    // otherwise would store a width nothing consults.
                    ...(bbMode === "near_above" || bbMode === "near_below"
                      ? { nearMinPct, nearMaxPct } : {}),
                  }
                : kind === "stochastic"
                  ? {
                      stochKLength, stochKSmooth, stochDSmooth,
                      target: stochTarget, stochLevel,
                    }
                  : kind === "adx"
                    ? { adxDiLength, adxSmoothing, adxLevel }
                    : { stPeriod, stMultiplier, stAtrMethod }),
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

  /** The sentence the alert will actually watch for, echoed back before saving. */
  const bandName = bbBand === "basis" ? "Bollinger basis" : `${bbBand} Bollinger band`;
  const summary = kind === "bollinger"
    ? `price ${
        bbMode === "touch" ? "touches" :
        bbMode === "cross_up" ? "crosses above" :
        bbMode === "cross_down" ? "crosses below" :
        bbMode === "near_above" ? "sits just above" : "sits just below"
      } the ${bandName} (${bbLength}, ${bbMult})`
    : kind === "stochastic"
    ? `Stochastic %K crosses ${direction === "cross_up" ? "above" : "below"} ` +
      (stochTarget === "level" ? `${stochLevel}` : "its %D")
    : kind === "adx"
    ? `ADX ${direction === "cross_up" ? "rises through" : "falls through"} ${adxLevel}`
    : kind === "rsi"
    ? `RSI ${rsiLength} crosses ${direction === "cross_up" ? "above" : "below"} ` +
      (rsiTarget === "level" ? `${rsiLevel}` : `its SMA ${rsiMaLength}`)
    : kind === "macd"
      ? `MACD crosses ${direction === "cross_up" ? "above" : "below"} ` +
        (macdTarget === "zero" ? "zero" : "the signal line")
      : `the Supertrend (${stPeriod}, ${stMultiplier}) flips ` +
        `${direction === "cross_up" ? "up" : "down"}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <>
          {COPY[kind].title} alert on <span className="text-accent">{symbol}</span>
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
        ) : kind === "bollinger" ? (
          <>
            <Row label="Band">
              <select value={bbBand} onChange={(e) => setBbBand(e.target.value as BollingerBand)}
                className={box}>
                <option value="upper">Upper band</option>
                <option value="basis">Basis (the middle line)</option>
                <option value="lower">Lower band</option>
              </select>
            </Row>
            <Row label="Event">
              <select value={bbMode} onChange={(e) => setBbMode(e.target.value as MaAlertMode)}
                className={box}>
                <option value="touch">Price touches the band</option>
                <option value="cross_up">Price crosses above the band</option>
                <option value="cross_down">Price crosses below the band</option>
                <option value="near_above">Price is just above the band</option>
                <option value="near_below">Price is just below the band</option>
              </select>
            </Row>
            <Row label="Length">
              <input type="number" min="2" max="1000" value={bbLength}
                onChange={(e) => setBbLength(parseInt(e.target.value || "0", 10))} className={box} />
            </Row>
            <Row label="Std dev">
              <input type="number" min="0.1" max="100" step="0.1" value={bbMult}
                onChange={(e) => setBbMult(parseFloat(e.target.value || "0"))} className={box} />
            </Row>
            {(bbMode === "near_above" || bbMode === "near_below") && (
              <Row label="Band width">
                <div className="flex items-center gap-2">
                  <input type="number" min="0" step="0.05" value={nearMinPct}
                    aria-label="Near band inner edge, percent"
                    onChange={(e) => setNearMinPct(parseFloat(e.target.value || "0"))}
                    className={box} />
                  <span className="text-sm text-ink-faint">to</span>
                  <input type="number" min="0" step="0.05" value={nearMaxPct}
                    aria-label="Near band outer edge, percent"
                    onChange={(e) => setNearMaxPct(parseFloat(e.target.value || "0"))}
                    className={box} />
                  <span className="text-sm text-ink-muted">%</span>
                </div>
              </Row>
            )}
            <Row label="Basis type">
              <select value={bbMaType} onChange={(e) => setBbMaType(e.target.value as "sma" | "ema")}
                className={box}>
                <option value="sma">SMA (default)</option>
                <option value="ema">EMA</option>
              </select>
            </Row>
            <p className="pl-[132px] text-xs text-ink-faint">
              The study&apos;s own defaults are 20 and 2. These inputs decide where
              the band sits, so an alert armed on different ones watches a
              different line from the one on your chart.
            </p>
          </>
        ) : kind === "stochastic" ? (
          <>
            <Row label="Crosses">
              <select value={stochTarget}
                onChange={(e) => setStochTarget(e.target.value as StochasticTarget)}
                className={box}>
                <option value="signal">Its own %D</option>
                <option value="level">A fixed level</option>
              </select>
            </Row>
            {stochTarget === "level" && (
              <Row label="Level">
                <input type="number" min="1" max="99" step="1" value={stochLevel}
                  onChange={(e) => setStochLevel(parseFloat(e.target.value || "0"))} className={box} />
              </Row>
            )}
            <Row label="Lengths">
              <div className="flex items-center gap-2">
                <input type="number" min="1" value={stochKLength} aria-label="%K length"
                  onChange={(e) => setStochKLength(parseInt(e.target.value || "0", 10))} className={box} />
                <input type="number" min="1" value={stochKSmooth} aria-label="%K smoothing"
                  onChange={(e) => setStochKSmooth(parseInt(e.target.value || "0", 10))} className={box} />
                <input type="number" min="1" value={stochDSmooth} aria-label="%D smoothing"
                  onChange={(e) => setStochDSmooth(parseInt(e.target.value || "0", 10))} className={box} />
              </div>
            </Row>
            <p className="pl-[132px] text-xs text-ink-faint">
              %K length · %K smoothing · %D smoothing
            </p>
          </>
        ) : kind === "adx" ? (
          <>
            <Row label="Threshold">
              <input type="number" min="1" max="99" step="1" value={adxLevel}
                onChange={(e) => setAdxLevel(parseFloat(e.target.value || "0"))} className={box} />
            </Row>
            <Row label="Lengths">
              <div className="flex items-center gap-2">
                <input type="number" min="1" value={adxDiLength} aria-label="DI length"
                  onChange={(e) => setAdxDiLength(parseInt(e.target.value || "0", 10))} className={box} />
                <input type="number" min="1" value={adxSmoothing} aria-label="ADX smoothing"
                  onChange={(e) => setAdxSmoothing(parseInt(e.target.value || "0", 10))} className={box} />
              </div>
            </Row>
            <p className="pl-[132px] text-xs text-ink-faint">
              DI length · ADX smoothing. 25 is the conventional line between
              &ldquo;no trend&rdquo; and &ldquo;a trend is present&rdquo;. ADX says how
              STRONG a trend is, never which way it points — pair it with a
              direction gate below if that matters.
            </p>
          </>
        ) : kind === "supertrend" ? (
          <>
            <Row label="ATR period">
              <input type="number" min="1" max="1000" value={stPeriod}
                onChange={(e) => setStPeriod(parseInt(e.target.value || "0", 10))} className={box} />
            </Row>
            <Row label="Multiplier">
              <input type="number" min="0.1" max="100" step="0.1" value={stMultiplier}
                onChange={(e) => setStMultiplier(parseFloat(e.target.value || "0"))} className={box} />
            </Row>
            <Row label="ATR method">
              <select
                value={stAtrMethod}
                onChange={(e) => setStAtrMethod(e.target.value as StAtrMethod)}
                className={box}
              >
                <option value="rma">Wilder&apos;s (default)</option>
                <option value="sma">Simple average of true range</option>
              </select>
            </Row>
            <p className="pl-[132px] text-xs text-ink-faint">
              The study&apos;s own defaults are 10 and 3. A wider multiplier flips
              less often and later; a narrower one flips more often and earlier.
            </p>
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

        {/*
          A price-line family already chose its event above, where the full
          touch / cross / near vocabulary lives. Showing a second direction
          control here would offer two answers to one question.
        */}
        {!PRICE_LINE_KINDS.includes(kind) && (
          <Row label="Direction">
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as typeof direction)}
              className={box}
            >
              <option value="cross_up">{COPY[kind].up}</option>
              <option value="cross_down">{COPY[kind].down}</option>
            </select>
          </Row>
        )}

        <p className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-xs text-ink-muted">
          Notify when <span className="text-ink">{summary}</span>.
          {/*
            * Only a CROSSING consults the previous bar. `touch` tests whether
            * the bar's range contains the line and `near_*` is a distance test;
            * neither looks at where price was before, so both fire on the first
            * evaluated bar if the condition already holds. Saying otherwise was
            * a promise the runner does not keep.
            */}
          {armedMode.startsWith("cross_")
            ? <>
                {" "}This needs a previous bar to compare against, so it stays quiet
                until {
                  kind === "supertrend" ? "the indicator actually changes direction"
                  : kind === "bollinger" ? "price actually crosses the band"
                  : "the indicator actually moves across the line"
                } — it will not fire just because it is already on one side.
              </>
            : <>
                {" "}This is a test of where price is now, not of where it came
                from, so it can trigger on the first bar it is evaluated on.
              </>}
        </p>

        <div className="my-1 border-t border-border" />

        <AlertFiltersField value={filters} onChange={setFilters} />

        <div className="my-1 border-t border-border" />

        <AlertNoteField value={note} onChange={setNote} />

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
