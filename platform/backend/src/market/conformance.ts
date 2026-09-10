import { MARKET_CONTRACT_VERSION, type CanonicalInstrument } from "./model";
import type { MarketDataProviderAdapter } from "./provider";

export interface ConformanceFailure { check: string; detail: string }
export interface ConformanceReport {
  providerId: string;
  passed: boolean;
  checks: number;
  failures: readonly ConformanceFailure[];
}

/**
 * Deterministic adapter contract runner. Later providers use this unchanged;
 * only their fixture adapter and fixture payload differ.
 */
export async function runProviderConformance(
  provider: MarketDataProviderAdapter,
  fixture: { providerSymbol: string; interval: "1m"; startMs: number; endMs: number },
): Promise<ConformanceReport> {
  const failures: ConformanceFailure[] = [];
  let checks = 0;
  const check = (condition: unknown, name: string, detail: string): void => {
    checks += 1;
    if (!condition) failures.push({ check: name, detail });
  };
  const inspect = (instrument: CanonicalInstrument): void => {
    check(instrument.contractVersion === MARKET_CONTRACT_VERSION, "contract-version", "instrument contract version differs");
    check(instrument.identity.canonicalId.startsWith("instrument:v1:"), "canonical-id", "canonical id is not versioned");
    check(instrument.identity.canonicalId !== instrument.listing.providerSymbol, "provider-symbol-separation", "canonical id equals provider symbol");
    check(instrument.listing.providerId === provider.id, "provider-mapping", "listing maps to another provider");
    check(instrument.sessions.kind === "continuous" || instrument.sessions.kind === "calendar", "sessions", "session model is not explicit");
    check(instrument.derivative.kind === "contract" || instrument.identity.instrumentType === "spot" ||
      ["stock", "etf", "fx_pair", "commodity", "index"].includes(instrument.identity.instrumentType),
    "derivative-terms", "derivative has no contract terms");
    check(instrument.compliance.shariah.status === "unknown", "compliance-truth", "provider metadata invented a Shariah classification");
    check(instrument.execution.mutationBoundary === "bot_only", "credential-boundary", "adapter claims an order-mutation boundary");
    check(instrument.events.corporateActions.support === "supported" ||
      instrument.events.corporateActions.support === "unsupported", "corporate-actions", "corporate-action semantics are absent");
  };

  try {
    const catalog = await provider.catalog.list();
    check(catalog.length > 0, "catalog", "catalog returned no fixture instruments");
    for (const instrument of catalog) inspect(instrument);
    const ids = catalog.map((item) => item.identity.canonicalId);
    check(new Set(ids).size === ids.length, "identity-unique", "catalog contains duplicate canonical ids");

    const metadata = await provider.catalog.metadata([fixture.providerSymbol]);
    check(metadata.length === 1, "metadata", "metadata did not return exactly one fixture instrument");
    if (metadata[0]) inspect(metadata[0]);

    const candles = await provider.candles.fetch(
      fixture.providerSymbol, fixture.interval, fixture.startMs, fixture.endMs,
    );
    check(candles.every((bar) => bar.symbol === fixture.providerSymbol), "candles", "candle provider symbols drifted");
    check(candles.every((bar) => bar.openTime >= fixture.startMs && bar.openTime <= fixture.endMs),
      "candle-bounds", "candles escaped requested bounds");

    const tickers = await provider.ticker.fetch([fixture.providerSymbol]);
    check(tickers.length === 1, "ticker", "ticker did not return exactly one fixture observation");
    if (tickers[0] && metadata[0]) {
      check(tickers[0].canonicalInstrumentId === metadata[0].identity.canonicalId,
        "ticker-identity", "ticker is not bound to canonical metadata");
    }
    check(provider.healthPolicy.staleAfterMs > 0, "staleness-policy", "staleAfterMs must be positive");
    check(provider.rateLimits.retry.maxAttempts > 0, "retry-policy", "retry attempts must be bounded and positive");
    check(provider.trades.support === "supported" || provider.trades.support === "unsupported",
      "trades-capability", "trades capability is absent");
    check(provider.orderBook.support === "supported" || provider.orderBook.support === "unsupported",
      "order-book-capability", "order-book capability is absent");
    if (provider.derivativeMetadata.support === "supported") {
      const derivatives = await provider.derivativeMetadata.fetch([fixture.providerSymbol]);
      check(derivatives.every((item) => item.derivative.kind === "contract"),
        "derivative-metadata", "derivative metadata returned a non-contract instrument");
    } else {
      check(provider.derivativeMetadata.reason.length > 0, "derivative-metadata",
        "unsupported derivative metadata has no reason");
    }
  } catch (error) {
    failures.push({ check: "adapter-call", detail: error instanceof Error ? error.message : String(error) });
  }
  return { providerId: provider.id, passed: failures.length === 0, checks, failures };
}
