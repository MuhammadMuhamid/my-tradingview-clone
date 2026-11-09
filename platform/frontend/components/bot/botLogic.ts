/**
 * Pure helpers for the Bot pages: no React, no fetch, so each is testable on
 * its own.
 *
 * Adapted from the standalone (Classic) Bot dashboard
 * (bot/frontend/src/pages/Dashboard.tsx `fmtDuration`, `calcHistoryStats`,
 * the partial-close preview and the start confirmation; `api.ts` `formatPair`),
 * with its stale or misleading parts corrected (parity inventory §5):
 *   - "Max drawdown" was the single worst losing trade; it is called that here
 *     ("Worst trade"), over the rows actually loaded, and says so;
 *   - the 0.1 % fee in the partial preview is an ESTIMATE, labelled as one;
 *     the Bot reports the real fee from the fills;
 *   - nothing here confirms with `window.confirm`.
 */
import type { BotControlPanel, BotViewBot, BotViewTrade } from "@/lib/api";

// ── formatting ──────────────────────────────────────────────────────────────

/** "2d 3h", "4h 12m", "7m": how long since `since` (never negative). */
export function fmtDuration(since: string | number, now: number = Date.now()): string {
  const start = typeof since === "number" ? since : new Date(since).getTime();
  if (!Number.isFinite(start)) return "—";
  const ms = Math.max(0, now - start);
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** "BTCUSDT" → "BTC/USDT"; USDC likewise; anything else unchanged. */
export function formatPair(pair: string): string {
  const s = pair.replace("/", "");
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}/USDT`;
  if (s.endsWith("USDC")) return `${s.slice(0, -4)}/USDC`;
  return s;
}

/** The first three pairs and a "+N" for the rest. */
export function pairsPreview(pairs: string[], shown = 3): string {
  if (pairs.length === 0) return "No pairs";
  const head = pairs.slice(0, shown).join(", ");
  return pairs.length > shown ? `${head} +${pairs.length - shown}` : head;
}

/** USDT with a sign and a fixed number of places: "+1.2345 USDT", "−0.5000 USDT". */
export function signedUsdtFixed(value: number, digits = 4): string {
  const abs = Math.abs(value).toFixed(digits);
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${abs} USDT`;
}

// ── closed reasons ──────────────────────────────────────────────────────────

export const CLOSED_REASONS: Record<string, { label: string; tone: "up" | "down" | "warn" | "neutral" | "accent" }> = {
  signal_exit: { label: "Signal exit", tone: "accent" },
  take_profit: { label: "Take profit", tone: "up" },
  stop_loss: { label: "Stop loss", tone: "down" },
  closed_manually: { label: "Closed manually", tone: "warn" },
  partial_close: { label: "Partial close", tone: "neutral" },
};

export function closedReasonLabel(reason: string | null): { label: string; tone: "up" | "down" | "warn" | "neutral" | "accent" } | null {
  if (!reason) return null;
  return CLOSED_REASONS[reason] ?? { label: reason.replaceAll("_", " "), tone: "neutral" };
}

// ── history summary ─────────────────────────────────────────────────────────

export interface HistoryStats {
  count: number;
  winners: number;
  losers: number;
  totalProfitUsdt: number;
  totalLossUsdt: number;
  netUsdt: number;
  /** The single worst losing trade among these rows (null when none lost). Not a drawdown. */
  worstTrade: { pnlUsdt: number; pnlPct: number; pair: string } | null;
}

export function calcHistoryStats(trades: Pick<BotViewTrade, "pnlUsdt" | "pnlPct" | "pair">[]): HistoryStats {
  const winners = trades.filter((t) => t.pnlUsdt > 0);
  const losers = trades.filter((t) => t.pnlUsdt < 0);
  const sum = (rows: typeof trades) => rows.reduce((s, t) => s + t.pnlUsdt, 0);
  const worst = losers.reduce<typeof losers[number] | null>((min, t) => (min === null || t.pnlUsdt < min.pnlUsdt ? t : min), null);
  return {
    count: trades.length, winners: winners.length, losers: losers.length,
    totalProfitUsdt: sum(winners), totalLossUsdt: sum(losers), netUsdt: sum(trades),
    worstTrade: worst ? { pnlUsdt: worst.pnlUsdt, pnlPct: worst.pnlPct, pair: worst.pair } : null,
  };
}

// ── partial close ───────────────────────────────────────────────────────────

export const PARTIAL_PRESETS = [25, 50, 75] as const;
/** An estimate only: Binance's base spot fee. The Bot records the real fee from the fills. */
export const ESTIMATED_FEE_RATE = 0.001;

export interface PartialPreview {
  sellQty: number;
  costBasis: number;
  /** Revenue after the ESTIMATED sell fee, at the last known price. */
  estRevenue: number;
  /** Estimated P&L of the part sold, after the estimated buy and sell fees. */
  estPnl: number;
  remainingPct: number;
  priceKnown: boolean;
}

export function partialPreview(trade: Pick<BotViewTrade, "quantity" | "quoteSpent" | "entryPrice" | "currentPrice">,
  pct: number, feeRate = ESTIMATED_FEE_RATE): PartialPreview {
  const share = Math.min(99, Math.max(1, pct)) / 100;
  const sellQty = trade.quantity * share;
  const costBasis = trade.quoteSpent * share;
  const price = trade.currentPrice ?? trade.entryPrice ?? 0;
  const estRevenue = sellQty * price * (1 - feeRate);
  return {
    sellQty, costBasis, estRevenue, estPnl: estRevenue - costBasis * (1 + feeRate),
    remainingPct: 100 - Math.round(share * 100), priceKnown: trade.currentPrice !== null || trade.entryPrice !== null,
  };
}

// ── starting a bot ──────────────────────────────────────────────────────────

export interface StartSummary {
  pairs: string;
  size: string;
  guards: { text: string; missing: boolean }[];
}

/** What starting a bot arms, in the Classic confirmation's terms (pairs, size, guards). */
export function startSummary(bot: BotViewBot): StartSummary {
  return {
    pairs: bot.pairs.length ? bot.pairs.join(", ") : "No pairs",
    size: `${bot.investment} per entry`,
    guards: [
      bot.stopLossPct !== null ? { text: `Stop loss ${bot.stopLossPct}%`, missing: false } : { text: "NO STOP LOSS", missing: true },
      bot.takeProfitPct !== null ? { text: `Take profit ${bot.takeProfitPct}%`, missing: false } : { text: "No take profit", missing: false },
      bot.exitEnabled ? { text: "Exit signals accepted", missing: false } : { text: "EXITS DISABLED", missing: true },
      ...(bot.maxActiveSmartTrades !== null ? [{ text: `At most ${bot.maxActiveSmartTrades} open trades`, missing: false }] : []),
      ...(bot.entryEnabled ? [] : [{ text: "Entries off: it will not open positions", missing: false }]),
    ],
  };
}

/** "1 open" or "1 / 3 open" when the bot caps its open trades. */
export function tradesCap(bot: Pick<BotViewBot, "activeTrades" | "maxActiveSmartTrades">): string {
  return bot.maxActiveSmartTrades !== null ? `${bot.activeTrades} / ${bot.maxActiveSmartTrades} open` : `${bot.activeTrades} open`;
}

// ── capabilities (B-CAP) ────────────────────────────────────────────────────

export type CapabilityState = "yes" | "no" | "unknown";

/**
 * Whether the Bot advertises a capability. `unknown` while its status cannot
 * be read; `no` for a Bot that reads but does not list it (an older Bot).
 */
export function capability(panel: BotControlPanel | null, name: string): CapabilityState {
  const facts = panel?.facts;
  if (!facts) return "unknown";
  return Array.isArray(facts.capabilities) && facts.capabilities.includes(name) ? "yes" : "no";
}

/** The sentence a disabled feature shows when its capability is missing. */
export function capabilityNote(state: CapabilityState, feature: string): string | null {
  if (state === "yes") return null;
  return state === "unknown"
    ? `${feature} is unavailable while the Bot's status cannot be read.`
    : `${feature} needs a newer Bot: this Bot does not support it yet. Use the Bot's own dashboard meanwhile.`;
}

// ── closing a strategy trade ────────────────────────────────────────────────

/**
 * Why Close cannot be offered for this strategy trade, or null when it can.
 *
 * A Bot with `operatorExit.v1` closes the trade by its id, so a stopped bot,
 * a pair no longer in the bot's list, or two open trades on one pair do not
 * matter. An older Bot refuses all three (`bot_paused`, `pair_not_listed`,
 * `ambiguous_trade`), so the button says why instead of sending a refusal.
 */
export function closeBlockReason(trade: BotViewTrade, bots: BotViewBot[] | null, rows: BotViewTrade[],
  operatorExit: CapabilityState): string | null {
  if (operatorExit === "yes" || !trade.botId) return null;
  const bot = bots?.find((b) => b.id === trade.botId);
  if (bot && bot.status !== "active") return "This bot is stopped. This Bot version closes a trade only while its bot runs: start the bot first.";
  if (bot && !bot.pairs.includes(trade.pair)) return "This pair is no longer in the bot's list. This Bot version will not close it from here.";
  const twins = rows.filter((r) => r.status === "active" && r.botId === trade.botId && r.pair === trade.pair);
  if (twins.length > 1) return "The bot has more than one open trade on this pair. This Bot version cannot tell them apart; use the Bot's dashboard.";
  return null;
}
