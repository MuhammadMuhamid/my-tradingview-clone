import type { FastifyInstance } from "fastify";
import { MARKET_CONTRACT_VERSION } from "../../market/model";
import { providerRegistry } from "../../market/providers";
import { venueRegistry } from "../../market/venues";
import { INTERVAL_MS, type Candle, type Interval } from "../../types/market";
import { observationFreshness } from "../../market/provider";
import type { ProviderRegistry } from "../../market/registry";
import { foldBars, parseResolution, type ResolutionPlan } from "../../data/resolution";
import { resolveSpotStreamRequest, type SpotStreamKind } from "../../market/spotStreams";

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 200) : "provider unavailable";
}

function canonicalVenue(canonicalId: string): string | null {
  const match = /^instrument:v1:([A-Z][A-Z0-9_]{1,23}):/i.exec(canonicalId);
  return match?.[1] ?? null;
}

async function resolveCanonical(registry: ProviderRegistry, canonicalId: string): Promise<{
  providerId: string; providerSymbol: string;
} | null> {
  const venue = canonicalVenue(canonicalId);
  if (!venue) return null;
  for (const provider of registry.forVenue(venue)) {
    if (provider.catalog.availability.support !== "supported") continue;
    const instruments = await registry.call(provider.id, (registered) => registered.catalog.list());
    const found = instruments.find((item) => item.identity.canonicalId.toLowerCase() === canonicalId.toLowerCase());
    if (found) return { providerId: provider.id, providerSymbol: found.listing.providerSymbol };
  }
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
    const query = req.query as { q?: string; venue?: string; quote?: string; limit?: string };
    const term = (query.q ?? "").trim().toUpperCase();
    const venue = (query.venue ?? "").trim().toUpperCase();
    const quote = (query.quote ?? "").trim().toUpperCase();
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
    const results = settled.flatMap((group) => group.instruments).filter((item) => {
      if (item.listing.status !== "active") return false;
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
        status: item.listing.status, tracked: true,
      })),
      errors: settled.filter((item) => item.unavailable).map((item) =>
        ({ providerId: item.providerId, error: item.unavailable })),
    };
  });

  app.get("/api/market/v1/candles/:canonicalId", async (req, reply) => {
    const { canonicalId } = req.params as { canonicalId: string };
    const query = req.query as { interval?: string; from?: string; to?: string; limit?: string; format?: string };
    const requestedInterval = query.interval ?? "";
    if (!parseResolution(requestedInterval)) return reply.code(400).send({ error: "a canonical interval is required" });
    const limit = Math.min(Math.max(Number(query.limit ?? 1000) || 1000, 1), 200_000);
    let mapping;
    try { mapping = await resolveCanonical(registry, canonicalId); }
    catch (error) { return reply.code(502).send({ error: safeError(error) }); }
    if (!mapping) return reply.code(404).send({ error: "canonical instrument is not available" });
    const provider = registry.get(mapping.providerId)!;
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
      const rows = await registry.call(provider.id, (registered) =>
        registered.candles.fetch(mapping!.providerSymbol, plan.source, startMs, endMs, controller.signal));
      const folded = foldBars(rows, plan).filter((row) => row.openTime >= requestedStartMs && row.openTime <= endMs);
      const named = folded.slice(-limit).map((row) => ({ ...row, symbol: canonicalId })) as Candle[];
      const completeness = candleCompleteness(named, Math.max(requestedStartMs, startMs), endMs, plan.ms,
        truncated, provider.candles.pagination.limitation);
      return query.format === "compact" ? compact(named, canonicalId, requestedInterval, completeness)
        : { symbol: canonicalId, interval: requestedInterval, bars: named, completeness };
    } catch (error) {
      req.log.warn({ providerId: provider.id, err: error }, "provider candles unavailable");
      return reply.code(502).send({ error: safeError(error), providerId: provider.id,
        health: registry.health(provider.id) });
    } finally { req.raw.off("aborted", abort); }
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
      const request = await resolveSpotStreamRequest(provider.id, query.kind, mapping.providerSymbol, interval);
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
}
