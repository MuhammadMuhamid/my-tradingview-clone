import { createHash } from "node:crypto";

/** Immutable Bot -> Platform realization event contract. */
export const REALIZATION_CONTRACT_VERSION = 1 as const;
export const REALIZATION_EVENT_TYPE = "BOT_CUSTOM_REALIZATION" as const;
export const REALIZATION_BATCH_MAX = 50;

export type RealizationKind = "partial" | "final";

export interface RealizationEventV1 {
  contractVersion: 1;
  type: "BOT_CUSTOM_REALIZATION";
  eventId: string;
  kind: RealizationKind;
  realizedAt: string;
  realizedPnlQuote: string;
  realizedQuantity: string;
  exitPrice: string;
  exitRevenueQuote: string;
  quoteCurrency: "USDT";
  symbol: string;
  positionDirection: "long";
  exitSide: "sell";
  strategyOrderIntentId: string;
  exchangeOrderId: string;
  /** Non-secret stable identity of the webhook credential that authorized the order. */
  platformWebhookIdentity: string;
  /** Present for v2 commands; null for durable events created during an old-Platform rollout. */
  platformDeploymentId: string | null;
  platformOrderIntentId: string | null;
  platformDedupeKey: string;
  exitLeg: "tp1" | "tp2" | "runner" | "stop" | "signal" | null;
  accounting: {
    pnlBasis: "modeled_fee_adjusted";
    feeModel: "fixed_rate_both_sides";
    buyFeeRate: "0.001";
    sellFeeRate: "0.001";
    commissionSource: "modeled_not_exchange_observed";
  };
}

export interface RealizationBatchV1 {
  contractVersion: 1;
  type: "BOT_CUSTOM_REALIZATION_BATCH";
  events: RealizationEventV1[];
}

const EVENT_KEYS = ["accounting", "contractVersion", "eventId", "exchangeOrderId",
  "exitLeg", "exitPrice", "exitRevenueQuote", "exitSide", "kind",
  "platformDedupeKey", "platformDeploymentId", "platformOrderIntentId",
  "platformWebhookIdentity", "positionDirection", "quoteCurrency", "realizedAt", "realizedPnlQuote",
  "realizedQuantity", "strategyOrderIntentId", "symbol", "type"] as const;
const ACCOUNTING_KEYS = ["buyFeeRate", "commissionSource", "feeModel", "pnlBasis",
  "sellFeeRate"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const SYMBOL = /^[A-Z0-9]{5,20}$/;
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
};

/** Canonical, non-exponent decimal spelling without changing its exact value. */
export function canonicalDecimal(value: string): string {
  const match = DECIMAL.exec(value);
  if (!match) throw new Error("invalid decimal");
  const negative = match[1] === "-";
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error("invalid decimal exponent");
  const digits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
  const point = whole.length + exponent - (whole.length + fraction.length - digits.length);
  let output: string;
  if (digits === "0") return "0";
  if (point <= 0) output = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) output = `${digits}${"0".repeat(point - digits.length)}`;
  else output = `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (output.includes(".")) output = output.replace(/0+$/, "").replace(/\.$/, "");
  return negative ? `-${output}` : output;
}

export function decimalFromNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("non-finite realization decimal");
  return canonicalDecimal(String(value));
}

export function canonicalTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid realization timestamp");
  return date.toISOString();
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

/** Stable one-way identity for a high-entropy webhook credential; never serialize the credential. */
export function platformWebhookIdentity(secret: string): string {
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function boundedDecimal(value: unknown, name: string, options: { positive?: boolean } = {}): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) throw new Error(`${name} must be a decimal string`);
  const normalized = canonicalDecimal(value);
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > 1e15 || (options.positive && numeric <= 0)) {
    throw new Error(`${name} is outside its allowed bounds`);
  }
  return normalized;
}

/** Strict validation plus canonical decimal and timestamp normalization. */
export function normalizeRealizationEvent(input: unknown): RealizationEventV1 {
  if (!record(input) || !exactKeys(input, EVENT_KEYS)) throw new Error("invalid realization event shape");
  if (input.contractVersion !== 1 || input.type !== REALIZATION_EVENT_TYPE) throw new Error("unsupported realization contract");
  if (input.kind !== "partial" && input.kind !== "final") throw new Error("invalid realization kind");
  if (typeof input.eventId !== "string" || !ID.test(input.eventId)
      || typeof input.strategyOrderIntentId !== "string" || !ID.test(input.strategyOrderIntentId)
      || typeof input.exchangeOrderId !== "string" || !ID.test(input.exchangeOrderId)) {
    throw new Error("invalid realization identity");
  }
  const hasDirectCorrelation = input.platformDeploymentId !== null
    || input.platformOrderIntentId !== null;
  if ((hasDirectCorrelation && (typeof input.platformDeploymentId !== "string"
        || !UUID.test(input.platformDeploymentId)
        || typeof input.platformOrderIntentId !== "string"
        || !/^[1-9]\d{0,18}$/.test(input.platformOrderIntentId)))
      || typeof input.platformWebhookIdentity !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(input.platformWebhookIdentity)
      || typeof input.platformDedupeKey !== "string" || input.platformDedupeKey.length < 1
      || input.platformDedupeKey.length > 256) throw new Error("invalid Platform correlation");
  if (typeof input.symbol !== "string" || !SYMBOL.test(input.symbol)) throw new Error("invalid realization symbol");
  if (input.quoteCurrency !== "USDT" || input.positionDirection !== "long" || input.exitSide !== "sell") {
    throw new Error("unsupported realization market semantics");
  }
  if (input.exitLeg !== null && !["tp1", "tp2", "runner", "stop", "signal"].includes(String(input.exitLeg))) {
    throw new Error("invalid realization exit leg");
  }
  if (!record(input.accounting) || !exactKeys(input.accounting, ACCOUNTING_KEYS)
      || input.accounting.pnlBasis !== "modeled_fee_adjusted"
      || input.accounting.feeModel !== "fixed_rate_both_sides"
      || input.accounting.buyFeeRate !== "0.001" || input.accounting.sellFeeRate !== "0.001"
      || input.accounting.commissionSource !== "modeled_not_exchange_observed") {
    throw new Error("unsupported realization accounting semantics");
  }
  return {
    contractVersion: 1, type: REALIZATION_EVENT_TYPE, eventId: input.eventId,
    kind: input.kind, realizedAt: canonicalTimestamp(String(input.realizedAt)),
    realizedPnlQuote: boundedDecimal(input.realizedPnlQuote, "realizedPnlQuote"),
    realizedQuantity: boundedDecimal(input.realizedQuantity, "realizedQuantity", { positive: true }),
    exitPrice: boundedDecimal(input.exitPrice, "exitPrice", { positive: true }),
    exitRevenueQuote: boundedDecimal(input.exitRevenueQuote, "exitRevenueQuote", { positive: true }),
    quoteCurrency: "USDT", symbol: input.symbol, positionDirection: "long", exitSide: "sell",
    strategyOrderIntentId: input.strategyOrderIntentId, exchangeOrderId: input.exchangeOrderId,
    platformWebhookIdentity: input.platformWebhookIdentity,
    platformDeploymentId: input.platformDeploymentId as string | null,
    platformOrderIntentId: input.platformOrderIntentId as string | null,
    platformDedupeKey: input.platformDedupeKey,
    exitLeg: input.exitLeg as RealizationEventV1["exitLeg"],
    accounting: { pnlBasis: "modeled_fee_adjusted", feeModel: "fixed_rate_both_sides",
      buyFeeRate: "0.001", sellFeeRate: "0.001",
      commissionSource: "modeled_not_exchange_observed" },
  };
}

export function normalizeRealizationBatch(input: unknown): RealizationBatchV1 {
  if (!record(input) || !exactKeys(input, ["contractVersion", "events", "type"])
      || input.contractVersion !== 1 || input.type !== "BOT_CUSTOM_REALIZATION_BATCH"
      || !Array.isArray(input.events) || input.events.length < 1
      || input.events.length > REALIZATION_BATCH_MAX) throw new Error("invalid realization batch");
  const events = input.events.map(normalizeRealizationEvent);
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    throw new Error("duplicate event identity in realization batch");
  }
  return { contractVersion: 1, type: "BOT_CUSTOM_REALIZATION_BATCH", events };
}
