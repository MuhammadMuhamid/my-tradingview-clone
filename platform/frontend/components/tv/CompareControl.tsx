"use client";
/**
 * What this chart is compared against.
 *
 * A small control rather than a dialog, because the whole decision is three
 * fields: which instrument, which comparison, and over what window. It sits on
 * the pane because that is what it belongs to — a four-pane layout comparing
 * four different things against four different benchmarks is an ordinary way
 * to use one.
 */
import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { DEFAULT_BENCHMARK } from "@/lib/compare";
import { tryStoredSymbol } from "@/lib/instrument";
import { DEFAULT_COMPARE_LENGTH, type PaneCompare } from "@/lib/workspace";

const FIELD =
  "w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 text-sm text-ink " +
  "outline-none focus:border-accent";

const MODES: { value: PaneCompare["mode"]; label: string; hint: string }[] = [
  {
    value: "percent", label: "Percent change",
    hint: "Both instruments rebased to 0 % at the first bar they share, drawn on the price pane.",
  },
  {
    value: "correlation", label: "Rolling correlation",
    hint: "Of the two instruments' returns, in its own pane. −1 to 1.",
  },
  {
    value: "beta", label: "Rolling beta",
    hint: "How much this instrument moves for a given move in the benchmark.",
  },
];

export function CompareControl({
  open, current, baseSymbol, onClose, onApply,
}: {
  open: boolean;
  current: PaneCompare | null;
  baseSymbol: string;
  onClose: () => void;
  onApply: (next: PaneCompare | null) => void;
}) {
  const [symbol, setSymbol] = useState(current?.symbol ?? DEFAULT_BENCHMARK);
  const [mode, setMode] = useState<PaneCompare["mode"]>(current?.mode ?? "percent");
  const [length, setLength] = useState(current?.length ?? DEFAULT_COMPARE_LENGTH);
  const [error, setError] = useState<string | null>(null);

  const apply = (): void => {
    const ticker = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9:]{2,32}$/.test(ticker)) {
      setError("Enter a symbol like BTCUSDT.");
      return;
    }
    /*
     * And it has to be an instrument this installation can actually resolve.
     *
     * The shape check above passes `COINBASE:BTCUSDT`, which `tryStoredSymbol`
     * then refuses — correctly, because no second venue is registered — after
     * which the comparison silently drew nothing and said nothing. Refusing a
     * venue is right; being quiet about it is not.
     */
    if (tryStoredSymbol(ticker) === null) {
      setError(
        `${ticker} is not an instrument this installation knows. ` +
        "Use a bare symbol like BTCUSDT, or one qualified with BINANCE:."
      );
      return;
    }
    if (!Number.isInteger(length) || length < 2 || length > 1000) {
      setError("The window must be a whole number from 2 to 1000.");
      return;
    }
    onApply({ symbol: ticker, mode, length });
    onClose();
  };

  const hint = MODES.find((m) => m.value === mode)?.hint ?? "";

  return (
    <Modal open={open} onClose={onClose} title={`Compare ${baseSymbol} with`}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-ink-muted">
          Instrument
          <input
            className={FIELD}
            value={symbol}
            onChange={(e) => { setSymbol(e.target.value); setError(null); }}
            aria-label="Instrument to compare against"
            placeholder={DEFAULT_BENCHMARK}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-ink-muted">
          Comparison
          <select
            className={FIELD}
            value={mode}
            onChange={(e) => setMode(e.target.value as PaneCompare["mode"])}
            aria-label="Which comparison"
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        {mode !== "percent" && (
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            Window, in bars
            <input
              className={FIELD}
              type="number" min={2} max={1000}
              value={length}
              onChange={(e) => { setLength(parseInt(e.target.value || "0", 10)); setError(null); }}
              aria-label="Rolling window in bars"
            />
          </label>
        )}
        <p className="text-xs text-ink-faint">{hint}</p>
        {/*
          Said before it can surprise anyone: the statistics are computed from
          RETURNS, and a bar the second instrument does not have is left out
          rather than filled in. Both are choices a reader is entitled to know
          about, because both change what the number means.
        */}
        {mode !== "percent" && (
          <p className="text-xs text-ink-faint">
            Computed from returns rather than prices — two instruments that both
            drift upward correlate at nearly 1 whatever they have in common, which
            would be a fact about drift rather than about them. Bars the second
            instrument has no data for are left out, never filled in.
          </p>
        )}
        {error && <p className="text-xs text-down">{error}</p>}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            variant="ghost"
            onClick={() => { onApply(null); onClose(); }}
            disabled={!current}
          >
            Remove comparison
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={apply}>Compare</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
