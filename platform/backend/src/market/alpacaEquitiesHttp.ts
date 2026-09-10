import fs from "node:fs";
import type { Candle, Interval } from "../types/market";
import type { EquityCorporateAction, MarketCalendarDay } from "./provider";
import type {
  AlpacaEquityDependencies, NormalizedAlpacaAsset, NormalizedAlpacaTicker,
} from "./alpacaEquitiesAdapter";

export const ALPACA_DATA_ORIGIN = "https://data.alpaca.markets";
export const ALPACA_PAPER_ORIGIN = "https://paper-api.alpaca.markets";

export interface AlpacaEquityClassification {
  symbol: string;
  securityType: "stock" | "etf";
  source: string;
}

export function loadAlpacaEquityClassifications(file: string): AlpacaEquityClassification[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("ALPACA_EQUITY_CLASSIFICATION_FILE must contain a JSON array");
  return parsed.map((value, index) => {
    const row = value as Partial<AlpacaEquityClassification>;
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    const source = String(row.source ?? "").trim();
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || (row.securityType !== "stock" && row.securityType !== "etf") || !source) {
      throw new Error(`invalid Alpaca equity classification at index ${index}`);
    }
    return { symbol, securityType: row.securityType, source };
  });
}

const TIMEFRAME: Record<Interval, string | null> = {
  "1s": null, "1m": "1Min", "3m": null, "5m": "5Min", "15m": "15Min", "30m": null,
  "1h": "1Hour", "2h": null, "4h": null, "6h": null, "8h": null, "12h": null, "1d": "1Day",
};

const ET_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** Convert an unambiguous exchange-local calendar time to an exact ISO instant. */
function newYorkInstant(date: string, time: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !clock) throw new Error(`invalid Alpaca calendar value: ${date} ${time}`);
  const desired = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(clock[1]), Number(clock[2]));
  let candidate = desired;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(ET_PARTS.formatToParts(new Date(candidate))
      .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const observed = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    candidate += desired - observed;
  }
  return new Date(candidate).toISOString();
}

type Json = Record<string, unknown>;

function object(value: unknown): Json { return value !== null && typeof value === "object" ? value as Json : {}; }
function rows(value: unknown): Json[] { return Array.isArray(value) ? value.map(object) : []; }
function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createAlpacaHttpDependencies(input: {
  apiKey: string;
  apiSecret: string;
  classifications: readonly AlpacaEquityClassification[];
  fetchImpl?: typeof fetch;
}): AlpacaEquityDependencies {
  const fetchImpl = input.fetchImpl ?? fetch;
  const classification = new Map(input.classifications.map((row) => [row.symbol, row]));
  const headers = { "APCA-API-KEY-ID": input.apiKey, "APCA-API-SECRET-KEY": input.apiSecret };

  const request = async (origin: string, pathname: string, query: Record<string, string>, signal?: AbortSignal) => {
    const url = new URL(pathname, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetchImpl(url, { headers, signal });
    if (!response.ok) throw new Error(`Alpaca ${pathname} failed with HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  };

  return {
    list: async (signal) => {
      const payload = await request(ALPACA_PAPER_ORIGIN, "/v2/assets",
        { status: "active", asset_class: "us_equity" }, signal);
      return rows(payload).flatMap((asset): NormalizedAlpacaAsset[] => {
        const symbol = String(asset.symbol ?? "").toUpperCase();
        const classified = classification.get(symbol);
        const exchange = String(asset.exchange ?? "").toUpperCase();
        if (!classified || !["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS"].includes(exchange)) return [];
        const borrow = asset.borrow_status;
        return [{ symbol, name: String(asset.name ?? symbol), exchange: exchange as NormalizedAlpacaAsset["exchange"],
          securityType: classified.securityType, classificationSource: classified.source,
          status: asset.status === "active" ? "active" : "inactive", tradable: asset.tradable === true,
          fractionable: asset.fractionable === true, ...(typeof asset.shortable === "boolean" ? { shortable: asset.shortable } : {}),
          ...(borrow === "easy_to_borrow" || borrow === "hard_to_borrow" ? { borrowStatus: borrow } : {}),
        }];
      });
    },
    bars: async (symbol, interval, startMs, endMs, feed, signal) => {
      const timeframe = TIMEFRAME[interval];
      if (!timeframe) throw new Error(`Alpaca HTTP mapping does not support ${interval}`);
      const result: Candle[] = [];
      let pageToken = "";
      do {
        const payload = object(await request(ALPACA_DATA_ORIGIN, `/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
          timeframe, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
          adjustment: "raw", feed, limit: "10000", ...(pageToken ? { page_token: pageToken } : {}),
        }, signal));
        for (const bar of rows(payload.bars)) {
          const openTime = Date.parse(String(bar.t ?? ""));
          const open = number(bar.o), high = number(bar.h), low = number(bar.l), close = number(bar.c), volume = number(bar.v);
          if (![openTime, open, high, low, close, volume].every((value) => value !== null && Number.isFinite(value))) continue;
          result.push({ symbol, interval, openTime, closeTime: openTime + ({ "1m": 60_000, "5m": 300_000,
            "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000 } as Record<string, number>)[interval]! - 1,
            open: open!, high: high!, low: low!, close: close!, volume: volume! });
        }
        pageToken = typeof payload.next_page_token === "string" ? payload.next_page_token : "";
      } while (pageToken);
      return result;
    },
    tickers: async (symbols, feed, signal) => {
      const payload = object(await request(ALPACA_DATA_ORIGIN, "/v2/stocks/trades/latest",
        { symbols: symbols.join(","), feed }, signal));
      const trades = object(payload.trades);
      return symbols.flatMap((symbol): NormalizedAlpacaTicker[] => {
        const trade = object(trades[symbol]);
        const last = number(trade.p), observedAt = Date.parse(String(trade.t ?? ""));
        return last !== null && Number.isFinite(observedAt) ? [{ symbol, last, observedAt }] : [];
      });
    },
    calendar: async (startDate, endDate, signal) => rows(await request(ALPACA_PAPER_ORIGIN, "/v2/calendar",
      { start: startDate, end: endDate }, signal)).map((day): MarketCalendarDay => ({
        date: String(day.date), open: newYorkInstant(String(day.date), String(day.open)),
        close: newYorkInstant(String(day.date), String(day.close)),
      })),
    corporateActions: async (symbol, canonicalInstrumentId, startDate, endDate, signal) => {
      const output: EquityCorporateAction[] = [];
      let pageToken = "";
      do {
        const payload = object(await request(ALPACA_DATA_ORIGIN, "/v1/corporate-actions", {
          symbols: symbol, start: startDate, end: endDate, data_quality: "complete",
          types: "cash_dividend,forward_split,reverse_split,unit_split,cash_merger,stock_merger,stock_and_cash_merger,name_change",
          limit: "1000",
          ...(pageToken ? { page_token: pageToken } : {}),
        }, signal));
        const groups = object(payload.corporate_actions);
        const append = (key: string, type: EquityCorporateAction["type"]) => {
          for (const item of rows(groups[key])) {
            const exDate = String(item.ex_date ?? item.execution_date ?? item.process_date ?? "");
            if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate)) continue;
            const id = String(item.id ?? item.corporate_action_id ?? `${type}:${symbol}:${exDate}`);
            const action: EquityCorporateAction = { id, canonicalInstrumentId, providerSymbol: symbol, type,
              exDate, processDate: String(item.process_date ?? exDate), dataQuality: "complete" };
            if (type === "split") {
              const oldRate = number(item.old_rate), newRate = number(item.new_rate);
              if (oldRate !== null && oldRate > 0 && newRate !== null && newRate > 0) action.splitRatio = newRate / oldRate;
            } else if (type === "dividend") {
              const cash = number(item.cash ?? item.rate);
              if (cash !== null) action.cashAmount = cash;
              if (typeof item.currency === "string") action.currency = item.currency;
            } else if (type === "symbol_change") {
              if (typeof item.old_symbol === "string") action.oldSymbol = item.old_symbol;
              if (typeof item.new_symbol === "string") action.newSymbol = item.new_symbol;
            }
            output.push(action);
          }
        };
        append("cash_dividends", "dividend"); append("stock_splits", "split");
        append("mergers", "merger"); append("name_changes", "symbol_change");
        pageToken = typeof payload.next_page_token === "string" ? payload.next_page_token : "";
      } while (pageToken);
      return output;
    },
  };
}
