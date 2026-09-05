-- ════════════════════════════════════════════════════════════════════════════
-- Venue-qualified instrument identity — additive, and true of every existing row
-- ════════════════════════════════════════════════════════════════════════════
--
-- `symbols` has always held Binance crypto-spot pairs, keyed by a bare ticker.
-- That is still the key, still the contract form and still what the Bot, the
-- layouts, the watchlists, the alerts, the journal, the deployments and the
-- strategy manifests all carry. Nothing here changes any of that.
--
-- What is added is the ability to SAY what those rows already mean: which venue
-- they came from and which asset class they are. Both columns are NOT NULL with
-- the only defaults this installation has, so every pre-existing row is correct
-- the moment the migration commits and no historical data is rewritten.
--
-- This does NOT implement a second venue or a second asset class. It makes the
-- identity expressible so that implementing one later is an INSERT and a
-- provider, rather than a schema change threaded through a dozen tables. See
-- `src/types/instrument.ts` for the resolver, and note in particular that
-- BINANCE_US is deliberately NOT registered: it is a different exchange with a
-- different listing set, not a host variant of this one.

ALTER TABLE symbols
  ADD COLUMN IF NOT EXISTS venue       text NOT NULL DEFAULT 'BINANCE',
  ADD COLUMN IF NOT EXISTS asset_class text NOT NULL DEFAULT 'crypto_spot';

-- Venue tokens are the same shape the resolver accepts, so a row can never
-- hold an identity the application would refuse to parse.
ALTER TABLE symbols DROP CONSTRAINT IF EXISTS symbols_venue_ck;
ALTER TABLE symbols
  ADD CONSTRAINT symbols_venue_ck CHECK (venue ~ '^[A-Z][A-Z0-9_]{1,23}$');

-- Spot only. Futures, margin, leverage, shorts and forex are permanently out of
-- scope for this product, so an asset class naming one of them is not a value
-- this table should be able to hold. Widening this list is the deliberate,
-- visible act that adding an asset class ought to be.
ALTER TABLE symbols DROP CONSTRAINT IF EXISTS symbols_asset_class_ck;
ALTER TABLE symbols
  ADD CONSTRAINT symbols_asset_class_ck CHECK (asset_class IN ('crypto_spot'));

-- Listing one venue's instruments is the query a venue-aware surface makes.
CREATE INDEX IF NOT EXISTS symbols_venue_idx ON symbols (venue, symbol);
