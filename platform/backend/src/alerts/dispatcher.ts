/**
 * Alert dispatch — builds the exact payload the strategy sends today and POSTs
 * it to the configured bot with bounded retries. Payload shapes are frozen
 * contracts from ma_riskreward_strategy.pine and 3commas_alert_message_template.json.
 */
import type {
  AlertPayload, CustomBotAlertPayload, ThreeCommasAlertPayload,
} from "../types/alerts";
import type { DeploymentRow } from "../types/deployments";
import { config } from "../config";

export interface SignalContext {
  action: "buy" | "sell";
  price: number;
  barTime: number;
  barIndex: number;
  /** position AFTER this signal */
  marketPosition: "long" | "flat";
  positionSize: number;
  prevMarketPosition: "long" | "flat";
  prevPositionSize: number;
  /** base-asset contracts for the order (sell = full close size) */
  contracts: number;
  /** Custom receiver partial close. Omit for legacy/full SELL behavior. */
  sellPercent?: number;
  exitLeg?: "tp1" | "tp2" | "runner" | "stop" | "signal";
}

export interface BuiltAlert {
  payload: AlertPayload;
  dedupeKey: string | null;
  url: string | null;
}

export function validateWebhookUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid webhook URL"); }
  if (url.protocol !== "https:") throw new Error("webhook URL must use HTTPS");
  if (url.username || url.password) throw new Error("webhook URL credentials are forbidden");
  if (!config.allowedWebhookHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`webhook host is not allowed: ${url.hostname}`);
  }
  if (url.port && url.port !== "443") throw new Error("webhook URL must use port 443");
  return url.toString();
}

/** custom-bot dedupe key, byte-identical to f_bot_json_buy/sell_exit in the Pine. */
export function customDedupeKey(
  action: "buy" | "sell", barIndex: number, barTimeMs: number, exitLeg?: string
): string {
  const prefix = action === "buy" ? "L" : "X";
  return `${prefix}-${barIndex}-${barTimeMs}${exitLeg ? `-${exitLeg}` : ""}`;
}

export function buildPayload(dep: DeploymentRow, ctx: SignalContext): BuiltAlert {
  if (dep.delivery === "custom") {
    const dedupeKey = customDedupeKey(ctx.action, ctx.barIndex, ctx.barTime, ctx.exitLeg);
    const payload: CustomBotAlertPayload = {
      secret: dep.secret ?? "",
      action: ctx.action,
      symbol: dep.symbol,
      dedupe_key: dedupeKey,
      ...(ctx.action === "buy" ? { quote_order_qty: dep.buyQuoteQty ?? 0 } : {}),
      ...(ctx.action === "sell" && ctx.sellPercent != null
        ? { sell_percent: ctx.sellPercent, exit_leg: ctx.exitLeg }
        : {}),
    };
    return { payload, dedupeKey, url: dep.webhookUrl };
  }

  if (dep.delivery === "3commas") {
    // TradingView renders every {{placeholder}} as a string, so all fields are strings.
    const payload: ThreeCommasAlertPayload = {
      secret: dep.secret ?? "",
      max_lag: "300",
      timestamp: new Date(ctx.barTime).toISOString(),
      trigger_price: String(ctx.price),
      tv_exchange: "BINANCE",
      tv_instrument: dep.symbol,
      action: ctx.action,
      bot_uuid: dep.botUuid ?? "",
      strategy_info: {
        market_position: ctx.marketPosition,
        market_position_size: String(ctx.positionSize),
        prev_market_position: ctx.prevMarketPosition,
        prev_market_position_size: String(ctx.prevPositionSize),
      },
      order: {
        amount: String(ctx.contracts),
        currency_type: "base",
      },
    };
    const url = dep.webhookUrl ?? "https://api.3commas.io/signal_bots/webhooks";
    return { payload, dedupeKey: null, url };
  }

  // delivery === "off": build the custom shape for logging, deliver nothing.
  const dedupeKey = customDedupeKey(ctx.action, ctx.barIndex, ctx.barTime, ctx.exitLeg);
  const payload: CustomBotAlertPayload = {
    secret: "",
    action: ctx.action,
    symbol: dep.symbol,
    dedupe_key: dedupeKey,
    ...(ctx.action === "buy" ? { quote_order_qty: dep.buyQuoteQty ?? 0 } : {}),
    ...(ctx.action === "sell" && ctx.sellPercent != null
      ? { sell_percent: ctx.sellPercent, exit_leg: ctx.exitLeg }
      : {}),
  };
  return { payload, dedupeKey, url: null };
}

export interface DeliveryResult {
  status: "sent" | "failed" | "skipped";
  httpStatus?: number;
  responseBody?: string;
  attempts: number;
  /** Receiver is already in the requested state, so local state may advance. */
  reconciled?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** POST with up to `maxAttempts` tries and exponential backoff. */
export async function deliver(
  url: string | null,
  payload: AlertPayload,
  opts: { maxAttempts?: number; timeoutMs?: number; allowUnsafeTestUrl?: boolean } = {}
): Promise<DeliveryResult> {
  if (!url) return { status: "skipped", attempts: 0 };
  try {
    if (!opts.allowUnsafeTestUrl) url = validateWebhookUrl(url);
  } catch (e) {
    return { status: "failed", responseBody: (e as Error).message, attempts: 0 };
  }
  const maxAttempts = opts.maxAttempts ?? 4;
  const timeoutMs = opts.timeoutMs ?? 8000;
  let lastStatus: number | undefined;
  let lastBody: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      lastStatus = res.status;
      lastBody = (await res.text()).slice(0, 1000);
      if (res.ok) return { status: "sent", httpStatus: res.status, responseBody: lastBody, attempts: attempt };
      // A dashboard/manual close can reach the receiver before this strategy
      // exit. The desired state is already flat, so reconcile instead of
      // retrying the same SELL on every subsequent bar.
      if (
        res.status === 400 &&
        "action" in payload &&
        String(payload.action).toLowerCase() === "sell" &&
        /No active SmartTrade for\s+/i.test(lastBody)
      ) {
        return {
          status: "skipped",
          httpStatus: res.status,
          responseBody: lastBody,
          attempts: attempt,
          reconciled: true,
        };
      }
      // 4xx (except 429) won't succeed on retry — stop early.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return { status: "failed", httpStatus: res.status, responseBody: lastBody, attempts: attempt };
      }
    } catch (err) {
      lastBody = (err as Error).message;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) await sleep(500 * 2 ** (attempt - 1));
  }
  return { status: "failed", httpStatus: lastStatus, responseBody: lastBody, attempts: maxAttempts };
}
