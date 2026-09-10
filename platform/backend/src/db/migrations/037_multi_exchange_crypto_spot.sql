-- X1 multi-exchange crypto spot identity. Legacy Binance-only rows keep their
-- provider ticker columns; user-facing watchlists migrate to canonical ids.

INSERT INTO market_venues (id, label, timezone) VALUES
  ('COINBASE', 'Coinbase', 'UTC'), ('BYBIT', 'Bybit', 'UTC'),
  ('OKX', 'OKX', 'UTC'), ('KRAKEN', 'Kraken', 'UTC'),
  ('KUCOIN', 'KuCoin', 'UTC'), ('GATEIO', 'Gate.io', 'UTC'),
  ('ROBINHOOD', 'Robinhood Crypto', 'UTC'), ('HYPERLIQUID', 'Hyperliquid', 'UTC')
ON CONFLICT (id) DO NOTHING;

INSERT INTO market_providers (id, label, metadata) VALUES
  ('coinbase-spot', 'Coinbase Exchange Spot', '{"contractVersion":"market.v1","credentialBoundary":"public-market-data-only"}'),
  ('bybit-spot', 'Bybit Spot', '{"contractVersion":"market.v1","credentialBoundary":"public-market-data-only"}'),
  ('okx-spot', 'OKX Spot', '{"contractVersion":"market.v1","credentialBoundary":"public-market-data-only"}'),
  ('kraken-spot', 'Kraken Spot', '{"contractVersion":"market.v1","credentialBoundary":"public-market-data-only"}'),
  ('kucoin-spot', 'KuCoin Spot', '{"contractVersion":"market.v1","credentialBoundary":"public-market-data-only"}'),
  ('gateio-spot', 'Gate.io Spot', '{"contractVersion":"market.v1","credentialBoundary":"public-market-data-only"}'),
  ('robinhood-crypto', 'Robinhood Crypto', '{"contractVersion":"market.v1","credentialBoundary":"authentication-required","liveProof":"unverified"}'),
  ('hyperliquid-spot', 'Hyperliquid Spot', '{"contractVersion":"market.v1","credentialBoundary":"public-market-data-only"}')
ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata;

UPDATE watchlists w
SET symbols = ARRAY(
  SELECT COALESCE(s.canonical_id, item)
  FROM unnest(w.symbols) WITH ORDINALITY AS value(item, position)
  LEFT JOIN symbols s ON s.symbol = value.item
  ORDER BY value.position
)
WHERE EXISTS (
  SELECT 1 FROM unnest(w.symbols) AS legacy(item)
  WHERE lower(legacy.item) NOT LIKE 'instrument:v1:%'
);
