-- X7: alert identity is a market-data identity, not a bare ticker.
-- Legacy Binance alerts remain runner-compatible, while the stored envelope
-- makes provider and price role explicit for persistence, exports and dedupe.
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS canonical_instrument_id text;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS provider_id text;
ALTER TABLE ma_alerts ADD COLUMN IF NOT EXISTS price_basis text;

UPDATE ma_alerts a
SET canonical_instrument_id = s.canonical_id,
    provider_id = COALESCE(a.provider_id, 'binance-spot'),
    price_basis = COALESCE(a.price_basis, 'last')
FROM symbols s
WHERE a.canonical_instrument_id IS NULL AND s.symbol = a.symbol;

-- Rows created before symbols.canonical_id existed still get a deterministic
-- identity where the legacy ticker is one of the established Binance quote
-- forms. Unknown historical rows stay nullable and are visibly legacy.
UPDATE ma_alerts
SET canonical_instrument_id = 'instrument:v1:BINANCE:spot:' || left(symbol, length(symbol) - length(q.quote)) || ':' || q.quote || ':' || q.quote || ':spot',
    provider_id = COALESCE(provider_id, 'binance-spot'),
    price_basis = COALESCE(price_basis, 'last')
FROM (VALUES ('USDT'), ('USDC'), ('FDUSD'), ('TUSD'), ('BUSD'), ('BTC'), ('ETH'), ('BNB'), ('EUR'), ('TRY')) AS q(quote)
WHERE canonical_instrument_id IS NULL
  AND length(symbol) > length(q.quote)
  AND symbol LIKE '%' || q.quote;

ALTER TABLE ma_alerts DROP CONSTRAINT IF EXISTS ma_alerts_price_basis_ck;
ALTER TABLE ma_alerts ADD CONSTRAINT ma_alerts_price_basis_ck CHECK (
  price_basis IS NULL OR price_basis IN ('last','bid','ask','mid','mark','index')
);
CREATE INDEX IF NOT EXISTS ma_alerts_canonical_identity_idx
  ON ma_alerts (canonical_instrument_id, provider_id, price_basis, timeframe)
  WHERE enabled;

-- X1 migrated existing watchlists once. Repeat the additive join here for
-- rows imported or created by an older client between X1 and this boundary,
-- and bring server-saved single-chart layouts under the same canonical key.
UPDATE watchlists w
SET symbols = ARRAY(
  SELECT COALESCE(s.canonical_id, value.item)
  FROM unnest(w.symbols) WITH ORDINALITY AS value(item, position)
  LEFT JOIN symbols s ON upper(s.symbol) = upper(value.item)
  ORDER BY value.position
)
WHERE EXISTS (
  SELECT 1 FROM unnest(w.symbols) AS legacy(item)
  WHERE lower(legacy.item) NOT LIKE 'instrument:v1:%'
);

UPDATE chart_layouts l
SET symbol = s.canonical_id
FROM symbols s
WHERE lower(l.symbol) NOT LIKE 'instrument:v1:%'
  AND upper(s.symbol) = upper(l.symbol)
  AND s.canonical_id IS NOT NULL;
