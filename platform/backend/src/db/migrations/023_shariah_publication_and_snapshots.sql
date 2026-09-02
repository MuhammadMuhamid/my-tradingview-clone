-- ════════════════════════════════════════════════════════════════════════════
-- Trading Scene Shariah Universe — SH-2: review/publication + immutable
-- universe snapshots. Purely additive on top of 022_shariah_universe.sql;
-- nothing there is altered except one new nullable column on shariah_records.
--
-- 022 stores only ONE MUTABLE CURRENT ROW per asset (shariah_records), which
-- cannot answer "what was published, why, on what evidence, and when" after a
-- later decision overwrites it. SH-2 adds the append-only history that can,
-- plus the immutable universe snapshots future Research/Backtester runs will
-- cite in their provenance.
--
-- Immutability here is enforced by the DATABASE, not by convention: the
-- history and snapshot tables reject UPDATE and DELETE outright, so no
-- application bug, repository helper or psql session can silently rewrite a
-- published decision or an old snapshot.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Append-only guard ───────────────────────────────────────────────────────
-- One shared trigger function for every SH-2 history/snapshot table. INSERT is
-- untouched; UPDATE and DELETE always raise.
CREATE OR REPLACE FUNCTION shariah_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'shariah append-only violation: % on % is not permitted (published decisions and snapshots are immutable)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- ── shariah_publications: the immutable published-decision history ──────────
-- Every deliberate publication appends exactly one row. A publication ALWAYS
-- produces lifecycle SCREENED (that is what publishing means); UNSCREENED and
-- STALE are states the registry puts an asset into, never states a reviewer
-- publishes. `reason` is NOT NULL for all three classifications, including
-- REVIEW — a deliberately published REVIEW must say why the evidence is
-- insufficient, conflicting or materially ambiguous.
--
-- base_asset_at_publication and project_name_at_publication are copied in, not
-- joined: a later ticker rename or reuse must not change what this row says
-- was reviewed.
CREATE TABLE shariah_publications (
  publication_id             bigserial PRIMARY KEY,
  asset_id                   bigint NOT NULL REFERENCES shariah_assets(asset_id),
  policy_version             text NOT NULL,
  classification             text NOT NULL,
  lifecycle                  text NOT NULL DEFAULT 'SCREENED',
  reason                     text NOT NULL,
  prohibited_categories      text[],
  base_asset_at_publication  text,
  project_name_at_publication text,
  reviewed_at                timestamptz NOT NULL,
  published_at               timestamptz NOT NULL DEFAULT now(),
  published_by               text NOT NULL,
  CONSTRAINT shariah_publications_classification_ck
    CHECK (classification IN ('ELIGIBLE', 'EXCLUDED', 'REVIEW')),
  -- Publishing is the only way into SCREENED, and it is the only thing a
  -- publication row can record. Constrained to a literal so no future writer
  -- can append a "published UNSCREENED/STALE" row.
  CONSTRAINT shariah_publications_lifecycle_ck
    CHECK (lifecycle = 'SCREENED'),
  CONSTRAINT shariah_publications_policy_version_ck
    CHECK (policy_version IN ('TS_SHARIAH_V1')),
  CONSTRAINT shariah_publications_reason_ck
    CHECK (length(btrim(reason)) > 0),
  CONSTRAINT shariah_publications_published_by_ck
    CHECK (length(btrim(published_by)) > 0),
  CONSTRAINT shariah_publications_categories_ck
    CHECK (prohibited_categories IS NULL OR prohibited_categories <@ ARRAY[
      'RIBA_INTEREST_BASED_FINANCE', 'GAMBLING_BETTING_CASINO',
      'PORNOGRAPHY_ADULT_SEXUAL_BUSINESS', 'ALCOHOL', 'PORK_PROHIBITED_FOOD',
      'TOBACCO', 'CONVENTIONAL_INSURANCE', 'PROHIBITED_BUSINESS_OWNERSHIP_OR_FINANCING'
    ]::text[]),
  -- Mirrors 022's shariah_records_excluded_shape_ck: EXCLUDED must name at
  -- least one applicable prohibited category. (The reason is already NOT NULL
  -- and non-blank for every classification.)
  CONSTRAINT shariah_publications_excluded_shape_ck
    CHECK (classification <> 'EXCLUDED' OR (
      prohibited_categories IS NOT NULL
      AND array_length(prohibited_categories, 1) > 0
    ))
);
CREATE INDEX shariah_publications_asset_idx
  ON shariah_publications (asset_id, published_at DESC, publication_id DESC);

CREATE TRIGGER shariah_publications_append_only
  BEFORE UPDATE OR DELETE ON shariah_publications
  FOR EACH ROW EXECUTE FUNCTION shariah_append_only_guard();

-- ── shariah_publication_evidence: which facts supported which decision ──────
-- 022's shariah_evidence rows hang off an ASSET, so evidence accumulated over
-- an asset's whole life cannot be attributed to the specific decision it
-- supported. This is that missing relational boundary. ON DELETE RESTRICT (the
-- default) plus the append-only trigger means a cited evidence row can never
-- be detached from the decision that relied on it.
CREATE TABLE shariah_publication_evidence (
  publication_id bigint NOT NULL REFERENCES shariah_publications(publication_id),
  evidence_id    bigint NOT NULL REFERENCES shariah_evidence(id),
  PRIMARY KEY (publication_id, evidence_id)
);
CREATE INDEX shariah_publication_evidence_evidence_idx
  ON shariah_publication_evidence (evidence_id);

CREATE TRIGGER shariah_publication_evidence_append_only
  BEFORE UPDATE OR DELETE ON shariah_publication_evidence
  FOR EACH ROW EXECUTE FUNCTION shariah_append_only_guard();

-- ── shariah_records: point the mutable current row at its published origin ──
-- Additive and nullable: rows created by universe sync (UNSCREENED) and rows
-- demoted to STALE legitimately have no current publication. This is the
-- provenance link from "what is true now" to "the immutable decision that made
-- it true", not a second copy of the decision.
ALTER TABLE shariah_records
  ADD COLUMN current_publication_id bigint
    REFERENCES shariah_publications(publication_id);

-- ── shariah_universe_snapshots: immutable point-in-time universe state ──────
-- content_hash is a sha256 computed in application code over a canonically
-- ordered, canonically shaped entry list (src/shariah/snapshot.ts), so it is
-- independent of database row order. (policy_version, content_hash) is
-- deliberately NOT unique: taking a second snapshot of unchanged authoritative
-- state appends a NEW snapshot row carrying the SAME content_hash, rather than
-- reusing or mutating the old one. See docs/SHARIAH-UNIVERSE.md.
CREATE TABLE shariah_universe_snapshots (
  snapshot_id    bigserial PRIMARY KEY,
  policy_version text NOT NULL,
  content_hash   text NOT NULL,
  entry_count    integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text,
  CONSTRAINT shariah_universe_snapshots_policy_version_ck
    CHECK (policy_version IN ('TS_SHARIAH_V1')),
  CONSTRAINT shariah_universe_snapshots_content_hash_ck
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shariah_universe_snapshots_entry_count_ck
    CHECK (entry_count >= 0)
);
CREATE INDEX shariah_universe_snapshots_created_idx
  ON shariah_universe_snapshots (created_at DESC, snapshot_id DESC);
CREATE INDEX shariah_universe_snapshots_hash_idx
  ON shariah_universe_snapshots (policy_version, content_hash);

CREATE TRIGGER shariah_universe_snapshots_append_only
  BEFORE UPDATE OR DELETE ON shariah_universe_snapshots
  FOR EACH ROW EXECUTE FUNCTION shariah_append_only_guard();

-- ── shariah_universe_snapshot_entries: the frozen membership ────────────────
-- Every field a consumer needs to interpret the entry is COPIED IN, not
-- joined. asset_id keeps a foreign key for referential integrity, but nothing
-- about the snapshot's historical meaning is read through it: renaming the
-- ticker, delisting the asset, or publishing a new classification tomorrow
-- cannot change a single value stored here.
--
-- effective_status is the already-resolved public answer (UNSCREENED and STALE
-- have already collapsed to REVIEW); classification/lifecycle are kept beside
-- it so a reader can tell "reviewed and found ambiguous" apart from "never
-- screened" without re-deriving anything.
CREATE TABLE shariah_universe_snapshot_entries (
  snapshot_id       bigint NOT NULL REFERENCES shariah_universe_snapshots(snapshot_id),
  asset_id          bigint NOT NULL REFERENCES shariah_assets(asset_id),
  position          integer NOT NULL,
  base_asset        text NOT NULL,
  effective_status  text NOT NULL,
  classification    text NOT NULL,
  lifecycle         text NOT NULL,
  binance_available boolean NOT NULL,
  policy_version    text NOT NULL,
  publication_id    bigint REFERENCES shariah_publications(publication_id),
  PRIMARY KEY (snapshot_id, asset_id),
  CONSTRAINT shariah_snapshot_entries_effective_status_ck
    CHECK (effective_status IN ('ELIGIBLE', 'EXCLUDED', 'REVIEW')),
  CONSTRAINT shariah_snapshot_entries_classification_ck
    CHECK (classification IN ('ELIGIBLE', 'EXCLUDED', 'REVIEW')),
  CONSTRAINT shariah_snapshot_entries_lifecycle_ck
    CHECK (lifecycle IN ('SCREENED', 'UNSCREENED', 'STALE')),
  CONSTRAINT shariah_snapshot_entries_policy_version_ck
    CHECK (policy_version IN ('TS_SHARIAH_V1')),
  -- The SH-1 fail-closed rule, now durable rather than application-only: a
  -- snapshot entry that is not SCREENED can only ever read REVIEW.
  CONSTRAINT shariah_snapshot_entries_unscreened_is_review_ck
    CHECK (lifecycle = 'SCREENED' OR effective_status = 'REVIEW'),
  CONSTRAINT shariah_snapshot_entries_position_ck
    CHECK (position >= 0)
);
CREATE UNIQUE INDEX shariah_snapshot_entries_position_idx
  ON shariah_universe_snapshot_entries (snapshot_id, position);

CREATE TRIGGER shariah_universe_snapshot_entries_append_only
  BEFORE UPDATE OR DELETE ON shariah_universe_snapshot_entries
  FOR EACH ROW EXECUTE FUNCTION shariah_append_only_guard();
