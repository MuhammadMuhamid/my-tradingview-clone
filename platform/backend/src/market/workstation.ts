import type { CanonicalInstrument, InstrumentType } from "./model";

export type WorkstationCategory = "crypto_spot" | "crypto_derivatives" | "stocks" | "etfs" | "fx" |
  "futures" | "indices";

export interface ScreenerField {
  id: string;
  label: string;
  semantic: "price" | "volume" | "status" | "session" | "feed" | "adjustment" | "funding" |
    "open_interest" | "basis" | "expiry" | "roll";
}

const COMMON: ScreenerField[] = [
  { id: "listing_status", label: "Status", semantic: "status" },
  { id: "session", label: "Session", semantic: "session" },
  { id: "feed", label: "Feed", semantic: "feed" },
];
const LAST: ScreenerField = { id: "last", label: "Last", semantic: "price" };

/** Category contracts keep the Screener from displaying meaningless blanks. */
export const SCREENER_FIELDS: Readonly<Record<WorkstationCategory, readonly ScreenerField[]>> = {
  crypto_spot: [LAST, ...COMMON, { id: "volume_24h", label: "24h volume", semantic: "volume" }],
  crypto_derivatives: [LAST, ...COMMON,
    { id: "mark", label: "Mark", semantic: "price" },
    { id: "funding", label: "Funding", semantic: "funding" },
    { id: "open_interest", label: "Open interest", semantic: "open_interest" },
    { id: "basis", label: "Basis", semantic: "basis" },
    { id: "expiry", label: "Expiry", semantic: "expiry" }],
  stocks: [LAST, ...COMMON, { id: "volume", label: "Volume", semantic: "volume" },
    { id: "adjustment", label: "Adjustment", semantic: "adjustment" }],
  etfs: [LAST, ...COMMON, { id: "volume", label: "Volume", semantic: "volume" },
    { id: "adjustment", label: "Adjustment", semantic: "adjustment" }],
  fx: [...COMMON, { id: "bid", label: "Bid", semantic: "price" },
    { id: "ask", label: "Ask", semantic: "price" }, { id: "mid", label: "Mid", semantic: "price" }],
  futures: [LAST, ...COMMON, { id: "expiry", label: "Expiry", semantic: "expiry" },
    { id: "open_interest", label: "Open interest", semantic: "open_interest" },
    { id: "roll", label: "Contract / roll", semantic: "roll" }],
  indices: [LAST, ...COMMON],
};

export function workstationCategory(type: InstrumentType, assetClass?: string): WorkstationCategory {
  if (type === "spot") return "crypto_spot";
  if (type === "perpetual" || (type === "future" && assetClass === "crypto")) return "crypto_derivatives";
  if (type === "stock") return "stocks";
  if (type === "etf") return "etfs";
  if (type === "fx_pair") return "fx";
  if (type === "future" || type === "continuous_future" || type === "commodity") return "futures";
  return "indices";
}

export function screenerFieldsFor(instrument: CanonicalInstrument): readonly ScreenerField[] {
  const { instrumentType, series } = instrument.identity;
  return SCREENER_FIELDS[workstationCategory(instrumentType, instrument.identity.assetClass)].filter((field) => {
    if (field.id === "last" || field.id === "bid" || field.id === "ask" || field.id === "mid" || field.id === "mark") {
      return instrument.prices[field.id].support === "supported";
    }
    if (field.semantic === "funding") {
      return instrumentType === "perpetual" && instrument.events.funding.support === "supported";
    }
    if (field.semantic === "open_interest") {
      return instrument.events.openInterest.support === "supported" ||
        instrument.futures?.openInterest.support === "supported";
    }
    if (field.semantic === "basis") {
      return instrument.derivative.kind === "contract" &&
        instrument.prices.mark.support === "supported" && instrument.prices.index.support === "supported";
    }
    if (field.semantic === "expiry") {
      return series.kind === "dated" ||
        (instrument.derivative.kind === "contract" && instrument.derivative.maturity.kind === "dated");
    }
    if (field.semantic === "roll") return instrument.derivative.kind === "continuous_series";
    if (field.semantic === "adjustment") return instrument.equity !== undefined;
    return true;
  });
}
