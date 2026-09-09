/**
 * Alert payload shapes. Both formats replicate EXACTLY what the Pine strategy
 * sends today, so the existing bots keep working unchanged.
 */
import type { ShariahContext } from "../contract/webhookContract";

/**
 * 3Commas Signal-bot webhook payload — mirrors
 * 3commas_alert_message_template.json field-for-field. All values are strings
 * because TradingView renders its {{placeholders}} into a string template.
 * POSTed to https://api.3commas.io/signal_bots/webhooks
 */

export interface ThreeCommasAlertPayload {
  secret: string;
  max_lag: string;            // seconds, e.g. "300"
  timestamp: string;          // {{timenow}} — ISO-8601 UTC
  trigger_price: string;      // {{close}}
  tv_exchange: string;        // "BINANCE"
  tv_instrument: string;      // {{ticker}}, e.g. "APTUSDT"
  action: "buy" | "sell";     // {{strategy.order.action}}
  bot_uuid: string;
  strategy_info: {
    market_position: string;            // "long" | "flat"
    market_position_size: string;
    prev_market_position: string;
    prev_market_position_size: string;
  };
  order: {
    amount: string;                     // {{strategy.order.contracts}}
    currency_type: "base" | "quote";
  };
}

/**
 * Custom FastAPI-bot payload — mirrors f_bot_json_buy()/f_bot_json_sell_exit()
 * in ma_riskreward_strategy.pine (lines ~1287-1294).
 *   BUY : {secret, action:"buy",  symbol, quote_order_qty, dedupe_key:"L-<bar>-<time>"}
 *   SELL: {secret, action:"sell", symbol,                  dedupe_key:"X-<bar>-<time>"}
 */
export interface CustomBotAlertPayload {
  secret: string;
  action: "buy" | "sell";
  symbol: string;             // syminfo.ticker, e.g. "APTUSDT"
  quote_order_qty?: number;   // BUY only — quote USDT to spend
  /** SELL only — percentage of the receiver's currently tracked position. Omitted = full close. */
  sell_percent?: number;
  /** Stable leg identity permits multiple legitimate exits on one candle. */
  exit_leg?: "tp1" | "tp2" | "runner" | "stop" | "signal";
  dedupe_key: string;
  /**
   * The Platform's Shariah decision for this exact order, plus the detached
   * signature that proves the Platform made it.
   *
   * The manual channel needs no such signature — its HMAC already covers the
   * whole body — but this path's only authentication is the shared secret
   * inside the body, which authorises placing an order and proves nothing about
   * a screening decision. Without the detached signature the receiver treats
   * the block as unproven: it may still refuse an entry, never authorise one.
   */
  shariah?: ShariahContext;
  shariah_ts?: string;
  shariah_sig?: string;
  /** Single-use identity of the authorisation the signature grants (v5). */
  shariah_nonce?: string;
}

export type AlertPayload = ThreeCommasAlertPayload | CustomBotAlertPayload;

/**
 * Delivery outcome as recorded on the alert row.
 *
 * `blocked` is distinct from `failed` and from `skipped`: delivery succeeded at
 * the transport level, the receiver answered, and it explicitly did NOT place
 * an order while remaining in a different state from the one requested — a
 * stale-sell skip, an operator halt, or a risk refusal. Collapsing that into
 * `sent` is finding X-12; collapsing it into `failed` would hide that the
 * receiver is holding a position.
 */
export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped" | "blocked";

export interface AlertRow {
  id: number;
  deploymentId: string;
  barTime: string;
  firedAt: string;
  action: "buy" | "sell";
  marketPosition: string;
  positionSize: number;
  /** Executable price known when the completed-candle decision was made. */
  triggerPrice: number;
  /** Earlier bracket threshold that caused the decision; never a fill claim. */
  intendedTriggerPrice: number | null;
  decisionTime: string;
  reason: string | null;
  payload: AlertPayload;
  dedupeKey: string | null;
  deliveryStatus: DeliveryStatus;
  httpStatus: number | null;
  responseBody: string | null;
  attempts: number;
  sentAt: string | null;
}
