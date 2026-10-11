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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SymbolSearch } from "@/components/tv/SymbolSearch";
import { displayTicker } from "@/lib/instrument";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
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

/** The menu's width. Wide enough that the longest mode label and the window
 *  field each sit on one line, narrow enough to stay a menu beside a chip. */
const MENU_WIDTH = 300;

/**
 * Where the menu sits: under its anchor's left edge, flipped above when there
 * is no room below, and never past a viewport edge — the rule `useAnchor` in
 * `components/ui.tsx` applies to every dropdown. Restated here only because
 * this anchor is FOUND (the legend owns the chip) rather than owned.
 */
function placeUnder(
  anchor: { left: number; top: number; bottom: number } | null,
  height: number,
): { left: number; top: number; maxHeight: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!anchor) return { left: 8, top: 48, maxHeight: Math.max(120, vh - 56) };
  const left = Math.max(8, Math.min(anchor.left, vw - 8 - MENU_WIDTH));
  const below = anchor.bottom + 4;
  if (below + height <= vh - 8 || anchor.top - 4 - height < 8) {
    return { left, top: below, maxHeight: Math.max(120, vh - 8 - below) };
  }
  return { left, top: anchor.top - 4 - height, maxHeight: anchor.top - 12 };
}

/**
 * How the comparison is drawn, and the way out of it.
 *
 * ── C15: a menu on the chip, not a dialog ─────────────────────────────────
 *
 * This was a full `Modal` — backdrop, close button, centred panel — opened
 * from a 20px chip in the legend, although this file's own header said what
 * it should be: a small menu hanging off the `vs …` chip, which is how the
 * reference manages a comparison in place. A dialog takes the chart away to
 * change one radio; a menu leaves it visible, so the reader watches the
 * comparison redraw as they pick a mode.
 *
 * The product's popover grammar rather than `ContextMenu` itself, because one
 * row is a number field and a context menu's rows are verbs. The plumbing is
 * the same and for the same reasons: portalled to `<body>` inside its own
 * `tv-workstation` root (a legend's stacking context must not cap it), an
 * outside press closes it before the chart can act on the release, Escape
 * closes it and stops there, and focus goes back to what opened it.
 *
 * Nothing it says was dropped: the mode hints, the two self-comparison notices
 * and the returns/prices caveats are the reason a reader can tell a rolling
 * beta from a pair ratio without reading the source.
 */
export function CompareSettings({
  open, current, baseTicker, onClose, onApply, onChangeSymbol, anchor,
}: {
  open: boolean;
  current: PaneCompare | null;
  baseTicker: string;
  onClose: () => void;
  onApply: (next: PaneCompare | null) => void;
  /** Reopen the shared symbol picker without removing the current comparison. */
  onChangeSymbol?: () => void;
  /**
   * The control the menu hangs from — the legend's `vs …` chip, or the
   * toolbar's Compare button when the status-line title is off and there is
   * no chip. A getter read when the menu opens, because the chip is the
   * legend's to render and this component must not hold a ref into it.
   */
  anchor?: () => HTMLElement | null;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] =
    useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const mode = current?.mode ?? "percent";
  const length = current?.length ?? DEFAULT_COMPARE_LENGTH;
  const hint = MODES.find((m) => m.value === mode)?.hint ?? "";
  const self = current !== null
    && current.symbol.trim().toUpperCase() === baseTicker.trim().toUpperCase();

  const set = (next: Partial<PaneCompare>): void => {
    if (!current) return;
    onApply({ ...current, ...next });
  };

  /*
   * Remember what had focus, and give it back on close.
   *
   * The anchor is the fallback rather than the first choice: a keyboard user
   * who opened this from the chip has the chip focused already, while a
   * pointer user on Safari — which does not focus a clicked button — has
   * nothing focused, and the chip is where their attention is.
   */
  useEffect(() => {
    if (!open) { setPlacement(null); return; }
    const active = document.activeElement as HTMLElement | null;
    restoreTo.current = active && active !== document.body ? active : anchor?.() ?? null;
    return () => {
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
    // `anchor` is a fresh closure on every pane render; the OPENING is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Measure, then place, so the panel is never seen at the wrong position. A
  // mode change re-measures because the window field and caveats come and go.
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const height = panelRef.current.getBoundingClientRect().height;
    setPlacement(placeUnder(anchor?.()?.getBoundingClientRect() ?? null, height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  // Focus lands on the mode that is on, so the arrows start from the answer —
  // once per opening, not again on every re-measure.
  const placed = placement !== null;
  useEffect(() => {
    if (!open || !placed) return;
    const items = menuItems(panelRef.current);
    (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, [open, placed]);

  /*
   * Escape in the capture phase, stopped there — the popover grammar of
   * `components/ui.tsx`. Escape is also the chart's clear-selection and
   * disarm-the-tool key; dismissing this menu must not do those as well.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // The window field owns its own arrows: Up and Down step the number.
    const inField = (event.target as HTMLElement).tagName === "INPUT";
    if (!inField && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      moveMenuFocus(menuItems(panelRef.current), document.activeElement, event.key);
      return;
    }
    // Tab walks the menu rather than escaping into the chart behind the
    // outside-press catcher, where focus would sit on something unclickable.
    if (event.key === "Tab") {
      event.preventDefault();
      moveMenuFocus(menuItems(panelRef.current), document.activeElement,
        event.shiftKey ? "ArrowUp" : "ArrowDown");
    }
  };

  /*
    `displayTicker`, not the stored symbol.

    A comparison chosen through the picker is stored already-displayed (see
    `onSelect` above), so this read looked safe. A comparison restored from a
    saved workspace is not: it carries the canonical id, and the heading
    rendered "Comparing with instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot" —
    the exact leak this file's header comment says the contract forbids, on
    the most prominent line of the surface. Converting at the point of
    DISPLAY holds for both paths.
  */
  const title = `Comparing with ${displayTicker(current?.symbol ?? "")}`.trim();

  return createPortal(
    <div className="tv-workstation" data-compare-menu-root="">
      {/*
        The outside-press catcher, on `pointerdown` so the menu closes on the
        press, before the chart underneath can start a pan on the release.
      */}
      <div
        className="fixed inset-0 z-[90]"
        onPointerDown={onClose}
        onContextMenu={(event) => { event.preventDefault(); onClose(); }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="menu"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          left: placement?.left ?? 0,
          top: placement?.top ?? 0,
          maxHeight: placement?.maxHeight,
          width: MENU_WIDTH,
          // Invisible until measured, so it is never seen in the wrong place.
          visibility: placement ? "visible" : "hidden",
        }}
        className="tvc-menu tvc-menu--compact fixed z-[91] overflow-y-auto outline-none"
      >
        <div role="presentation" className="truncate px-3 pb-1 pt-0.5 text-xs font-semibold text-ink">
          {title}
        </div>
        <div role="group" aria-label="Which comparison">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="menuitemradio"
              aria-checked={m.value === mode}
              /*
                B-26: a choice closes the menu, as the reference's menus do —
                unless the mode has a rolling window still to set, which lives
                in this same menu.
              */
              onClick={() => { set({ mode: m.value }); if (!WINDOWED.has(m.value)) onClose(); }}
              className="tvc-menu-row justify-start px-2 text-left text-sm"
            >
              {m.label}
            </button>
          ))}
        </div>
        {WINDOWED.has(mode) && (
          <div role="group" aria-label="Rolling window" className="flex items-center gap-2 px-3 pt-1.5">
            <span className="text-xs text-ink-muted">Window, in bars</span>
            <input
              className="ml-auto h-7 w-[76px] rounded-md border border-control-border bg-transparent px-2 text-sm tabular text-ink"
              type="number" min={2} max={1000}
              value={length}
              onChange={(e) => {
                const next = parseInt(e.target.value || "0", 10);
                if (Number.isInteger(next) && next >= 2 && next <= 1000) set({ length: next });
              }}
              aria-label="Rolling window in bars"
            />
          </div>
        )}
        <div role="presentation" className="space-y-1 px-3 pb-1 pt-1.5">
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
        </div>
        <div role="separator" className="tvc-menu-sep" />
        {onChangeSymbol && (
          <button
            type="button"
            role="menuitem"
            onClick={onChangeSymbol}
            className="tvc-menu-row px-2 text-left text-sm text-ink"
          >
            Change symbol…
          </button>
        )}
        {/*
          Not tinted: a destructive row is the same ink as every other row in
          this product's menus (see `ContextMenu`), and chromatic colour here
          means direction, never danger.
        */}
        <button
          type="button"
          role="menuitem"
          disabled={!current}
          onClick={() => { onApply(null); onClose(); }}
          className="tvc-menu-row px-2 text-left text-sm text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
        >
          Remove comparison
        </button>
      </div>
    </div>,
    document.body,
  );
}
