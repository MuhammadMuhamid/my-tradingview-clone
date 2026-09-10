import { binanceSpotAdapter } from "./binanceSpotAdapter";
import { officialSpotAdapters } from "./officialSpotAdapters";
import { ProviderRegistry } from "./registry";

export const providerRegistry = new ProviderRegistry();
providerRegistry.register(binanceSpotAdapter);
for (const adapter of officialSpotAdapters) providerRegistry.register(adapter);
