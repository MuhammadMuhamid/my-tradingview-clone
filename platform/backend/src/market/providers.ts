import { binanceSpotAdapter } from "./binanceSpotAdapter";
import { officialSpotAdapters } from "./officialSpotAdapters";
import { officialDerivativeAdapters } from "./officialDerivativeAdapters";
import { ProviderRegistry } from "./registry";
import { alpacaUsEquityAdapter } from "./alpacaEquitiesAdapter";
import { officialTraditionalAdapters } from "./officialTraditionalAdapters";

export const providerRegistry = new ProviderRegistry();
providerRegistry.register(binanceSpotAdapter);
for (const adapter of officialSpotAdapters) providerRegistry.register(adapter);
for (const adapter of officialDerivativeAdapters) providerRegistry.register(adapter);
providerRegistry.register(alpacaUsEquityAdapter);
for (const adapter of officialTraditionalAdapters) providerRegistry.register(adapter);
