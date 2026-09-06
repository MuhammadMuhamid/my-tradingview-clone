-- ════════════════════════════════════════════════════════════════════════════
-- Chart state on the server: drawings, and the studies applied to each pane
-- ════════════════════════════════════════════════════════════════════════════
--
-- Until now a user's drawings and applied studies lived only in the browser's
-- localStorage. That is fine for one machine and useless for two: the chart a
-- trader set up on their desk is not the chart they open on the laptop, and
-- clearing site data loses work that took real time to place.
--
-- ── What is keyed by what, and why they differ ─────────────────────────────
--
-- DRAWINGS are keyed by INSTRUMENT — `(venue, symbol)`. That is what a drawing
-- has always been in this product: a trendline belongs to BTCUSDT, and every
-- pane showing BTCUSDT shows it. The venue comes from Wave A's canonical
-- identity, so the day a second venue exists, one exchange's levels cannot be
-- drawn on another's chart.
--
-- STUDIES are keyed by PANE — `scope`. That is also what they have always
-- been: a pane's studies stay put when its symbol changes, which is what a
-- trader means by "put an RSI on this chart". Keying them by instrument
-- instead would silently swap a pane's studies out from under it on every
-- symbol change, and that is a product change Wave C did not ask for.
--
-- Both are stated here rather than left to be inferred, because the difference
-- looks like an inconsistency until you know it is the existing semantics.
--
-- ── Conflict ──────────────────────────────────────────────────────────────
--
-- One monotonic `version` per row. A client sends the version it last read;
-- the API refuses a write against a stale one and hands back what is actually
-- stored. The client then adopts that state before writing again — which is
-- what stops a second device resurrecting a drawing the first one deleted.
-- There is no CRDT and no merge: the rule is deliberately one sentence long,
-- because a rule nobody can state is a rule nobody can debug.

CREATE TABLE IF NOT EXISTS chart_drawings (
  venue      text        NOT NULL DEFAULT 'BINANCE',
  symbol     text        NOT NULL,
  -- The drawing list exactly as the browser holds it. Opaque here on purpose:
  -- the shape is `lib/drawings`' and validating it in SQL would mean two
  -- definitions of a drawing, one of which is always behind.
  drawings   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  version    bigint      NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue, symbol)
);

ALTER TABLE chart_drawings DROP CONSTRAINT IF EXISTS chart_drawings_venue_ck;
ALTER TABLE chart_drawings
  ADD CONSTRAINT chart_drawings_venue_ck CHECK (venue ~ '^[A-Z][A-Z0-9_]{1,23}$');

-- A list, not an object. A row whose payload is `{}` or `5` would be accepted
-- by `jsonb` and would then break every reader.
ALTER TABLE chart_drawings DROP CONSTRAINT IF EXISTS chart_drawings_array_ck;
ALTER TABLE chart_drawings
  ADD CONSTRAINT chart_drawings_array_ck CHECK (jsonb_typeof(drawings) = 'array');

CREATE TABLE IF NOT EXISTS chart_pane_studies (
  -- The pane's own id: `p1`..`p16`. `p1` is the primary pane, which is what
  -- makes an existing user's first chart the one their studies land on.
  scope      text        NOT NULL PRIMARY KEY,
  -- Both engines in one row, because they are one list to the user and
  -- writing them separately would let a save land half-applied.
  pine       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  native     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  version    bigint      NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chart_pane_studies DROP CONSTRAINT IF EXISTS chart_pane_studies_scope_ck;
ALTER TABLE chart_pane_studies
  ADD CONSTRAINT chart_pane_studies_scope_ck CHECK (scope ~ '^[a-z][a-z0-9_-]{0,31}$');

ALTER TABLE chart_pane_studies DROP CONSTRAINT IF EXISTS chart_pane_studies_arrays_ck;
ALTER TABLE chart_pane_studies
  ADD CONSTRAINT chart_pane_studies_arrays_ck
  CHECK (jsonb_typeof(pine) = 'array' AND jsonb_typeof(native) = 'array');

-- Listing what a user has drawn on, for the one-time import and for a future
-- "instruments you have work on" surface.
CREATE INDEX IF NOT EXISTS chart_drawings_updated_idx ON chart_drawings (updated_at DESC);
