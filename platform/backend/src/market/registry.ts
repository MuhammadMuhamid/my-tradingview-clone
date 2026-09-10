import type {
  MarketDataProviderAdapter, ProviderHealthSnapshot, ProviderHealthState,
} from "./provider";

interface MutableHealth {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  rateLimitedUntil: number | null;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, MarketDataProviderAdapter>();
  private readonly healthByProvider = new Map<string, MutableHealth>();

  register(provider: MarketDataProviderAdapter): void {
    const id = provider.id.toLowerCase();
    if (this.providers.has(id)) throw new Error(`provider already registered: ${provider.id}`);
    this.providers.set(id, provider);
    this.healthByProvider.set(id, {
      consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, rateLimitedUntil: null,
    });
  }

  get(providerId: string): MarketDataProviderAdapter | null {
    return this.providers.get(providerId.toLowerCase()) ?? null;
  }

  all(): readonly MarketDataProviderAdapter[] {
    return [...this.providers.values()];
  }

  forVenue(venueId: string): readonly MarketDataProviderAdapter[] {
    const venue = venueId.toUpperCase();
    return this.all().filter((provider) => provider.venueIds.includes(venue));
  }

  async call<T>(providerId: string, operation: (provider: MarketDataProviderAdapter) => Promise<T>,
    now = Date.now()): Promise<T> {
    const provider = this.get(providerId);
    if (!provider) throw new Error(`provider is not registered: ${providerId}`);
    const health = this.healthByProvider.get(provider.id.toLowerCase())!;
    try {
      const value = await operation(provider);
      health.consecutiveFailures = 0;
      health.lastSuccessAt = now;
      health.rateLimitedUntil = null;
      return value;
    } catch (error) {
      health.consecutiveFailures += 1;
      health.lastFailureAt = now;
      const retryAfterMs = typeof error === "object" && error !== null &&
        "retryAfterMs" in error && typeof error.retryAfterMs === "number"
        ? Math.max(0, error.retryAfterMs) : null;
      health.rateLimitedUntil = retryAfterMs === null ? null : now + retryAfterMs;
      throw error;
    }
  }

  health(providerId: string, now = Date.now()): ProviderHealthSnapshot {
    const provider = this.get(providerId);
    if (!provider) throw new Error(`provider is not registered: ${providerId}`);
    const current = this.healthByProvider.get(provider.id.toLowerCase())!;
    const stale = current.lastSuccessAt !== null && now - current.lastSuccessAt > provider.healthPolicy.staleAfterMs;
    let state: ProviderHealthState = "unknown";
    if (current.rateLimitedUntil !== null && current.rateLimitedUntil > now) state = "rate_limited";
    else if (current.consecutiveFailures >= provider.healthPolicy.unavailableAfterFailures) state = "unavailable";
    else if (current.consecutiveFailures > 0 || stale) state = "degraded";
    else if (current.lastSuccessAt !== null) state = "healthy";
    return {
      providerId: provider.id,
      state,
      consecutiveFailures: current.consecutiveFailures,
      lastSuccessAt: current.lastSuccessAt,
      lastFailureAt: current.lastFailureAt,
      stale,
      retryAfterMs: current.rateLimitedUntil === null ? null : Math.max(0, current.rateLimitedUntil - now),
    };
  }
}
