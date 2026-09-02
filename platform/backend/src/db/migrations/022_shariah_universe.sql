-- ════════════════════════════════════════════════════════════════════════════
-- Trading Scene Shariah Universe — SH-1 foundation.
--
-- Screens the unique underlying BASE ASSET of Trading Scene's Binance Spot
-- USDT universe (not every USDT pair separately) under policy TS_SHARIAH_V1
-- (see src/shariah/policy.ts, the authoritative source for the fixed
-- vocabulary this migration's CHECK constraints mirror).
--
-- `symbols` (001_init.sql) already tracks the Binance spot pairs Trading
-- Scene supports; it is reused as-is as the "supported by Trading Scene"
-- authority. It is not reused as Shariah identity because its primary key is
-- ticker text (`symbol`), which is exactly what a ticker rename, project
-- rebrand, token migration or ticker reuse would break. `shariah_assets`
-- below is the stable identity those events must not disturb.
-- ════════════════════════════════════════════════════════════════════════════

-- ── shariah_assets: stable identity for a screened base asset/project ───────
CREATE TABLE shariah_assets (
  asset_id     bigserial PRIMARY KEY,
  project_name text,                            -- filled in when known; not required to exist
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── shariah_asset_binance_mappings: current Binance base-symbol alias ───────
-- Kept separate from shariah_assets so a future rename/rebrand/migration only
-- ever changes this table, never the asset_id or its Shariah history.
-- base_asset is the primary key: at most one live stable asset per Binance
-- base symbol, which is what makes universe sync's identity resolution
-- deterministic.
CREATE TABLE shariah_asset_binance_mappings (
  base_asset        text PRIMARY KEY,            -- 'BTC', 'ETH', ...
  asset_id          bigint NOT NULL REFERENCES shariah_assets(asset_id),
  binance_available boolean NOT NULL DEFAULT true, -- currently an active/spot/USDT-qualifying base asset
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shariah_asset_binance_mappings_asset_idx ON shariah_asset_binance_mappings (asset_id);

-- ── shariah_records: current classification/lifecycle for a stable asset ────
-- One current row per asset (not a history/snapshot — SH-2 scope). Missing
-- row or UNSCREENED/STALE lifecycle must never resolve to ELIGIBLE; that is
-- enforced in application code (src/shariah/policy.ts effectiveStatus) since
-- "missing row" cannot be expressed as a database CHECK.
CREATE TABLE shariah_records (
  asset_id             bigint PRIMARY KEY REFERENCES shariah_assets(asset_id),
  classification       text NOT NULL DEFAULT 'REVIEW',
  lifecycle            text NOT NULL DEFAULT 'UNSCREENED',
  policy_version       text NOT NULL DEFAULT 'TS_SHARIAH_V1',
  reason               text,
  prohibited_categories text[],
  reviewed_at          timestamptz,
  published_at         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shariah_records_classification_ck
    CHECK (classification IN ('ELIGIBLE', 'EXCLUDED', 'REVIEW')),
  CONSTRAINT shariah_records_lifecycle_ck
    CHECK (lifecycle IN ('SCREENED', 'UNSCREENED', 'STALE')),
  CONSTRAINT shariah_records_policy_version_ck
    CHECK (policy_version IN ('TS_SHARIAH_V1')),
  CONSTRAINT shariah_records_categories_ck
    CHECK (prohibited_categories IS NULL OR prohibited_categories <@ ARRAY[
      'RIBA_INTEREST_BASED_FINANCE', 'GAMBLING_BETTING_CASINO',
      'PORNOGRAPHY_ADULT_SEXUAL_BUSINESS', 'ALCOHOL', 'PORK_PROHIBITED_FOOD',
      'TOBACCO', 'CONVENTIONAL_INSURANCE', 'PROHIBITED_BUSINESS_OWNERSHIP_OR_FINANCING'
    ]::text[]),
  -- A published EXCLUDED classification must carry a reason and at least one
  -- applicable prohibited category; REVIEW/ELIGIBLE never require either.
  CONSTRAINT shariah_records_excluded_shape_ck
    CHECK (classification <> 'EXCLUDED' OR (
      reason IS NOT NULL
      AND prohibited_categories IS NOT NULL
      AND array_length(prohibited_categories, 1) > 0
    ))
);

-- ── shariah_evidence: evidence-ready boundary, no AI automation ─────────────
CREATE TABLE shariah_evidence (
  id           bigserial PRIMARY KEY,
  asset_id     bigint NOT NULL REFERENCES shariah_assets(asset_id),
  url          text,
  title        text,
  publisher    text,
  retrieved_at timestamptz,
  excerpt      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shariah_evidence_asset_idx ON shariah_evidence (asset_id);
