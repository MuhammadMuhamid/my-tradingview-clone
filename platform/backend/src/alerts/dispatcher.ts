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
import {
  dedupeKey as contractDedupeKey,
  isReceiverOutcome,
  legacyDedupeKey,
  mayAdvanceLocalState,
  orderPlaced,
  type ExitLeg,
  type ReceiverOutcome,
} from "../contract/webhookContract";

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

/**
 * The dedupe key both senders now produce for the same bar.
 *
 * The previous form embedded `barIndex`, and the comment here claimed it was
 * "byte-identical to f_bot_json_buy/sell_exit in the Pine". That was false:
 * Pine's `bar_index` counts from the left edge of the loaded chart history (a
 * few thousand) while this side computed `floor(epoch_ms / interval_ms)`
 * (~1.9e6 for a 15m bar in 2026), so the two sources could never produce the
 * same key for the same bar and cross-source duplicates were suppressed only by
 * the receiver's 45-second window (X-02).
 *
 * The canonical key is derived from bar OPEN TIME, which both sides agree on.
 * `barIndex` is accepted and ignored so callers do not have to change shape.
 */
export function customDedupeKey(
  action: "buy" | "sell", _barIndex: number, barTimeMs: number, exitLeg?: string
): string {
  return contractDedupeKey(action, barTimeMs, exitLeg as ExitLeg | undefined);
}

/**
 * The v0 key. Exported only so a migration or an operator query can recognise
 * historical rows. Never emit this.
 */
export const historicalDedupeKey = legacyDedupeKey;

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

  // delivery is "off" or "paper": build the custom shape so the recorded alert
  // has the same structure as a live one, and deliver nothing. The empty secret
  // is deliberate — a mode that makes no outbound call holds no credential.
  //
  // `paper` never reaches `deliver`; `liveRunner.fireAlert` branches before it
  // and simulates the fill in `engine/paperBroker.ts` instead.
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
  /**
   * `sent`     — the receiver placed an order.
   * `skipped`  — no order was placed, and none was needed (duplicate, or the
   *              receiver is already in the requested state).
   * `blocked`  — no order was placed and the receiver is NOT in the requested
   *              state: a stale-sell skip, an operator halt, or a risk refusal.
   *              The sender must not advance its position state.
   * `failed`   — delivery itself failed.
   */
  status: "sent" | "failed" | "skipped" | "blocked";
  httpStatus?: number;
  responseBody?: string;
  attempts: number;
  /** Receiver is already in the requested state, so local state may advance. */
  reconciled?: boolean;
  /** The receiver's own `status` field, when it reported one. */
  outcome?: ReceiverOutcome;
}

/**
 * May the caller advance its local position state on this delivery?
 *
 * The old test was `result.status === "sent" || result.reconciled`, and `sent`
 * was set from `res.ok` alone. The receiver answers HTTP 200 for three
 * different meanings, one of which — `ignored_stale_sell` — means no order was
 * placed and the receiver is STILL LONG. Advancing on that is how the platform
 * marks itself flat and then buys into a position it does not know it holds
 * (X-12).
 */
export function deliveryAdvancesState(result: DeliveryResult): boolean {
  if (result.outcome) return mayAdvanceLocalState(result.outcome);
  if (result.status === "sent") return true;
  return result.reconciled === true;
}

/** Did an order actually reach the exchange? Narrower than "may advance". */
export function deliveryPlacedOrder(result: DeliveryResult): boolean {
  if (result.outcome) return orderPlaced(result.outcome);
  return result.status === "sent";
}

/** Read the receiver's `status` field out of a response body, if present. */
export function parseReceiverOutcome(body: string | undefined): ReceiverOutcome | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { status?: unknown };
    return isReceiverOutcome(parsed.status) ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** POST with up to `maxAttempts` tries and exponential backoff. */
export async function deliver(
  url: string | null,
  payload: AlertPayload,
  opts: {
    maxAttempts?: number;
    timeoutMs?: number;
    allowUnsafeTestUrl?: boolean;
    /** False when the payload carries no idempotency key — then never retry. */
    idempotent?: boolean;
  } = {}
): Promise<DeliveryResult> {
  if (!url) return { status: "skipped", attempts: 0 };
  try {
    if (!opts.allowUnsafeTestUrl) url = validateWebhookUrl(url);
  } catch (e) {
    return { status: "failed", responseBody: (e as Error).message, attempts: 0 };
  }
  /*
   * BE-12: a request that timed out client-side may well have succeeded at the
   * receiver. Retrying is only safe when the payload carries an idempotency
   * key the receiver honours. The custom path does; the 3Commas payload has no
   * key at all, so it gets a single attempt rather than four.
   */
  const idempotent = opts.idempotent ?? true;
  const maxAttempts = idempotent ? (opts.maxAttempts ?? 4) : 1;
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
      const outcome = parseReceiverOutcome(lastBody);

      // A 409 is the receiver saying "I did not place an order and I am not in
      // the state you asked for". Terminal, and it must not advance state.
      if (res.status === 409 && outcome && !mayAdvanceLocalState(outcome)) {
        return { status: "blocked", httpStatus: res.status, responseBody: lastBody, attempts: attempt, outcome };
      }

      if (res.ok) {
        // `res.ok` alone is not success. The receiver returns 200 for three
        // different meanings, and one of them placed no order while leaving
        // itself long (X-12).
        if (outcome && !mayAdvanceLocalState(outcome)) {
          return { status: "blocked", httpStatus: res.status, responseBody: lastBody, attempts: attempt, outcome };
        }
        if (outcome === "ignored_duplicate") {
          return {
            status: "skipped", httpStatus: res.status, responseBody: lastBody,
            attempts: attempt, reconciled: true, outcome,
          };
        }
        return { status: "sent", httpStatus: res.status, responseBody: lastBody, attempts: attempt, outcome };
      }
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

/**
 * Base-asset quantity for the `order.amount` field of a 3Commas SELL.
 *
 * BE-20: this was `buyQuoteQty / exitPrice`, with a ternary whose two branches
 * were identical — dead code that looked like it handled the buy and sell cases
 * differently. Two things were wrong with the value:
 *
 *  1. It divided by the EXIT price. The quantity held is what the entry bought,
 *     `buyQuoteQty / entryPrice`. Dividing by a higher exit price understates
 *     the position; by a lower one, overstates it.
 *  2. It ignored partial exits. After TP1 has taken 40 %, only 60 % remains,
 *     and a full-close instruction for the original size asks the receiver to
 *     sell more base asset than the position holds.
 *
 * The custom-bot path is unaffected either way — it uses `sell_percent` against
 * the receiver's own tracked position, which is the more robust design. This
 * matters only for the 3Commas payload.
 *
 * `alreadyExitedPct` is the sum of the tiers taken so far. When the entry price
 * is unknown the exit price is the only figure available, and using it is
 * flagged rather than hidden.
 */
export function sellContracts(input: {
  buyQuoteQty: number | null;
  entryPrice: number | null;
  exitPrice: number;
  alreadyExitedPct?: number;
}): number {
  const quote = input.buyQuoteQty ?? 0;
  if (quote <= 0) return 0;
  const basisPrice = input.entryPrice && input.entryPrice > 0 ? input.entryPrice : input.exitPrice;
  if (!Number.isFinite(basisPrice) || basisPrice <= 0) return 0;
  const originalQty = quote / basisPrice;
  const exited = Math.min(100, Math.max(0, input.alreadyExitedPct ?? 0));
  return originalQty * (1 - exited / 100);
}
