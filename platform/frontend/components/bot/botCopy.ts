/**
 * The words the Bot controls use, in one place so `/bot`, its dialogs and the
 * Operations panel say the same thing.
 *
 * Halt scope is policy, stated, not changed (contract §0.5, F2): a Bot halt
 * stops all Bot automation in both directions, including the TP/SL monitors,
 * while the operator's own exits keep working.
 */
import type { BotControlPanel, BotSignedCause, BotSignedState, BotStatusConnection } from "@/lib/api";

export const HALT_SCOPE_TEXT =
  "While the Bot is halted, TP/SL protection is not checked and TradingView exits are refused; "
  + "your own SELL / Close / Partial still work.";

export const RECOVERY_NOTE =
  "The standalone Bot dashboard remains available to the Bot operator for recovery.";

export const PLATFORM_HALT_BLOCKS =
  "Stops this Platform's automated signals and new manual BUYs from the Trade panel. It never reaches the Bot.";

export const BOT_HALT_BLOCKS =
  "Stops every automated Bot order — webhook and Platform-signal BUYs and SELLs, both TP/SL monitors and the "
  + "intent reconciler — and new manual BUYs sent through the Bot. Your own SELL, Close and Partial still work.";

export const LATCH_NOTE =
  "Changing a limit never clears a halt that is already latched; resume it separately.";

export const LOSS_LIMIT_WARNING =
  "Turning the daily-loss limit off (or raising it) makes a latched daily-loss halt resumable.";

/**
 * The loss the Bot's daily-loss limit counts: the NET realised loss in its
 * rolling window, as a positive number, and 0 when the window is in profit.
 * Mirrors the Bot exactly (`riskControls.ts`: `loss = -Math.min(0, realisedPnlInWindow)`).
 * `realisedPnlInWindow` itself is signed P&L — a profit is positive — and is
 * never to be shown under a "loss" label (walkthrough D-2).
 */
export const countedLoss = (realisedPnlInWindow: number): number => Math.max(0, -realisedPnlInWindow);

/** Signed P&L in USDT: "+1.29 USDT", "−5.00 USDT", "0.00 USDT". */
export function signedUsdt(value: number): string {
  const abs = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${abs} USDT`;
}

export function signedLabel(state: BotSignedState, cause: BotSignedCause): string {
  switch (state) {
    case "CONNECTED": return "Connected";
    case "NOT_CONFIGURED": return "Not set up on this Platform";
    case "UNREACHABLE": return "Unreachable";
    case "INVALID": return "Unexpected reply";
    case "RATE_LIMITED": return "Busy (rate-limited)";
    case "REJECTED":
      return cause === "proxy" ? "Refused by the proxy"
        : cause === "replay" ? "Refused (replayed request)"
          : cause === "bot_unconfigured" ? "Refused (Bot's control key unset)"
            : "Refused (signature)";
    default: return String(state);
  }
}

export function webhookLabel(webhook: BotStatusConnection): string {
  if (webhook.state === "CONNECTED") return "Connected";
  if (webhook.state === "NOT_CONFIGURED") return "No custom webhook deployment";
  return webhook.reason === "authentication_rejected" ? "Credential rejected"
    : webhook.reason === "invalid_response" ? "Unexpected reply" : "Unreachable";
}

export function routingLabel(routing: "TESTNET" | "MAINNET" | "MIXED" | "NONE"): string {
  return routing === "TESTNET" ? "Testnet" : routing === "MAINNET" ? "Mainnet"
    : routing === "MIXED" ? "Mixed (testnet and mainnet)" : "No exchange accounts";
}

export function haltLabel(panel: BotControlPanel): string | null {
  const halt = panel.facts?.halt;
  if (!halt) return null;
  if (!halt.halted) return "Not halted";
  const by = halt.haltedBy === "daily_loss" ? "daily-loss limit" : halt.haltedBy ?? "unknown";
  return `Halted by ${by}${panel.facts?.risk.latched ? " (latched)" : ""}`;
}

/**
 * A refusal the Bot or this Platform gave, in plain words. Every one of these
 * is DEFINITIVE — the command did not run — and none claims more than that.
 * `chart` marks the refusal whose right path is the chart's Trade panel.
 */
export function explainRefusal(code: string, message: string): { text: string; chart?: boolean; profile?: boolean } {
  switch (code) {
    case "trade_manual":
      return { chart: true, text: "This position was opened from Trading Scene. Close it from the Trade panel on the chart, "
        + "so its ledger and TP/SL stay correct. The Bot did not run this." };
    case "bot_deleted":
      return { text: "This trade's bot was deleted, so it cannot be closed from here and has no TP/SL. The Bot did not run this." };
    case "bot_paused":
      return { text: "This trade's bot is stopped. Start the bot first, then close the trade. The Bot did not run this." };
    case "pair_not_listed":
      return { text: "This pair is no longer in the bot's pair list, so the Bot will not sell it from here. The Bot did not run this." };
    case "ambiguous_trade":
    case "trade_changed":
      return { text: "The bot has more than one open trade on this pair, or the trade changed a moment ago, so Close could "
        + "hit the wrong one. The Bot did not run this." };
    case "exit_unresolved":
      return { text: "An earlier exit for this trade is still being reconciled with the exchange. Wait a minute and try again. "
        + "The Bot did not run this." };
    case "trade_closing":
      return { text: "This trade is already being closed. No new order was sent." };
    case "still_breached":
      return { text: "The daily loss is still at its limit, so the latched halt cannot be resumed yet. Raise or turn off the "
        + "daily-loss limit deliberately, or wait for the window to move on." };
    case "bot_not_found":
      return { text: "The Bot no longer has this bot. Refresh the page." };
    case "trade_not_found":
      return { text: "The Bot no longer has this trade. Refresh the page." };
    case "request_id_reused":
      return { text: "That request was already used for a different command. Start the action again." };
    case "command_in_progress":
      return { text: "The Bot is still working on this command. It will not run it twice; check the outcome shortly." };
    case "bot_channel_rejected":
      return { text: "The execution bot refused this Platform's signed request (channel configuration). The Bot did not run this." };
    case "bot_rate_limited":
      return { text: "The Bot is busy with other control requests and did not run this. Try again shortly." };
    case "bot_channel_not_configured":
      return { text: "Bot control channel not configured." };
    case "auth_disabled":
      return { text: "Bot commands need sign-in to be turned on for this installation." };
    case "two_factor_required":
    case "step_up_unavailable":
      return { profile: true, text: message };
    case "audit_unavailable":
      return { text: "The command was not sent because it could not be recorded. Try again." };
    // ── bots, accounts, enrollment (contract v2.0, C10-C19) ──────────────────
    case "bot_busy_retry":
      return { text: "The Bot is busy; try again. The Bot did not run this." };
    case "bot_has_open_trades":
      return { text: `${message} The Bot did not run this.` };
    case "bot_has_unresolved_intents":
      return { text: `${message} The Bot did not run this.` };
    case "pair_has_open_trades":
      return { text: `${message} The Bot did not run this.` };
    case "realizations_pending":
      return { text: `${message} The Bot did not run this.` };
    case "rotation_conflict":
      return { text: "The secret changed while this rotation ran. Reload the bot and try again." };
    case "account_in_use":
      return { text: `This exchange account is still in use (by a bot, an order or an open trade), so the Bot refused to remove it. ${message}` };
    case "account_not_found":
      return { text: "The Bot no longer has this exchange account. Refresh the page." };
    case "exchange_unavailable":
      return { text: "The exchange could not be reached, or refused this account's keys." };
    case "enrollment_not_configured":
      return { text: "Key enrollment is not set up on this Platform (BOT_PUBLIC_ORIGIN). Nothing was sent." };
    case "enrollment_disabled":
      return { text: "Key enrollment is turned off on the Bot (ENROLLMENT_ENABLED). Nothing was issued." };
    case "enrollment_origin_mismatch":
      return { text: message };
    case "network_mismatch":
      return { text: "A key replacement keeps the account's network. Add a new account for the other network." };
    case "mainnet_confirmation_required":
      return { text: "Type MAINNET to confirm a mainnet (real money) account." };
    case "bot_secret_unknown":
      return { text: "This Platform does not hold that bot's webhook secret. Rotate the secret on the bot's page; the new one is stored here." };
    case "delivery_not_custom":
    case "deployment_not_found":
      return { text: message };
    default:
      return { text: `The Bot refused this: ${message}` };
  }
}

/** Refusals that happen before anything is sent, and belong inside the confirm dialog. */
export const STEP_UP_CODES = new Set([
  "step_up_required", "step_up_failed", "step_up_rate_limited", "step_up_busy",
  "two_factor_required", "step_up_unavailable", "invalid_request", "invalid_request_id", "invalid_target_id",
  "mainnet_confirmation_required",
]);

/** The chart, with this symbol and the manual Trade panel open (the Screener's existing deep link). */
export function tradePanelHref(pair: string): string | null {
  const symbol = pair.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{2,24}$/.test(symbol)) return null;
  return `/chart?source=scanner&symbol=${encodeURIComponent(symbol)}&panel=manual`;
}
