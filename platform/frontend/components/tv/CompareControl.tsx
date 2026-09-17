"use client";
/**
 * What this chart is compared against.
 *
 * ── TVP8 R4b-06 / R1c-14: the way IN is the symbol search ─────────────────
 *
 * This used to be a 512×374 form: a free-text `Instrument` field validated by
 * a regex, a `Comparison` `<select>`, a window box and a paragraph — under a
 * title that read
 *
 *     Compare instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot with
 *
 * three lines deep, because the pane handed it the CANONICAL id. A canonical
 * id as primary copy is exactly what the contract's symbol-display rule
 * forbids, and a text field with a regex behind it is the opposite of what
 * the reference does: TradingView's ⊕ opens THE SYMBOL SEARCH in compare
 * mode — same panel, same chips, same dropdown row, same 40px rows — and a
 * row adds an overlay instead of moving the chart.
 *
 * So the picker IS `SymbolSearch` now (`mode="compare"`, title `Compare
 * symbol`), and the three fields that have no equivalent in the reference —
 * which comparison, over what window, and remove — are a small menu hanging
 * off the legend's own `vs …` chip, which is where a reader who already has a
 * comparison goes to change it.
 *
 * The pane's own instrument is never touched by either surface.
 */
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { SymbolSearch } from "@/components/tv/SymbolSearch";
import { displayTicker } from "@/lib/instrument";
import { DEFAULT_COMPARE_LENGTH, type PaneCompare } from "@/lib/workspace";

const MODES: { value: PaneCompare["mode"]; label: string; hint: string }[] = [
  {
    value: "percent", label: "Percent change",
    hint: "Both instruments rebased to 0 % at the first bar they share, in a dedicated percent pane.",
  },
  {
    value: "correlation", label: "Rolling correlation",
    hint: "Of the two instruments' returns, in its own pane. −1 to 1.",
  },
  {
    value: "beta", label: "Rolling beta",
    hint: "How much this instrument moves for a given move in the benchmark.",
  },
  {
    value: "ratio", label: "Pair ratio",
    hint: "This instrument priced in units of the other, bar by bar, in its own pane. "
      + "No window: at each bar it is a division.",
  },
  {
    value: "zspread", label: "Pair spread, z-scored",
    hint: "How far the log ratio of the pair sits from its own average over the window, "
      + "in standard deviations. One unit against one unit — not a fitted hedge ratio.",
  },
];

/** Modes whose answer is a rolling statistic, so the window field applies. */
const WINDOWED: ReadonlySet<PaneCompare["mode"]> =
  new Set<PaneCompare["mode"]>(["correlation", "beta", "zspread"]);

/**
 * Pick the instrument to compare against.
 *
 * `baseTicker` is a TICKER — the type says so, and the dialog never prints a
 * canonical id. It is not shown in the header at all, because the reference's
 * compare header is two words; it names the pane for assistive technology and
 * for the self-comparison notice below.
 */
export function CompareControl({
  open, current, baseTicker, onClose, onApply,
}: {
  open: boolean;
  current: PaneCompare | null;
  /** The pane's own instrument as a ticker — never `instrument:v1:…`. */
  baseTicker: string;
  onClose: () => void;
  onApply: (next: PaneCompare | null) => void;
}) {
  return (
    <SymbolSearch
      open={open}
      mode="compare"
      current={baseTicker}
      onClose={onClose}
      /*
       * A chosen row ADDS an overlay. The pane's symbol is not this dialog's
       * to change in compare mode — that is the whole difference between the
       * two modes, and it is the caller that knows it.
       */
      onSelect={(symbol) => {
        onApply({
          /*
           * A TICKER, never a canonical id. `setPaneCompare` normalises with
           * `trim().toUpperCase()`, which would mangle `instrument:v1:…` into
           * something no resolver answers, and the legend prints this value
           * verbatim beside `vs`. `displayTicker` is the same form the old
           * free-text field could produce, so nothing downstream changes.
           */
          symbol: displayTicker(symbol),
          mode: current?.mode ?? "percent",
          length: current?.length ?? DEFAULT_COMPARE_LENGTH,
        });
      }}
    />
  );
}

/**
 * How the comparison is drawn, and the way out of it.
 *
 * The secondary half of the old form, reached from the legend's `vs …` chip
 * rather than standing between a reader and choosing an instrument. Nothing
 * it says was dropped: the mode hints, the two self-comparison notices and
 * the returns/prices caveats are the reason a reader can tell a rolling beta
 * from a pair ratio without reading the source.
 */
export function CompareSettings({
  open, current, baseTicker, onClose, onApply, onChangeSymbol,
}: {
  open: boolean;
  current: PaneCompare | null;
  baseTicker: string;
  onClose: () => void;
  onApply: (next: PaneCompare | null) => void;
  /** Reopen the shared symbol picker without removing the current comparison. */
  onChangeSymbol?: () => void;
}) {
  const mode = current?.mode ?? "percent";
  const length = current?.length ?? DEFAULT_COMPARE_LENGTH;
  const hint = MODES.find((m) => m.value === mode)?.hint ?? "";
  const self = current !== null
    && current.symbol.trim().toUpperCase() === baseTicker.trim().toUpperCase();

  const set = (next: Partial<PaneCompare>): void => {
    if (!current) return;
    onApply({ ...current, ...next });
  };

  return (
    <Modal open={open} onClose={onClose} title={`Comparing with ${current?.symbol ?? ""}`.trim()}>
      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Which comparison" className="flex flex-col gap-1">
          {MODES.map((m) => (
            <button
              key={m.value}
              role="menuitemradio"
              aria-checked={m.value === mode}
              onClick={() => set({ mode: m.value })}
              className="tvc-menu-row justify-start px-3 text-sm"
            >
              {m.label}
            </button>
          ))}
        </div>
        {WINDOWED.has(mode) && (
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            Window, in bars
            <input
              className="w-full rounded-md border border-control-border bg-transparent px-2 py-1 text-sm text-ink"
              type="number" min={2} max={1000}
              value={length}
              onChange={(e) => {
                const next = parseInt(e.target.value || "0", 10);
                if (Number.isInteger(next) && next >= 2 && next <= 1000) set({ length: next });
              }}
              aria-label="Rolling window in bars"
            />
          </label>
        )}
        <p className="text-xs text-ink-faint">{hint}</p>
        {self && (mode === "ratio" || mode === "zspread") && (
          /*
           * A pair with itself is a constant 1, and a z-score of a constant is
           * a division by zero. Worth naming separately from the correlation
           * case below, because "the line will be flat at 1" and "there will be
           * no line at all" are different surprises.
           */
          <p className="text-xs text-warn">
            That is this chart&apos;s own instrument. The ratio is exactly 1 at every
            bar, and a z-score of a constant has nothing to measure.
          </p>
        )}
        {self && (mode === "correlation" || mode === "beta" || mode === "percent") && (
          /*
           * Legal, and worth saying out loud rather than refusing: the
           * correlation is 1 and the beta is 1 by construction, and seeing
           * that IS useful — but a reader who did not intend it would
           * otherwise spend a while wondering why the line is flat.
           */
          <p className="text-xs text-warn">
            That is this chart&apos;s own instrument. The correlation and beta will be
            exactly 1, and the percentage overlay will draw one line over the other.
          </p>
        )}
        {/*
          Said before it can surprise anyone: the statistics are computed from
          RETURNS, and a bar the second instrument does not have is left out
          rather than filled in. Both are choices a reader is entitled to know
          about, because both change what the number means.
        */}
        {(mode === "correlation" || mode === "beta") && (
          <p className="text-xs text-ink-faint">
            Computed from returns rather than prices — two instruments that both
            drift upward correlate at nearly 1 whatever they have in common, which
            would be a fact about drift rather than about them. Bars the second
            instrument has no data for are left out, never filled in.
          </p>
        )}
        {(mode === "ratio" || mode === "zspread") && (
          /*
           * The pair surfaces are computed from PRICES, and that is a different
           * statement from the one above rather than an omission of it: a ratio
           * of returns is not a ratio. The z-score is said to describe rather
           * than to predict, out loud, because a spread two deviations from its
           * own mean is a fact about the last few hundred bars and not a claim
           * that it comes back.
           */
          <p className="text-xs text-ink-faint">
            Computed from prices, since a ratio of returns is not a ratio. Bars
            the second instrument has no data for are left out rather than
            filled in.
            {mode === "zspread" && " A z-score says where the pair has been "
              + "against its own window — it is not a claim that the spread returns."}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => { onApply(null); onClose(); }}
              disabled={!current}
            >
              Remove comparison
            </Button>
            {onChangeSymbol && (
              <Button variant="ghost" onClick={onChangeSymbol}>Change symbol…</Button>
            )}
          </div>
          <Button variant="ghost" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
