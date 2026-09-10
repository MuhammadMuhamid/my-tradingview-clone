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
