-- ════════════════════════════════════════════════════════════════════════════
-- Who owns a Pine script, and whether the user has changed it
-- ════════════════════════════════════════════════════════════════════════════
--
-- `seedIndicatorLibrary` installs the shipped scripts with
-- `ON CONFLICT (lower(name)) DO UPDATE SET source = EXCLUDED.source`. That is
-- idempotent, and it is also destructive in one specific case: a user who
-- edited "Bollinger Bands" — tuned a default, added a plot — loses that work
-- the next time the library is seeded, silently, with no way to tell it
-- happened.
--
-- Fixing it needs one fact the table does not currently hold: whether the
-- stored source is still the one this build shipped.
--
--   origin          'builtin' for a script this build installed, 'user' for
--                   one written in the editor or imported from a file. Every
--                   pre-existing row defaults to 'user', which is the safe
--                   direction: an unknown script is never overwritten.
--
--   builtin_version the library version that installed it. Lets a future build
--                   say what a user's copy is behind, rather than only that it
--                   differs.
--
--   builtin_hash    the source AS SHIPPED. The seed compares the stored source
--                   against this: equal means untouched and safe to update,
--                   different means the user edited it and it is left alone.
--
-- Without the hash, "has the user edited this" would have to be guessed from a
-- timestamp, and a re-seed would look like an edit.

ALTER TABLE pine_scripts
  ADD COLUMN IF NOT EXISTS origin          text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS builtin_version text,
  ADD COLUMN IF NOT EXISTS builtin_hash    text;

ALTER TABLE pine_scripts DROP CONSTRAINT IF EXISTS pine_scripts_origin_ck;
ALTER TABLE pine_scripts
  ADD CONSTRAINT pine_scripts_origin_ck CHECK (origin IN ('user', 'builtin'));

-- A builtin row must say which version installed it and what it shipped as, or
-- the seed cannot tell an edit from a version bump — which is the entire point
-- of these columns.
ALTER TABLE pine_scripts DROP CONSTRAINT IF EXISTS pine_scripts_builtin_ck;
ALTER TABLE pine_scripts
  ADD CONSTRAINT pine_scripts_builtin_ck CHECK (
    origin <> 'builtin' OR (builtin_version IS NOT NULL AND builtin_hash IS NOT NULL)
  );

-- Listing what the library installed, for the seed's own reconciliation.
CREATE INDEX IF NOT EXISTS pine_scripts_origin_idx ON pine_scripts (origin);

-- ── Existing rows ──────────────────────────────────────────────────────────
--
-- Deliberately left as 'user'.
--
-- A row that predates this migration may be a shipped script, a shipped script
-- the user edited, or one they wrote themselves with a colliding name — and
-- this migration cannot tell which. Marking them 'builtin' would let the next
-- seed overwrite a user's own work, which is the exact failure being fixed.
-- Marking them 'user' means the next seed leaves them alone and installs
-- nothing over them; an operator who wants the shipped copies back can delete
-- the rows and re-seed, which is a deliberate act with a visible result.
