import { deliversLiveOrders } from "./types";
import type { DeliveryMode } from "./types";

export interface ActivationSummary {
  symbol: string;
  timeframe: string;
  delivery: DeliveryMode;
  buyQuoteQty: number | null;
}

/** Exact consequence the user must acknowledge before one activation. */
export function activationAcknowledgement(deployment: ActivationSummary): string {
  const subject = `${deployment.symbol} ${deployment.timeframe}`;
  const size = deployment.buyQuoteQty == null ? "configured" : `${deployment.buyQuoteQty} USDT`;

  if (deliversLiveOrders(deployment.delivery)) {
    const orders = deployment.buyQuoteQty == null
      ? "real buy orders at the configured size"
      : `real ${size} buy orders`;
    return `I understand activating ${subject} starts trading immediately and sends ${orders} to my bot.`;
  }
  if (deployment.delivery === "paper") {
    return `I understand activating ${subject} starts PAPER mode: fills are simulated at ${size} with the live 0.1 % per-side cost model, and no order is sent anywhere.`;
  }
  return `I understand activating ${subject} starts the strategy. Delivery is off, so signals are logged and no orders are sent.`;
}
