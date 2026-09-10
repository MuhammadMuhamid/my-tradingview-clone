/** Canonical, provider-neutral market vocabulary (contract version 1). */

export const MARKET_CONTRACT_VERSION = "market.v1" as const;

export const ASSET_CLASSES = ["crypto", "equity", "fx", "commodity", "index"] as const;
export type CanonicalAssetClass = (typeof ASSET_CLASSES)[number];

export const INSTRUMENT_TYPES = [
  "spot", "perpetual", "future", "stock", "etf", "fx_pair", "commodity", "index",
] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export type Support =
  | { support: "unsupported"; reason: string }
  | { support: "supported" };

export type KnownNumber =
  | { state: "known"; value: number }
  | { state: "unknown"; reason: string };

export interface InstrumentIdentity {
  canonicalId: string;
  venueId: string;
  assetClass: CanonicalAssetClass;
  instrumentType: InstrumentType;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string;
  series:
    | { kind: "spot" }
    | { kind: "cash" }
    | { kind: "perpetual" }
    | { kind: "dated"; expiry: string; delivery: "cash" | "physical" | "provider_defined" };
}

export interface ProviderListing {
  providerId: string;
  providerSymbol: string;
  status: "active" | "halted" | "delisted" | "unknown";
}

export interface PrecisionRules {
  priceTick: KnownNumber;
  quantityLot: KnownNumber;
  minimumQuantity: KnownNumber;
  minimumNotional: KnownNumber;
  priceDecimals: KnownNumber;
  quantityDecimals: KnownNumber;
}

export type SessionModel =
  | { kind: "continuous"; timezone: "UTC"; calendarId: "24x7"; supports24x7: true }
  | {
      kind: "calendar";
      timezone: string;
      calendarId: string;
      supports24x7: false;
      weeklySessions: readonly { days: readonly number[]; open: string; close: string }[];
    };

export interface PriceRoleCapabilities {
  last: Support;
  bid: Support;
  ask: Support;
  mid: Support;
  mark: Support;
  index: Support;
}

export interface EventCapabilities {
  corporateActions:
    | { support: "unsupported"; reason: string }
    | { support: "supported"; eventTypes: readonly ("split" | "dividend" | "symbol_change" | "merger")[] };
  funding:
    | { support: "unsupported"; reason: string }
    | { support: "supported"; historical: boolean; stream: boolean };
  openInterest:
    | { support: "unsupported"; reason: string }
    | { support: "supported"; historical: boolean; stream: boolean };
}

export type DerivativeTerms =
  | { kind: "none" }
  | {
      kind: "contract";
      contractSize: number;
      multiplier: number;
      settlement: "linear" | "inverse";
      maturity:
        | { kind: "perpetual" }
        | { kind: "dated"; expiry: string; delivery: "cash" | "physical" | "provider_defined" };
    };

export interface ExecutionCapabilities {
  mutationBoundary: "bot_only";
  availability: { paper: boolean; testnet: boolean; live: boolean };
  directions: { long: boolean; short: boolean };
  shortSale:
    | { support: "unsupported"; reason: string }
    | { support: "supported"; borrowRequired: boolean; availabilityCheckRequired: boolean };
  leverage:
    | { support: "unsupported"; reason: string }
    | { support: "supported"; minimum: number; maximum: number };
  marginModes: readonly ("cash" | "cross" | "isolated")[];
  reduceOnly: boolean;
  positionModes: readonly ("one_way" | "hedge")[];
}

export interface ComplianceMetadata {
  shariah: {
    status: "unknown";
    reason: "not_classified_by_market_metadata";
    /** Existing Platform policy/snapshots remain the classification authority. */
    classificationAuthority: "platform_shariah_policy";
  };
  jurisdictionTags: readonly string[];
}

export interface CanonicalInstrument {
  contractVersion: typeof MARKET_CONTRACT_VERSION;
  identity: InstrumentIdentity;
  listing: ProviderListing;
  currency: string;
  precision: PrecisionRules;
  derivative: DerivativeTerms;
  sessions: SessionModel;
  prices: PriceRoleCapabilities;
  events: EventCapabilities;
  execution: ExecutionCapabilities;
  compliance: ComplianceMetadata;
}

const TOKEN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const VENUE = /^[A-Z][A-Z0-9_]{1,23}$/;

function token(value: string, label: string, pattern = TOKEN): string {
  const normalized = String(value).trim().toUpperCase();
  if (!pattern.test(normalized)) throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  return normalized;
}

/** The id contains economic identity only. Provider ids and symbols never enter it. */
export function canonicalInstrumentId(input: {
  venueId: string;
  instrumentType: InstrumentType;
  baseAsset: string;
  quoteAsset: string;
  settlementAsset: string;
  series: InstrumentIdentity["series"];
}): string {
  const venue = token(input.venueId, "venue", VENUE);
  const base = token(input.baseAsset, "base asset");
  const quote = token(input.quoteAsset, "quote asset");
  const settlement = token(input.settlementAsset, "settlement asset");
  const expectedSeries: Record<InstrumentType, InstrumentIdentity["series"]["kind"]> = {
    spot: "spot", perpetual: "perpetual", future: "dated", stock: "cash", etf: "cash",
    fx_pair: "cash", commodity: "cash", index: "cash",
  };
  if (input.series.kind !== expectedSeries[input.instrumentType]) {
    throw new Error(`${input.instrumentType} requires ${expectedSeries[input.instrumentType]} series semantics`);
  }
  if (input.series.kind === "dated" && !/^\d{4}-\d{2}-\d{2}$/.test(input.series.expiry)) {
    throw new Error(`dated instrument expiry must be YYYY-MM-DD: ${JSON.stringify(input.series.expiry)}`);
  }
  const series = input.series.kind === "dated"
    ? `dated-${input.series.expiry.replace(/-/g, "")}`
    : input.series.kind;
  return `instrument:v1:${venue}:${input.instrumentType}:${base}:${quote}:${settlement}:${series}`;
}

export function unknownNumber(reason: string): KnownNumber {
  return { state: "unknown", reason };
}

export function knownNumber(value: number, reasonIfUnknown: string): KnownNumber {
  return Number.isFinite(value) && value > 0
    ? { state: "known", value }
    : unknownNumber(reasonIfUnknown);
}

export const unsupported = (reason: string): Support => ({ support: "unsupported", reason });
export const supported = (): Support => ({ support: "supported" });

export const UNKNOWN_COMPLIANCE: ComplianceMetadata = Object.freeze({
  shariah: Object.freeze({
    status: "unknown" as const,
    reason: "not_classified_by_market_metadata" as const,
    classificationAuthority: "platform_shariah_policy" as const,
  }),
  jurisdictionTags: Object.freeze([]),
});
