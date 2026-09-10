import type { FastifyInstance } from "fastify";
import { MARKET_CONTRACT_VERSION, effectiveListingStatus, type CanonicalInstrument } from "../../market/model";
import { providerRegistry } from "../../market/providers";
import { venueRegistry } from "../../market/venues";
import { INTERVAL_MS, type Candle, type Interval } from "../../types/market";
import { observationFreshness } from "../../market/provider";
import type { ProviderRegistry } from "../../market/registry";
import { foldBars, parseResolution, type ResolutionPlan } from "../../data/resolution";
import { resolveSpotStreamRequest, type SpotStreamKind } from "../../market/spotStreams";
import { assertEquityPricePurpose, EquitySemanticError } from "../../market/usEquities";
import type { EquityAdjustmentMode, EquitySessionMode } from "../../market/provider";
import { assertTraditionalResearchSemantics, TraditionalMarketSemanticError } from "../../market/traditionalMarkets";

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 200) : "provider unavailable";
}

function canonicalVenue(canonicalId: string): string | null {
  const match = /^instrument:v1:([A-Z][A-Z0-9_]{1,23}):/i.exec(canonicalId);
  return match?.[1] ?? null;
}

async function resolveCanonical(registry: ProviderRegistry, canonicalId: string): Promise<{
  providerId: string; providerSymbol: string; instrument: CanonicalInstrument;
} | null> {
  const venue = canonicalVenue(canonicalId);
  if (!venue) return null;
  const failures: string[] = [];
  for (const provider of registry.forVenue(venue)) {
    if (provider.catalog.availability.support !== "supported") continue;
    try {
      const instruments = await registry.call(provider.id, (registered) => registered.catalog.list());
      const found = instruments.find((item) => item.identity.canonicalId.toLowerCase() === canonicalId.toLowerCase());
      if (found) return { providerId: provider.id, providerSymbol: found.listing.providerSymbol, instrument: found };
    } catch (error) { failures.push(`${provider.id}: ${safeError(error)}`); }
  }
  if (failures.length > 0) throw new Error(`canonical resolution provider failures: ${failures.join("; ")}`);
  return null;
}

function compact(rows: readonly Candle[], symbol: string, interval: string, completeness?: CandleCompleteness) {
  return { format: "compact-v1", symbol, interval,
    stepMs: resolutionMs(interval), count: rows.length,
    ...(completeness ? { completeness } : {}),
    bars: rows.map((row) => [row.openTime, row.open, row.high, row.low, row.close, row.volume]) };
}

interface ProviderResolutionPlan extends ResolutionPlan { source: Interval }
interface CandleCompleteness {
  complete: boolean; missingBars: number; truncated: boolean; limitation?: string;
}

function resolutionMs(raw: string): number {
  const plan = parseResolution(raw);
  if (!plan) throw new Error(`not a canonical resolution: ${raw}`);
  return plan.ms;
}

/** Choose only a provider-native interval that tiles the requested UTC bucket exactly. */
export function providerResolutionPlan(raw: string, resolutions: readonly Interval[]): ProviderResolutionPlan | null {
  const requested = parseResolution(raw);
  if (!requested) return null;
  let source: Interval | null = null;
  for (const candidate of resolutions) {
    const step = INTERVAL_MS[candidate];
    if (step <= requested.ms && requested.ms % step === 0 &&
      (source === null || step > INTERVAL_MS[source])) source = candidate;
  }
  if (!source) return null;
  return { ...requested, source, factor: requested.ms / INTERVAL_MS[source],
    native: requested.ms === INTERVAL_MS[source] };
}

function candleCompleteness(rows: readonly Candle[], startMs: number, endMs: number,
  stepMs: number, truncated: boolean, limitation?: string): CandleCompleteness {
  const closedEnd = Math.min(endMs, Date.now() - stepMs);
  const expected = closedEnd < startMs ? 0 : Math.floor((closedEnd - startMs) / stepMs) + 1;
  const present = new Set(rows.filter((row) => row.openTime >= startMs && row.openTime <= closedEnd &&
      (row as Candle & { complete?: boolean }).complete !== false)
    .map((row) => row.openTime)).size;
  return { complete: present >= expected, missingBars: Math.max(0, expected - present), truncated,
    ...(limitation ? { limitation } : {}) };
}

export function marketCatalogRoutesFor(registry: ProviderRegistry): (app: FastifyInstance) => Promise<void> {
  return (app) => registerMarketCatalogRoutes(app, registry);
}

export async function marketCatalogRoutes(app: FastifyInstance): Promise<void> {
  return registerMarketCatalogRoutes(app, providerRegistry);
}

async function registerMarketCatalogRoutes(app: FastifyInstance, registry: ProviderRegistry): Promise<void> {
  app.get("/api/market/v1/providers", async () => ({
    contractVersion: MARKET_CONTRACT_VERSION,
    venues: venueRegistry.all(),
    providers: registry.all().map((provider) => ({
      id: provider.id,
      label: provider.label,
      venueIds: provider.venueIds,
      health: registry.health(provider.id),
      healthPolicy: provider.healthPolicy,
      rateLimits: provider.rateLimits,
      access: provider.access,
      documentation: provider.documentation,
      capabilities: {
        catalog: provider.catalog.availability,
        candles: { ...provider.candles.availability, resolutions: provider.candles.resolutions,
          pagination: provider.candles.pagination, stream: provider.candles.stream },
        ticker: { ...provider.ticker.availability, prices: provider.ticker.prices, stream: provider.ticker.stream },
        trades: provider.trades.support === "supported" ? { support: "supported" } : provider.trades,
        orderBook: provider.orderBook.support === "supported" ? { support: "supported" } : provider.orderBook,
        derivativeMetadata: provider.derivativeMetadata.support === "supported"
          ? { support: "supported" } : provider.derivativeMetadata,
        derivatives: provider.derivatives.support === "supported"
          ? { support: "supported", stream: provider.derivatives.stream } : provider.derivatives,
        execution: provider.execution,
      },
    })),
  }));

  app.get("/api/market/v1/instruments", async (req, reply) => {
    const query = req.query as { provider?: string; symbols?: string };
    const requested = query.provider?.trim().toLowerCase();
    const providers = requested && requested !== "all"
      ? [registry.get(requested)].filter((item) => item !== null)
      : [...registry.all()];
    if (providers.length === 0) return reply.code(404).send({ error: "provider is not registered" });
    const symbols = query.symbols?.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean) ?? [];
    if (symbols.length > 100) return reply.code(400).send({ error: "at most 100 provider symbols may be requested" });

    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        const instruments = await registry.call(provider.id, (registered) =>
          symbols.length > 0 ? registered.catalog.metadata(symbols) : registered.catalog.list());
        return { providerId: provider.id, instruments };
      } catch (error) {
        req.log.warn({ providerId: provider.id, err: error }, "provider catalog unavailable");
        return { providerId: provider.id, error: safeError(error) };
      }
    }));
    return {
      contractVersion: MARKET_CONTRACT_VERSION,
      providers: settled.filter((item): item is { providerId: string; instruments: never[] } => "instruments" in item),
      errors: settled.filter((item): item is { providerId: string; error: string } => "error" in item),
    };
  });

  app.get("/api/market/v1/search", async (req) => {
    const query = req.query as { q?: string; venue?: string; quote?: string; type?: string;
      expiry?: string; underlying?: string; limit?: string };
    const term = (query.q ?? "").trim().toUpperCase();
    const venue = (query.venue ?? "").trim().toUpperCase();
    const quote = (query.quote ?? "").trim().toUpperCase();
    const type = (query.type ?? "all").trim().toLowerCase();
    const expiry = (query.expiry ?? "live").trim().toLowerCase();
    const underlying = (query.underlying ?? "").trim().toUpperCase();
    const allowedTypes = new Set(["all", "spot", "perpetual", "future", "continuous_future", "stock", "etf", "fx_pair", "commodity", "index"]);
    const allowedExpiries = new Set(["all", "live", "30d", "90d", "expired"]);
    if (!allowedTypes.has(type) || !allowedExpiries.has(expiry)) {
      return { contractVersion: MARKET_CONTRACT_VERSION, total: 0, venues: [], quotes: [], results: [],
        errors: [{ providerId: "query", error: "type/expiry filter is invalid" }] };
    }
    const limit = Math.min(Math.max(Number(query.limit ?? 60) || 60, 1), 200);
    const candidates = venue ? registry.forVenue(venue) : registry.all();
    const settled = await Promise.all(candidates.map(async (provider) => {
      if (provider.catalog.availability.support !== "supported") {
        return { providerId: provider.id, instruments: [] as never[], unavailable: provider.catalog.availability.reason };
      }
      try {
        return { providerId: provider.id,
          instruments: await registry.call(provider.id, (registered) => registered.catalog.list()) };
      } catch (error) {
        return { providerId: provider.id, instruments: [] as never[], unavailable: safeError(error) };
      }
    }));
    const now = Date.now();
    const results = settled.flatMap((group) => group.instruments).filter((item) => {
      const status = effectiveListingStatus(item, now);
      const maturity = item.derivative.kind === "contract" ? item.derivative.maturity : null;
      const expiryAt = maturity?.kind === "dated" ? Date.parse(maturity.expiresAt) : null;
      if (type === "commodity" && item.identity.assetClass !== "commodity") return false;
      if (type !== "all" && type !== "commodity" && item.identity.instrumentType !== type) return false;
      if (underlying && item.identity.baseAsset !== underlying) return false;
      if (expiry === "live" && status !== "active") return false;
      if (expiry === "expired" && status !== "delisted") return false;
      if (expiry === "30d" && (expiryAt === null || expiryAt < now || expiryAt > now + 30 * 86_400_000)) return false;
      if (expiry === "90d" && (expiryAt === null || expiryAt < now || expiryAt > now + 90 * 86_400_000)) return false;
      if (quote && item.identity.quoteAsset !== quote) return false;
      if (!term) return true;
      return item.listing.providerSymbol.toUpperCase().includes(term) ||
        item.identity.baseAsset.includes(term) || item.identity.quoteAsset.includes(term);
    }).sort((a, b) => {
      const score = (item: typeof a) => item.listing.providerSymbol.toUpperCase() === term ? 0
        : item.identity.baseAsset === term ? 1 : item.listing.providerSymbol.toUpperCase().startsWith(term) ? 2 : 3;
      return score(a) - score(b) || a.identity.baseAsset.localeCompare(b.identity.baseAsset) ||
        a.identity.venueId.localeCompare(b.identity.venueId);
    });
    return {
      contractVersion: MARKET_CONTRACT_VERSION,
      total: results.length,
      venues: venueRegistry.all().map(({ id, label }) => ({ id, label })),
      quotes: [...new Set(results.map((item) => item.identity.quoteAsset))].sort(),
      results: results.slice(0, limit).map((item) => ({
        symbol: item.listing.providerSymbol,
        canonicalId: item.identity.canonicalId, providerId: item.listing.providerId,
        providerSymbol: item.listing.providerSymbol, venueId: item.identity.venueId,
        baseAsset: item.identity.baseAsset, quoteAsset: item.identity.quoteAsset,
        settlementAsset: item.identity.settlementAsset, instrumentType: item.identity.instrumentType,
        series: item.identity.series, status: effectiveListingStatus(item, now), tracked: true,
        currency: item.currency, sessions: item.sessions, equity: item.equity, fx: item.fx,
        futures: item.futures, referenceIndex: item.referenceIndex,
        derivative: item.derivative, prices: item.prices, events: item.events, execution: item.execution,
        screener: item.equity ? { category: item.equity.securityType,
          fields: ["last", "volume", "listing_status", "session", "feed_delay", "adjustment"] } : undefined,
      })),
      errors: settled.filter((item) => item.unavailable).map((item) =>
        ({ providerId: item.providerId, error: item.unavailable })),
    };
  });

  app.get("/api/market/v1/candles/:canonicalId", async (req, reply) => {
    const { canonicalId } = req.params as { canonicalId: string };
    const query = req.query as { interval?: string; from?: string; to?: string; limit?: string; format?: string;
      adjustment?: string; session?: string; feed?: string; purpose?: string; priceBasis?: string;
      continuousAdjustment?: string; rollSchedule?: string };
    const requestedInterval = query.interval ?? "";
    if (!parseResolution(requestedInterval)) return reply.code(400).send({ error: "a canonical interval is required" });
    const limit = Math.min(Math.max(Number(query.limit ?? 1000) || 1000, 1), 200_000);
    let mapping;
    try { mapping = await resolveCanonical(registry, canonicalId); }
    catch (error) { return reply.code(502).send({ error: safeError(error) }); }
    if (!mapping) return reply.code(404).send({ error: "canonical instrument is not available" });
    const provider = registry.get(mapping.providerId)!;
    const purpose = query.purpose ?? "chart";
    if (purpose !== "chart" && purpose !== "study" && purpose !== "alert" && purpose !== "execution" && purpose !== "backtest") {
      return reply.code(400).send({ error: "purpose must be chart, study, backtest, alert or execution" });
    }
    try {
      if (mapping.instrument.fx || mapping.instrument.derivative.kind === "continuous_series" || mapping.instrument.referenceIndex) {
        assertTraditionalResearchSemantics(mapping.instrument, { purpose: purpose === "study" || purpose === "alert" ? "chart" : purpose,
          priceBasis: query.priceBasis, continuousAdjustment: query.continuousAdjustment,
          rollSchedule: query.rollSchedule });
      }
    } catch (error) {
      if (error instanceof TraditionalMarketSemanticError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
    const plan = providerResolutionPlan(requestedInterval, provider.candles.resolutions);
    if (!plan) {
      return reply.code(422).send({ error: `${provider.label} cannot serve ${requestedInterval} exactly`,
        supported: provider.candles.resolutions });
    }
    const endMs = Number(query.to ?? Date.now());
    const requestedStartMs = Number(query.from ?? endMs - (limit - 1) * plan.ms);
    let startMs = requestedStartMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      return reply.code(400).send({ error: "from/to must be a valid ascending epoch-millisecond range" });
    }
    const maximumBars = provider.candles.pagination.maximumBars;
    let truncated = false;
    if (maximumBars !== undefined) {
      const earliest = endMs - (maximumBars - 1) * INTERVAL_MS[plan.source];
      if (startMs < earliest) { startMs = earliest; truncated = true; }
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.raw.once("aborted", abort);
    try {
      if (mapping.instrument.equity) {
        if (!provider.equities) return reply.code(422).send({ error: "equity semantics are unavailable" });
        const adjustment = (query.adjustment ?? provider.equities.defaultAdjustment) as EquityAdjustmentMode;
        const session = (query.session ?? provider.equities.defaultSession) as EquitySessionMode;
        if (!provider.equities.adjustmentModes.includes(adjustment) || !provider.equities.sessionModes.includes(session)) {
          return reply.code(400).send({ error: "invalid equity adjustment/session mode" });
        }
        if (purpose === "backtest") return reply.code(422).send({ error: "equity backtest route is not enabled in X5" });
        try { assertEquityPricePurpose(adjustment, purpose, session); }
        catch (error) {
          if (error instanceof EquitySemanticError) return reply.code(error.status).send({ error: error.message });
          throw error;
        }
        const dataset = await registry.call(provider.id, (registered) => registered.equities!.fetchCandles({
          instrument: mapping.instrument, interval: plan.source, startMs, endMs, adjustment, session,
          feed: query.feed ?? "iex", signal: controller.signal,
        }));
        const folded = foldBars(dataset.bars, plan).filter((row) => row.openTime >= requestedStartMs && row.openTime <= endMs);
        const named = folded.slice(-limit).map((row) => ({ ...row, symbol: canonicalId })) as Candle[];
        const semantics = { adjustmentMode: dataset.adjustmentMode, sessionMode: dataset.sessionMode,
          phasesIncluded: dataset.phasesIncluded, feed: dataset.feed,
          executionCompatible: dataset.executionCompatible, studies: dataset.studies,
          corporateActionIds: dataset.corporateActionIds,
          completeness: dataset.completeness };
        return query.format === "compact"
          ? { ...compact(named, canonicalId, requestedInterval), marketData: semantics }
          : { symbol: canonicalId, interval: requestedInterval, bars: named, marketData: semantics };
      }
      const rows = await registry.call(provider.id, (registered) =>
        registered.candles.fetch(mapping!.providerSymbol, plan.source, startMs, endMs, controller.signal));
      const folded = foldBars(rows, plan).filter((row) => row.openTime >= requestedStartMs && row.openTime <= endMs);
      const named = folded.slice(-limit).map((row) => ({ ...row, symbol: canonicalId })) as Candle[];
      const completeness = candleCompleteness(named, Math.max(requestedStartMs, startMs), endMs, plan.ms,
        truncated, provider.candles.pagination.limitation);
      const traditional = mapping.instrument.fx ? { priceBasis: query.priceBasis, marketStructure: "otc_provider_quote",
        spreadIncluded: query.priceBasis === "bid" || query.priceBasis === "ask", providerHours: mapping.instrument.sessions,
        rollover: mapping.instrument.fx.rollover }
        : mapping.instrument.derivative.kind === "continuous_series" ? { directlyTradable: false,
          rollSchedule: query.rollSchedule, adjustment: query.continuousAdjustment,
          methodology: mapping.instrument.derivative } : mapping.instrument.futures ? { contract: mapping.instrument.futures } : undefined;
      return query.format === "compact" ? { ...compact(named, canonicalId, requestedInterval, completeness), marketData: traditional }
        : { symbol: canonicalId, interval: requestedInterval, bars: named, completeness, marketData: traditional };
    } catch (error) {
      req.log.warn({ providerId: provider.id, err: error }, "provider candles unavailable");
      return reply.code(502).send({ error: safeError(error), providerId: provider.id,
        health: registry.health(provider.id) });
    } finally { req.raw.off("aborted", abort); }
  });

  app.get("/api/market/v1/instrument/:canonicalId", async (req, reply) => {
    const { canonicalId } = req.params as { canonicalId: string };
    try {
      const mapping = await resolveCanonical(registry, canonicalId);
      if (!mapping) return reply.code(404).send({ error: "canonical instrument is not available" });
      return { contractVersion: MARKET_CONTRACT_VERSION, providerId: mapping.providerId,
        providerSymbol: mapping.providerSymbol, instrument: mapping.instrument };
    } catch (error) { return reply.code(502).send({ error: safeError(error) }); }
  });

  app.get("/api/market/v1/corporate-actions/:canonicalId", async (req, reply) => {
    const { canonicalId } = req.params as { canonicalId: string };
    const query = req.query as { start?: string; end?: string };
    let mapping;
    try { mapping = await resolveCanonical(registry, canonicalId); }
    catch (error) { return reply.code(502).send({ error: safeError(error) }); }
    if (!mapping) return reply.code(404).send({ error: "canonical instrument is not available" });
    const provider = registry.get(mapping.providerId)!;
    if (!mapping.instrument.equity || !provider.equities) {
      return reply.code(422).send({ error: "instrument has no corporate-action contract" });
    }
    const startDate = query.start ?? new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10);
    const endDate = query.end ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      return reply.code(400).send({ error: "start/end must be ascending YYYY-MM-DD dates" });
    }
    try {
      const actions = await registry.call(provider.id, (registered) => registered.equities!.corporateActions({
        instrument: mapping.instrument, startDate, endDate,
      }));
      return { contractVersion: MARKET_CONTRACT_VERSION, canonicalId, providerId: provider.id,
        dataQuality: "complete", actions };
    } catch (error) { return reply.code(502).send({ error: safeError(error), providerId: provider.id }); }
  });

  app.get("/api/market/v1/screener", async (req, reply) => {
    const query = req.query as { type?: string; session?: string; adjustment?: string };
    const type = query.type ?? "stock";
    const session = query.session ?? "regular";
    const adjustment = query.adjustment ?? "raw";
    if (type !== "stock" && type !== "etf") return reply.code(400).send({ error: "type must be stock or etf" });
    if (session !== "regular" || adjustment !== "raw") {
      return reply.code(422).send({ error: "equity screener studies are regular-session/raw-only in X4" });
    }
    const providers = registry.all().filter((provider) => provider.equities);
    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        const instruments = (await registry.call(provider.id, (item) => item.catalog.list()))
          .filter((item) => item.identity.instrumentType === type);
        const observations = instruments.length > 0
          ? await registry.call(provider.id, (item) => item.ticker.fetch(instruments.map((instrument) => instrument.listing.providerSymbol)))
          : [];
        const byId = new Map(observations.map((item) => [item.canonicalInstrumentId, item]));
        return { providerId: provider.id, rows: instruments.map((instrument) => ({
          canonicalId: instrument.identity.canonicalId, symbol: instrument.listing.providerSymbol,
          venueId: instrument.identity.venueId, instrumentType: instrument.identity.instrumentType,
          last: byId.get(instrument.identity.canonicalId)?.values.last ?? null,
          listingStatus: effectiveListingStatus(instrument), session: "regular", adjustment: "raw",
          feed: instrument.equity!.marketData.defaultFeed,
          feedDelaySeconds: instrument.equity!.marketData.feedDelaySeconds,
        })) };
      } catch (error) { return { providerId: provider.id, error: safeError(error) }; }
    }));
    return { contractVersion: MARKET_CONTRACT_VERSION, category: type, session: "regular", adjustment: "raw",
      columns: ["symbol", "venue", "last", "listing_status", "feed_delay"],
      rows: settled.flatMap((item) => "rows" in item ? item.rows : []),
      errors: settled.filter((item) => "error" in item) };
  });

  app.get("/api/market/v1/stream/:canonicalId", async (req, reply) => {
    const { canonicalId } = req.params as { canonicalId: string };
    const query = req.query as { kind?: SpotStreamKind; interval?: string };
    if (query.kind !== "ticker" && query.kind !== "candle") {
      return reply.code(400).send({ error: "kind must be ticker or candle" });
    }
    let mapping;
    try { mapping = await resolveCanonical(registry, canonicalId); }
    catch (error) { return reply.code(502).send({ error: safeError(error) }); }
    if (!mapping) return reply.code(404).send({ error: "canonical instrument is not available" });
    const provider = registry.get(mapping.providerId)!;
    const contract = query.kind === "ticker" ? provider.ticker.stream : provider.candles.stream;
    if (contract.support !== "supported") return reply.code(422).send({ error: contract.reason });
    let interval: Interval = "1m";
    if (query.kind === "candle") {
      const requested = query.interval ?? "";
      if (!provider.candles.resolutions.includes(requested as Interval) ||
        !(contract.resolutions ?? provider.candles.resolutions).includes(requested as Interval)) {
        return reply.code(422).send({ error: `${provider.label} has no native ${requested} candle stream` });
      }
      interval = requested as Interval;
    }
    try {
      const request = await resolveSpotStreamRequest(provider.id, query.kind, mapping.providerSymbol, interval,
        fetch, mapping.instrument.identity.instrumentType as "spot" | "perpetual" | "future");
      return { contractVersion: MARKET_CONTRACT_VERSION, canonicalId, providerId: provider.id,
        providerSymbol: mapping.providerSymbol, interval, request };
    } catch (error) {
      return reply.code(502).send({ error: safeError(error), providerId: provider.id });
    }
  });

  app.get("/api/market/v1/tickers", async (req, reply) => {
    const query = req.query as { instruments?: string };
    const ids = [...new Set((query.instruments ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > 100) return reply.code(400).send({ error: "instruments must contain 1..100 canonical ids" });
    const resolved = await Promise.all(ids.map(async (canonicalId) => {
      try { return { canonicalId, mapping: await resolveCanonical(registry, canonicalId), error: null }; }
      catch (error) { return { canonicalId, mapping: null, error: safeError(error) }; }
    }));
    const grouped = new Map<string, { canonicalId: string; providerSymbol: string }[]>();
    for (const item of resolved) {
      if (!item.mapping) continue;
      const group = grouped.get(item.mapping.providerId) ?? [];
      group.push({ canonicalId: item.canonicalId, providerSymbol: item.mapping.providerSymbol });
      grouped.set(item.mapping.providerId, group);
    }
    const settled = await Promise.all([...grouped].map(async ([providerId, items]) => {
      try {
        const observations = await registry.call(providerId, (provider) =>
          provider.ticker.fetch(items.map((item) => item.providerSymbol)));
        const provider = registry.get(providerId)!;
        return { providerId, observations: observations.map((row) => ({ ...row,
          freshness: observationFreshness(row.observedAt, Date.now(), provider.healthPolicy.staleAfterMs) })) };
      } catch (error) { return { providerId, error: safeError(error) }; }
    }));
    return { contractVersion: MARKET_CONTRACT_VERSION,
      providers: settled.filter((item) => "observations" in item),
      errors: [...settled.filter((item) => "error" in item),
        ...resolved.filter((item) => item.error).map((item) => ({
          providerId: registry.forVenue(canonicalVenue(item.canonicalId) ?? "")[0]?.id ?? "unknown",
          error: item.error!,
        }))],
      missing: resolved.filter((item) => !item.mapping).map((item) => item.canonicalId) };
  });

  app.get("/api/market/v1/derivatives/:canonicalId", async (req, reply) => {
    const { canonicalId } = req.params as { canonicalId: string };
    let mapping;
    try { mapping = await resolveCanonical(registry, canonicalId); }
    catch (error) { return reply.code(502).send({ error: safeError(error) }); }
    if (!mapping) return reply.code(404).send({ error: "canonical instrument is not available" });
    if (mapping.instrument.derivative.kind !== "contract") {
      return reply.code(422).send({ error: "instrument is not a derivative contract" });
    }
    const provider = registry.get(mapping.providerId)!;
    if (provider.derivatives.support !== "supported") return reply.code(422).send({ error: provider.derivatives.reason });
    try {
      const observations = await registry.call(provider.id, () => provider.derivatives.support === "supported"
        ? provider.derivatives.snapshot([mapping!.providerSymbol]) : Promise.resolve([]));
      const observation = observations[0] ?? null;
      return { contractVersion: MARKET_CONTRACT_VERSION, instrument: mapping.instrument,
        observation, freshness: observation
          ? observationFreshness(observation.observedAt, Date.now(), provider.healthPolicy.staleAfterMs) : null,
        health: registry.health(provider.id) };
    } catch (error) { return reply.code(502).send({ error: safeError(error), providerId: provider.id }); }
  });

  app.get("/api/market/v1/funding/:canonicalId", async (req, reply) => {
    const { canonicalId } = req.params as { canonicalId: string };
    const query = req.query as { from?: string; to?: string };
    const to = Number(query.to ?? Date.now()), from = Number(query.from ?? to - 30 * 86_400_000);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 366 * 86_400_000) {
      return reply.code(400).send({ error: "funding range must be ascending epoch milliseconds and at most 366 days" });
    }
    let mapping;
    try { mapping = await resolveCanonical(registry, canonicalId); }
    catch (error) { return reply.code(502).send({ error: safeError(error) }); }
    if (!mapping) return reply.code(404).send({ error: "canonical instrument is not available" });
    if (mapping.instrument.identity.instrumentType !== "perpetual") {
      return reply.code(422).send({ error: "funding applies only to perpetual contracts" });
    }
    const provider = registry.get(mapping.providerId)!;
    if (provider.derivatives.support !== "supported") return reply.code(422).send({ error: provider.derivatives.reason });
    if (provider.derivatives.fundingHistory.support !== "supported") {
      return reply.code(422).send({ error: provider.derivatives.fundingHistory.reason });
    }
    try { return { contractVersion: MARKET_CONTRACT_VERSION, canonicalId,
      observations: await registry.call(provider.id, () => provider.derivatives.support === "supported" &&
        provider.derivatives.fundingHistory.support === "supported"
        ? provider.derivatives.fundingHistory.fetch(mapping!.providerSymbol, from, to) : Promise.resolve([])) };
    } catch (error) { return reply.code(502).send({ error: safeError(error), providerId: provider.id }); }
  });

  app.get("/api/market/v1/compare", async (req, reply) => {
    const query = req.query as { base?: string; type?: string };
    const base = (query.base ?? "").trim().toUpperCase();
    const type = (query.type ?? "perpetual").trim().toLowerCase();
    if (!/^[A-Z0-9._-]{1,32}$/.test(base) || !["perpetual", "future"].includes(type)) {
      return reply.code(400).send({ error: "base and derivative type are required" });
    }
    const providers = registry.all().filter((provider) => provider.derivatives.support === "supported");
    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        const instruments = (await registry.call(provider.id, (p) => p.catalog.list())).filter((item) =>
          item.identity.baseAsset === base && item.identity.instrumentType === type && effectiveListingStatus(item) === "active");
        const derivative = provider.derivatives;
        const observations = derivative.support === "supported"
          ? await registry.call(provider.id, () => derivative.snapshot(instruments.map((item) => item.listing.providerSymbol))) : [];
        return { providerId: provider.id, instruments, observations };
      } catch (error) { return { providerId: provider.id, error: safeError(error) }; }
    }));
    return { contractVersion: MARKET_CONTRACT_VERSION, base, type,
      providers: settled.filter((item) => "instruments" in item), errors: settled.filter((item) => "error" in item) };
  });
}
