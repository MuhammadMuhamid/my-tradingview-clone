import { canonicalDisplayParts, type CanonicalInstrumentType } from "./instrument";

export type WorkstationCategory = "crypto_spot" | "crypto_derivatives" | "stocks" | "etfs" | "fx" |
  "futures" | "indices";

export const WORKSTATION_CATEGORIES: ReadonlyArray<{ id: WorkstationCategory; label: string }> = [
  { id: "crypto_spot", label: "Crypto Spot" },
  { id: "crypto_derivatives", label: "Crypto derivatives" },
  { id: "stocks", label: "Stocks" },
  { id: "etfs", label: "ETFs" },
  { id: "fx", label: "FX" },
  { id: "futures", label: "Futures" },
  { id: "indices", label: "Indices" },
];

export function categoryForType(type: CanonicalInstrumentType): WorkstationCategory {
  if (type === "spot") return "crypto_spot";
  if (type === "perpetual") return "crypto_derivatives";
  if (type === "stock") return "stocks";
  if (type === "etf") return "etfs";
  if (type === "fx_pair") return "fx";
  if (type === "future" || type === "continuous_future" || type === "commodity") return "futures";
  return "indices";
}

export function categoryForInstrument(instrument: string): WorkstationCategory {
  const parts = canonicalDisplayParts(instrument);
  return parts ? categoryForType(parts.type) : "crypto_spot";
}

/** Existing price/indicator/pattern evaluator is valid only on Binance Spot. */
export function alertCapability(instrument: string): { supported: boolean; reason: string | null;
  providerId: string; priceBasis: "last" } {
  const parts = canonicalDisplayParts(instrument);
  const supported = !parts || (parts.venue === "BINANCE" && parts.type === "spot");
  return { supported, providerId: "binance-spot", priceBasis: "last",
    reason: supported ? null : "Alerts are unavailable: this server evaluator currently supports Binance Spot last-price bars only." };
}

export function researchAssumptions(instrument: string): string[] {
  const parts = canonicalDisplayParts(instrument);
  if (!parts) return ["Engine v2-corrected", "Binance public klines", "24×7", "last-price execution and valuation"];
  if (parts.type === "spot") return ["canonical-multiasset.v1", `${parts.venue} provider feed`, "24×7", "last-price basis", "cash/long-only"];
  if (parts.type === "perpetual") return ["canonical-multiasset.v1", `${parts.venue} provider feed`, "24×7",
    "last execution / mark valuation", "historical funding required", `settlement ${parts.settlement}`];
  if (parts.type === "stock" || parts.type === "etf") return ["canonical-multiasset.v1", "regular session",
    "RAW adjustment", "explicit split/dividend events", "shorts require affirmative borrow evidence"];
  if (parts.type === "fx_pair") return ["canonical-multiasset.v1", "OTC provider quote", "MID valuation",
    "buy ask / sell bid", "OANDA New York session/DST", "rollover methodology required"];
  if (parts.type === "continuous_future") return ["canonical-multiasset.v1", "research signal series only",
    `roll ${parts.series.replace(/^continuous-/, "")}`, "no direct execution"];
  if (parts.type === "future") return ["canonical-multiasset.v1", "specific contract", `expiry ${parts.expiry}`,
    "CME Globex calendar", `settlement ${parts.settlement}`, "explicit roll/expiry"];
  return ["canonical-multiasset.v1", "reference data", "read-only / not directly tradable"];
}
