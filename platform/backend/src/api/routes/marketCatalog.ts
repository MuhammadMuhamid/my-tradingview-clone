import type { FastifyInstance } from "fastify";
import { MARKET_CONTRACT_VERSION } from "../../market/model";
import { providerRegistry } from "../../market/providers";
import { venueRegistry } from "../../market/venues";

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 200) : "provider unavailable";
}

export async function marketCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/market/v1/providers", async () => ({
    contractVersion: MARKET_CONTRACT_VERSION,
    venues: venueRegistry.all(),
    providers: providerRegistry.all().map((provider) => ({
      id: provider.id,
      label: provider.label,
      venueIds: provider.venueIds,
      health: providerRegistry.health(provider.id),
      healthPolicy: provider.healthPolicy,
      rateLimits: provider.rateLimits,
      capabilities: {
        candles: { support: "supported", resolutions: provider.candles.resolutions },
        ticker: { support: "supported", prices: provider.ticker.prices, stream: provider.ticker.stream },
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
      ? [providerRegistry.get(requested)].filter((item) => item !== null)
      : [...providerRegistry.all()];
    if (providers.length === 0) return reply.code(404).send({ error: "provider is not registered" });
    const symbols = query.symbols?.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean) ?? [];
    if (symbols.length > 100) return reply.code(400).send({ error: "at most 100 provider symbols may be requested" });

    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        const instruments = await providerRegistry.call(provider.id, (registered) =>
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
}
