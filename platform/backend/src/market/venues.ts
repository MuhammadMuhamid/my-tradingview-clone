export interface VenueDefinition {
  id: string;
  label: string;
  timezone: string;
  calendarIds: readonly string[];
}

export class VenueRegistry {
  private readonly values = new Map<string, VenueDefinition>();

  register(venue: VenueDefinition): void {
    const id = venue.id.toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(id)) throw new Error(`invalid venue id: ${venue.id}`);
    if (this.values.has(id)) throw new Error(`venue already registered: ${id}`);
    this.values.set(id, Object.freeze({ ...venue, id }));
  }

  get(id: string): VenueDefinition | null {
    return this.values.get(id.toUpperCase()) ?? null;
  }

  all(): readonly VenueDefinition[] {
    return [...this.values.values()];
  }
}

export const venueRegistry = new VenueRegistry();
venueRegistry.register({ id: "BINANCE", label: "Binance", timezone: "UTC", calendarIds: ["24x7"] });
venueRegistry.register({ id: "COINBASE", label: "Coinbase", timezone: "UTC", calendarIds: ["24x7"] });
venueRegistry.register({ id: "BYBIT", label: "Bybit", timezone: "UTC", calendarIds: ["24x7"] });
venueRegistry.register({ id: "OKX", label: "OKX", timezone: "UTC", calendarIds: ["24x7"] });
venueRegistry.register({ id: "KRAKEN", label: "Kraken", timezone: "UTC", calendarIds: ["24x7"] });
venueRegistry.register({ id: "KUCOIN", label: "KuCoin", timezone: "UTC", calendarIds: ["24x7"] });
venueRegistry.register({ id: "GATEIO", label: "Gate.io", timezone: "UTC", calendarIds: ["24x7"] });
venueRegistry.register({ id: "ROBINHOOD", label: "Robinhood Crypto", timezone: "UTC", calendarIds: ["24x7"] });
venueRegistry.register({ id: "HYPERLIQUID", label: "Hyperliquid", timezone: "UTC", calendarIds: ["24x7"] });
