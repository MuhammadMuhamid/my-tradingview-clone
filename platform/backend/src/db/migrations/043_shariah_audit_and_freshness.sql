-- Three gaps in an otherwise unusually disciplined Shariah system.
--
-- ── 1. The mode had no audit trail ───────────────────────────────────────
--
-- Shariah Mode lived in `app_settings` as one mutable key/value row carrying
-- only `updated_at`. For the single switch that governs religious compliance
-- for a whole installation, "someone turned it off at some point" was the only
-- recoverable fact: not who, not when it went back on, not whether the
-- execution Bot's floor moved with it. Every publication in this system is
-- append-only and attributed; the switch that decides whether publications are
-- enforced at all was not.
--
-- Append-only, and deliberately not enforced by a trigger the way publications
-- are: a log that refuses a write would block the mode change it is recording,
-- and a mode change must never fail because its audit row did.
CREATE TABLE shariah_mode_changes (
  id            bigserial PRIMARY KEY,
  from_mode     text NOT NULL CHECK (from_mode IN ('off', 'enforce')),
  to_mode       text NOT NULL CHECK (to_mode IN ('off', 'enforce')),
  -- From the signed session cookie, never from the request body — the same
  -- rule `published_by` follows.
  changed_by    text NOT NULL CHECK (length(btrim(changed_by)) > 0),
  -- Whether the execution Bot's floor was actually moved. A change the Bot did
  -- not acknowledge is the exact state in which drift becomes possible, and it
  -- is worth being able to find later.
  bot_floor_pushed boolean NOT NULL,
  policy_version text NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shariah_mode_changes_at_idx ON shariah_mode_changes (changed_at DESC);

COMMENT ON TABLE shariah_mode_changes IS
  'Append-only record of every Shariah Mode change: who, when, and whether the Bot floor moved with it.';

-- ── 2. A publication could not say where its research came from ──────────
--
-- `shariah_publications` is immutable and richly attributed, but a decision
-- typed by the operator and one imported from an offline research pack were
-- indistinguishable in the history. Given that the intended pipeline runs
-- external research through a validated import, "which of these decisions came
-- out of a research pack?" is a question the audit trail should be able to
-- answer — especially because the operator's name is on both.
--
-- Historical rows are NULL and stay NULL: the table is append-only by design
-- and back-filling a provenance field by guessing is exactly the kind of thing
-- this system exists not to do.
ALTER TABLE shariah_publications
  ADD COLUMN source text CHECK (source IN ('manual', 'review_import'));

COMMENT ON COLUMN shariah_publications.source IS
  'How this decision reached the product: typed by the operator, or imported from a validated review pack. NULL on rows published before the column existed.';

-- ── 3. Freshness had no time dimension at all ────────────────────────────
--
-- The only invalidation was event-driven: a base symbol that reappears after
-- delisting forces its record STALE, because a reused ticker may be a
-- different project. A decision published in 2024 about an asset that never
-- delisted remained authoritative for ever, with nothing anywhere surfacing
-- its age — and an actively changing project is the real-world failure mode.
--
-- This is deliberately ADVISORY. Auto-demoting an aged decision to STALE would
-- silently withdraw verdicts en masse and stop trading on an installation whose
-- operator did nothing wrong; the honest move is to surface what is due and let
-- them re-screen it. So this stores a policy setting, and nothing in the gate
-- reads it.
CREATE TABLE shariah_review_policy (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Null means no time-based re-review; a positive number of days means a
  -- decision older than that is SURFACED as due, never demoted.
  review_max_age_days integer CHECK (review_max_age_days IS NULL OR review_max_age_days > 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO shariah_review_policy (id, review_max_age_days) VALUES (true, 365);

COMMENT ON TABLE shariah_review_policy IS
  'Advisory re-review interval. A decision older than this is surfaced as due; nothing demotes it, and the exposure gate never reads this table.';
