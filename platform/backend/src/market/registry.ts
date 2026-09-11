import type {
  MarketDataProviderAdapter, ProviderHealthSnapshot, ProviderHealthState,
} from "./provider";
import type { CanonicalInstrument } from "./model";

interface MutableHealth {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  rateLimitedUntil: number | null;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, MarketDataProviderAdapter>();
  private readonly healthByProvider = new Map<string, MutableHealth>();
  private readonly catalogCache = new Map<string, { expiresAt: number; value: readonly CanonicalInstrument[] }>();
  private readonly catalogInflight = new Map<string, Promise<readonly CanonicalInstrument[]>>();

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

  /**
   * One bounded provider catalog read shared by search, watchlists, metadata and
   * rapid symbol switching. A 100-row mixed watchlist must not turn into 100
   * identical upstream directory requests; concurrent misses coalesce too.
   */
  async catalog(providerId: string, now = Date.now(), ttlMs = 15_000): Promise<readonly CanonicalInstrument[]> {
    const id = providerId.toLowerCase();
    const cached = this.catalogCache.get(id);
    if (cached && cached.expiresAt > now) return cached.value;
    const active = this.catalogInflight.get(id);
    if (active) return active;
    const request = this.call(providerId, async (provider) => {
      if (provider.catalog.availability.support !== "supported") throw new Error(provider.catalog.availability.reason);
      return provider.catalog.list();
    }, now).then((value) => {
      this.catalogCache.set(id, { expiresAt: now + Math.max(0, ttlMs), value });
      return value;
    }).finally(() => this.catalogInflight.delete(id));
    this.catalogInflight.set(id, request);
    return request;
  }

  clearCatalog(providerId?: string): void {
    if (providerId) this.catalogCache.delete(providerId.toLowerCase());
    else this.catalogCache.clear();
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
