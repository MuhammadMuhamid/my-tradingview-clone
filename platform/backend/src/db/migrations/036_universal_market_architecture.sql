-- X0 canonical market identity. Existing V2 tables remain compatibility
-- projections keyed by Binance provider symbols; no historical key is renamed.

CREATE TABLE market_venues (
  id          text PRIMARY KEY CHECK (id ~ '^[A-Z][A-Z0-9_]{1,23}$'),
  label       text NOT NULL,
  timezone    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE market_providers (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,47}$'),
  label       text NOT NULL,
  metadata    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE canonical_instruments (
  canonical_id       text PRIMARY KEY CHECK (canonical_id LIKE 'instrument:v1:%'),
  venue_id           text NOT NULL REFERENCES market_venues(id),
  asset_class        text NOT NULL CHECK (asset_class IN ('crypto','equity','fx','commodity','index')),
  instrument_type    text NOT NULL CHECK (instrument_type IN
    ('spot','perpetual','future','stock','etf','fx_pair','commodity','index')),
  base_asset         text NOT NULL,
  quote_asset        text NOT NULL,
  settlement_asset   text NOT NULL,
  currency           text NOT NULL,
  series             jsonb NOT NULL,
  precision_rules    jsonb NOT NULL,
  session_model      jsonb NOT NULL,
  price_capabilities jsonb NOT NULL,
  derivative_terms   jsonb NOT NULL,
  event_capabilities jsonb NOT NULL,
  execution_capabilities jsonb NOT NULL,
  compliance_metadata jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, instrument_type, base_asset, quote_asset, settlement_asset, series)
);

CREATE TABLE provider_instrument_mappings (
  provider_id    text NOT NULL REFERENCES market_providers(id),
  provider_symbol text NOT NULL,
  canonical_id   text NOT NULL REFERENCES canonical_instruments(canonical_id),
  listing_status text NOT NULL CHECK (listing_status IN ('active','halted','delisted','unknown')),
  provider_metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (provider_id, provider_symbol),
  UNIQUE (provider_id, canonical_id)
);

INSERT INTO market_venues (id, label, timezone) VALUES ('BINANCE', 'Binance', 'UTC')
ON CONFLICT (id) DO NOTHING;

INSERT INTO market_providers (id, label, metadata) VALUES
  ('binance-spot', 'Binance Spot', '{"contractVersion":"market.v1","credentialBoundary":"public-market-data-only"}')
ON CONFLICT (id) DO NOTHING;

-- Explicit migration for every Binance-only saved symbol. The provider symbol
-- remains untouched; its canonical id is a separate economic identity.
INSERT INTO canonical_instruments (
  canonical_id, venue_id, asset_class, instrument_type, base_asset, quote_asset,
  settlement_asset, currency, series, precision_rules, session_model, price_capabilities, derivative_terms,
  event_capabilities, execution_capabilities, compliance_metadata
)
SELECT
  'instrument:v1:BINANCE:spot:' || upper(base_asset) || ':' || upper(quote_asset) || ':' ||
    upper(quote_asset) || ':spot',
  'BINANCE', 'crypto', 'spot', upper(base_asset), upper(quote_asset), upper(quote_asset), upper(quote_asset),
  '{"kind":"spot"}',
  jsonb_build_object(
    'priceTick', CASE WHEN price_tick > 0 THEN jsonb_build_object('state','known','value',price_tick)
      ELSE jsonb_build_object('state','unknown','reason','not synced') END,
    'quantityLot', CASE WHEN qty_step > 0 THEN jsonb_build_object('state','known','value',qty_step)
      ELSE jsonb_build_object('state','unknown','reason','not synced') END,
    'minimumQuantity', jsonb_build_object('state','unknown','reason','legacy symbols table did not store minQty'),
    'minimumNotional', CASE WHEN min_notional > 0 THEN jsonb_build_object('state','known','value',min_notional)
      ELSE jsonb_build_object('state','unknown','reason','not synced') END,
    'priceDecimals', jsonb_build_object('state','unknown','reason','derive from canonical price tick on read'),
    'quantityDecimals', jsonb_build_object('state','unknown','reason','derive from canonical quantity lot on read')
  ),
  '{"kind":"continuous","timezone":"UTC","calendarId":"24x7","supports24x7":true}',
  '{"last":{"support":"supported"},"bid":{"support":"unsupported","reason":"not loaded"},"ask":{"support":"unsupported","reason":"not loaded"},"mid":{"support":"unsupported","reason":"not loaded"},"mark":{"support":"unsupported","reason":"spot"},"index":{"support":"unsupported","reason":"spot"}}',
  '{"kind":"none"}',
  '{"corporateActions":{"support":"unsupported","reason":"no feed"},"funding":{"support":"unsupported","reason":"spot"},"openInterest":{"support":"unsupported","reason":"spot"}}',
  '{"mutationBoundary":"bot_only","availability":{"paper":true,"testnet":true,"live":true},"directions":{"long":true,"short":false},"shortSale":{"support":"unsupported","reason":"cash spot"},"leverage":{"support":"unsupported","reason":"cash spot"},"marginModes":["cash"],"reduceOnly":false,"positionModes":["one_way"]}',
  '{"shariah":{"status":"unknown","reason":"not_classified_by_market_metadata","classificationAuthority":"platform_shariah_policy"},"jurisdictionTags":[]}'
FROM symbols
ON CONFLICT (canonical_id) DO NOTHING;

INSERT INTO provider_instrument_mappings (provider_id, provider_symbol, canonical_id, listing_status)
SELECT 'binance-spot', symbol,
  'instrument:v1:BINANCE:spot:' || upper(base_asset) || ':' || upper(quote_asset) || ':' ||
    upper(quote_asset) || ':spot',
  CASE WHEN is_active THEN 'active' ELSE 'halted' END
FROM symbols
ON CONFLICT (provider_id, provider_symbol) DO UPDATE SET
  canonical_id = EXCLUDED.canonical_id,
  listing_status = EXCLUDED.listing_status;

ALTER TABLE symbols ADD COLUMN IF NOT EXISTS canonical_id text;
UPDATE symbols SET canonical_id =
  'instrument:v1:BINANCE:spot:' || upper(base_asset) || ':' || upper(quote_asset) || ':' ||
    upper(quote_asset) || ':spot'
WHERE canonical_id IS NULL;
ALTER TABLE symbols DROP CONSTRAINT IF EXISTS symbols_canonical_id_fk;
ALTER TABLE symbols ADD CONSTRAINT symbols_canonical_id_fk
  FOREIGN KEY (canonical_id) REFERENCES canonical_instruments(canonical_id);
CREATE UNIQUE INDEX IF NOT EXISTS symbols_canonical_id_idx ON symbols (canonical_id)
  WHERE canonical_id IS NOT NULL;
