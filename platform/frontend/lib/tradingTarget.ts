/**
 * Which instrument the manual order ticket is for, in a workspace that can
 * show sixteen of them at once.
 *
 * ── The hazard this exists to remove ───────────────────────────────────────
 *
 * With one chart, "the ticket trades what the chart shows" was safe, and
 * `lib/manualTicket` made it safe *across a symbol change*: everything staged
 * is discarded, because an amount, a limit price and a real-funds attestation
 * are statements about one instrument.
 *
 * With many charts there is a second way for the ticket's instrument to move,
 * and it is far quieter: clicking a different pane. Nothing was typed, nothing
 * was confirmed, no dialog appeared — the operator's own pointer landed on
 * another chart while an order was staged, and under a naive "ticket follows
 * the focused pane" rule that order would now be aimed somewhere else.
 *
 * So focus and trading target are two different things:
 *
 *   nothing staged  → the ticket follows the active pane, which is what makes
 *                     clicking a chart and trading it feel like one action;
 *   something staged→ the ticket STAYS on the instrument it was staged for,
 *                     and says so. Focus still moves; the order does not.
 *
 * Changing the symbol *of the pinned pane itself* is a deliberate act through
 * an existing supported workflow, so the target follows it — and the existing
 * `resetForSymbolChange` disarm in the panel is what makes that safe. This
 * module adds no second safety mechanism; it only decides which symbol the
 * panel is handed, so the mechanism that already exists keeps applying.
 */
import { sameSymbol } from "./manualTicket";
import { activePane, paneById, type ChartWorkspace, type PaneId } from "./workspace";

export interface TradingTarget {
  /** The pane the ticket is aimed at, or null once that pane is gone. */
  paneId: PaneId | null;
  /** The instrument the ticket trades. Always present. */
  symbol: string;
  /**
   * True while the target is being held against the active pane because an
   * order is staged. The UI must say this out loud.
   */
  pinned: boolean;
}

export interface TradingTargetInput {
  workspace: ChartWorkspace;
  /** The target from the previous resolution, or null on first render. */
  previous: TradingTarget | null;
  /** Whether the ticket currently holds anything an operator typed or chose. */
  ticketStaged: boolean;
}

/**
 * The ticket's instrument for this render.
 *
 * Pure and total: every branch returns a symbol, so the panel is never handed
 * `null` and never has to guess.
 */
export function resolveTradingTarget(input: TradingTargetInput): TradingTarget {
  const { workspace, previous, ticketStaged } = input;
  const focused = activePane(workspace);

  if (!previous) {
    return { paneId: focused.id, symbol: focused.symbol, pinned: false };
  }

  const heldPane = previous.paneId === null ? null : paneById(workspace, previous.paneId);

  if (!ticketStaged) {
    // Nothing to protect. Follow focus, which is the behaviour a single-chart
    // workspace has always had.
    return { paneId: focused.id, symbol: focused.symbol, pinned: false };
  }

  if (heldPane) {
    // The pinned pane is still on screen. If ITS symbol changed, that is the
    // supported workflow — follow it, and let the panel's own disarm run.
    const followed = heldPane.symbol;
    return {
      paneId: heldPane.id,
      symbol: followed,
      pinned: heldPane.id !== focused.id || !sameSymbol(followed, focused.symbol),
    };
  }

  // The pinned pane was removed by a layout change. The staged order does not
  // follow the layout: it keeps its instrument, so the panel keeps showing the
  // ticket it holds and the submit guard keeps comparing against the same
  // symbol. Losing a view is not a decision to trade something else.
  return { paneId: null, symbol: previous.symbol, pinned: true };
}

/**
 * The sentence shown beside a pinned ticket.
 *
 * Returns null when nothing is being held, so a caller can render it directly.
 */
export function tradingTargetNotice(
  target: TradingTarget, workspace: ChartWorkspace
): string | null {
  if (!target.pinned) return null;
  const focused = activePane(workspace);
  if (target.paneId === null) {
    return `This ticket is still staged for ${target.symbol}, whose pane was closed. `
      + "Submit it or clear it before trading another instrument.";
  }
  if (sameSymbol(target.symbol, focused.symbol)) return null;
  return `This ticket is staged for ${target.symbol}. It stays on ${target.symbol} `
    + `while ${focused.symbol} is focused — clear it to trade ${focused.symbol}.`;
}
