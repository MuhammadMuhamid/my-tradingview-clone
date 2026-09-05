/**
 * Where market data comes from, written down instead of scattered.
 *
 * ── What this changes: nothing ─────────────────────────────────────────────
 *
 * The primary REST origin, the alternates, the host allowlist and the stream
 * origins are exactly what this build already used — `config`'s
 * `BINANCE_MARKET_DATA_HOSTS` for REST and the browser's own
 * `MARKET_STREAM_ORIGINS` for the websocket. This is a description of that
 * policy in one shape, not a new policy: no endpoint is added, none is
 * removed, and nothing here loosens the allowlist that makes a mistyped host
 * a startup failure rather than a silent price source.
 *
 * ── Why write it down at all ───────────────────────────────────────────────
 *
 * Because "which hosts may this process talk to for prices" is currently three
 * separate facts in three files, and a second provider — whenever one is
 * actually implemented — would make it six. A profile makes the answer one
 * object that a facade, an operator surface and a CSP review can all read.
 *
 * ── Binance.US ─────────────────────────────────────────────────────────────
 *
 * Absent, deliberately. It is a different venue (see `types/instrument`), not
 * a host variant of this one, and it is not registered.
 */
import { BINANCE_MARKET_DATA_HOSTS, DEFAULT_BINANCE_MARKET_DATA_BASE_URL } from "../config";
import { CRYPTO_SPOT, DEFAULT_VENUE, type AssetClass } from "../types/instrument";

export interface ProviderProfile {
  /** Stable id for the implementation this profile describes. */
  id: string;
  label: string;
  venue: string;
  assetClass: AssetClass;

  /** Default REST origin when nothing is configured. */
  restPrimary: string;
  /**
   * Public market-data-only origins that serve the identical REST surface.
   * Present so an operator can be shown the supported escape hatch rather than
   * inventing one; selection remains `BINANCE_MARKET_DATA_BASE_URL`'s job.
   */
  restAlternates: readonly string[];
  /** Every host the REST allowlist accepts. A value outside it fails at boot. */
  restAllowedHosts: readonly string[];

  /**
   * Websocket origins the BROWSER tries, in order. The first is Binance's
   * public market-data mirror, which answers on networks where the main stream
   * host is fenced; the fallback is the main host. Mirrored here so the
   * profile is complete, and asserted against the browser's own list by test.
   */
  streamOrigins: readonly string[];

  /**
   * What is knowingly NOT covered. Availability by region is a real property
   * of these hosts and is recorded as an observation, never as a mechanism:
   * nothing in this repository routes around a geographic restriction.
   */
  notes: readonly string[];
}

/**
 * The browser's stream origins.
 *
 * Duplicated rather than imported because the backend does not import browser
 * modules and vice versa; `tests/providerProfile.test.ts` asserts the two
 * lists are identical, so the duplication cannot drift silently.
 */
export const BINANCE_STREAM_ORIGINS: readonly string[] = [
  "wss://data-stream.binance.vision",
  "wss://stream.binance.com:9443",
];

export const BINANCE_SPOT_PROFILE: ProviderProfile = Object.freeze({
  id: "binance-spot",
  label: "Binance Spot (public market data)",
  venue: DEFAULT_VENUE,
  assetClass: CRYPTO_SPOT,

  restPrimary: DEFAULT_BINANCE_MARKET_DATA_BASE_URL,
  restAlternates: Object.freeze(["https://data-api.binance.vision"]),
  restAllowedHosts: Object.freeze([...BINANCE_MARKET_DATA_HOSTS]),

  streamOrigins: Object.freeze([...BINANCE_STREAM_ORIGINS]),

  notes: Object.freeze([
    "Public endpoints only: no credential is ever attached, and no account or " +
      "order endpoint is reachable through this profile.",
    "api.binance.com answers HTTP 451 from some regions; data-api.binance.vision " +
      "serves the identical public market-data surface and is the supported " +
      "alternative. Selecting it is a deployment decision, not a runtime bypass.",
    "Binance.US is a separate venue and is not registered — see types/instrument.",
  ]),
}) as ProviderProfile;

/** Every profile this build implements. One, for now, and that is the point. */
export const PROVIDER_PROFILES: readonly ProviderProfile[] = Object.freeze([
  BINANCE_SPOT_PROFILE,
]);

export function providerProfileFor(venue: string): ProviderProfile | null {
  const upper = venue.toUpperCase();
  return PROVIDER_PROFILES.find((p) => p.venue === upper) ?? null;
}
