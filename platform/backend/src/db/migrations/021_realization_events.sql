-- Bot custom realization provenance is additive. Legacy rows stay null and no
-- historical source identity or fee semantics are guessed.
ALTER TABLE realised_pnl ADD COLUMN source_system text;
ALTER TABLE realised_pnl ADD COLUMN source_event_id text;
ALTER TABLE realised_pnl ADD COLUMN realization_kind text;
ALTER TABLE realised_pnl ADD COLUMN source_strategy_order_intent_id text;
ALTER TABLE realised_pnl ADD COLUMN source_exchange_order_id text;
ALTER TABLE realised_pnl ADD COLUMN source_platform_order_intent_id bigint;
ALTER TABLE realised_pnl ADD COLUMN accounting_basis text;
ALTER TABLE realised_pnl ADD COLUMN fee_model text;
ALTER TABLE realised_pnl ADD COLUMN quote_currency text;
ALTER TABLE realised_pnl ADD COLUMN exit_revenue_quote numeric;
ALTER TABLE realised_pnl ADD COLUMN source_payload_sha256 text;
ALTER TABLE realised_pnl ADD COLUMN received_at timestamptz;

ALTER TABLE realised_pnl ADD CONSTRAINT realised_pnl_bot_source_shape_ck CHECK (
  source_system IS NULL OR (
    source_system = 'BOT_CUSTOM_V1'
    AND source_event_id IS NOT NULL
    AND realization_kind IN ('partial', 'final')
    AND source_strategy_order_intent_id IS NOT NULL
    AND source_exchange_order_id IS NOT NULL
    AND source_platform_order_intent_id IS NOT NULL
    AND accounting_basis = 'modeled_fee_adjusted'
    AND fee_model = 'fixed_0.1pct_each_side_not_exchange_observed'
    AND quote_currency = 'USDT'
    AND exit_revenue_quote IS NOT NULL
    AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
    AND received_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX realised_pnl_source_event_unique
  ON realised_pnl (source_system, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX realised_pnl_platform_intent_idx
  ON realised_pnl (source_platform_order_intent_id)
  WHERE source_platform_order_intent_id IS NOT NULL;

-- Durable service-auth replay protection. Expired rows are pruned on receipt;
-- backup/restore naturally includes this table with the rest of PostgreSQL.
CREATE TABLE realization_ingest_nonces (
  nonce       text PRIMARY KEY,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX realization_ingest_nonces_expiry ON realization_ingest_nonces (expires_at);
