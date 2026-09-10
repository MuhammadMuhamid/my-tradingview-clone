import { binanceSpotAdapter } from "./binanceSpotAdapter";
import { ProviderRegistry } from "./registry";

export const providerRegistry = new ProviderRegistry();
providerRegistry.register(binanceSpotAdapter);
