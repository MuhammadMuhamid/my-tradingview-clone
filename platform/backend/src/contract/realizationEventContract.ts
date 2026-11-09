import { createHash } from "node:crypto";

/**
 * Immutable Bot -> Platform realization event contract.
 *
 * This file is copied byte-for-byte into the Bot repository; it imports only
 * `node:crypto` so the two copies can stay identical.
 *
 * ── Versions ───────────────────────────────────────────────────────────────
 *
 * v1  the original keys, exactly. Unchanged, so an old Bot keeps working and
 *     every stored v1 hash stays valid.
 * v2  (owner decision OD-5) the v1 keys PLUS a required `environment`:
 *     "DRY_RUN" | "TESTNET" | "MAINNET" | "UNKNOWN", the environment of the
 *     SELL that realized it, as the Bot recorded it when it placed the order.
 *     A batch and every event in it share one version. Unknown keys are still
 *     refused at every level.
 *
 * Rollout is Platform first: a Platform that accepts v2 says so by answering
 * an accepted ingest with `capabilities: ["realization.v2"]`
 * (`REALIZATION_CAPABILITIES`), and a Bot sends v2 only after it has seen that.
 *
 * The payload hash is sha256 of `canonicalJson(normalizedEvent)`. A v2 event's
 * hash covers `environment` and `contractVersion: 2`, so re-sending one event
 * id under the other version is an integrity conflict (409), by design.
 */
export const REALIZATION_CONTRACT_VERSION = 1 as const;
export const REALIZATION_CONTRACT_VERSIONS = [1, 2] as const;
export type RealizationContractVersion = typeof REALIZATION_CONTRACT_VERSIONS[number];
export const REALIZATION_EVENT_TYPE = "BOT_CUSTOM_REALIZATION" as const;
export const REALIZATION_BATCH_MAX = 50;
/** What an accepting Platform advertises in its ingest answer. */
export const REALIZATION_CAPABILITY_V2 = "realization.v2" as const;
export const REALIZATION_CAPABILITIES: readonly string[] = [REALIZATION_CAPABILITY_V2];

/** v2 only. UNKNOWN is a valid declaration ("the Bot cannot say"); it is never real money. */
export const REALIZATION_ENVIRONMENTS = ["DRY_RUN", "TESTNET", "MAINNET", "UNKNOWN"] as const;
export type RealizationEnvironment = typeof REALIZATION_ENVIRONMENTS[number];

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

export interface RealizationEventV2 extends Omit<RealizationEventV1, "contractVersion"> {
  contractVersion: 2;
  environment: RealizationEnvironment;
}

export interface RealizationBatchV2 {
  contractVersion: 2;
  type: "BOT_CUSTOM_REALIZATION_BATCH";
  events: RealizationEventV2[];
}

export type RealizationEvent = RealizationEventV1 | RealizationEventV2;
export type RealizationBatch = RealizationBatchV1 | RealizationBatchV2;

const EVENT_KEYS = ["accounting", "contractVersion", "eventId", "exchangeOrderId",
  "exitLeg", "exitPrice", "exitRevenueQuote", "exitSide", "kind",
  "platformDedupeKey", "platformDeploymentId", "platformOrderIntentId",
  "platformWebhookIdentity", "positionDirection", "quoteCurrency", "realizedAt", "realizedPnlQuote",
  "realizedQuantity", "strategyOrderIntentId", "symbol", "type"] as const;
const EVENT_KEYS_V2 = [...EVENT_KEYS, "environment"] as const;
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

/**
 * Strict validation plus canonical decimal and timestamp normalization. A v1
 * event normalizes to exactly the v1 keys (its hash never changes); a v2 event
 * to the v1 keys plus `environment`.
 */
export function normalizeRealizationEvent(input: unknown): RealizationEvent {
  if (!record(input)) throw new Error("invalid realization event shape");
  const version = input.contractVersion;
  if ((version !== 1 && version !== 2) || input.type !== REALIZATION_EVENT_TYPE) {
    throw new Error("unsupported realization contract");
  }
  if (!exactKeys(input, version === 2 ? EVENT_KEYS_V2 : EVENT_KEYS)) throw new Error("invalid realization event shape");
  if (version === 2 && !(REALIZATION_ENVIRONMENTS as readonly unknown[]).includes(input.environment)) {
    throw new Error("invalid realization environment");
  }
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
  const v1: RealizationEventV1 = {
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
  if (version === 1) return v1;
  return { ...v1, contractVersion: 2, environment: input.environment as RealizationEnvironment };
}

/** A batch and every event in it share one version: a v2 batch of v1 events (or the reverse) is refused. */
export function normalizeRealizationBatch(input: unknown): RealizationBatch {
  if (!record(input) || !exactKeys(input, ["contractVersion", "events", "type"])
      || (input.contractVersion !== 1 && input.contractVersion !== 2)
      || input.type !== "BOT_CUSTOM_REALIZATION_BATCH"
      || !Array.isArray(input.events) || input.events.length < 1
      || input.events.length > REALIZATION_BATCH_MAX) throw new Error("invalid realization batch");
  const version = input.contractVersion;
  const events = input.events.map(normalizeRealizationEvent);
  if (events.some((event) => event.contractVersion !== version)) {
    throw new Error("realization batch and event versions differ");
  }
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    throw new Error("duplicate event identity in realization batch");
  }
  return version === 1
    ? { contractVersion: 1, type: "BOT_CUSTOM_REALIZATION_BATCH", events: events as RealizationEventV1[] }
    : { contractVersion: 2, type: "BOT_CUSTOM_REALIZATION_BATCH", events: events as RealizationEventV2[] };
}

/** The environment a stored realization declares: v2's value, with UNKNOWN (and every v1 event) stored as NULL. */
export function declaredEnvironmentOf(event: RealizationEvent): "DRY_RUN" | "TESTNET" | "MAINNET" | null {
  return event.contractVersion === 2 && event.environment !== "UNKNOWN" ? event.environment : null;
}
