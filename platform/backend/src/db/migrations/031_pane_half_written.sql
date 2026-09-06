-- ════════════════════════════════════════════════════════════════════════════
-- Which HALF of a pane's studies has ever been written
-- ════════════════════════════════════════════════════════════════════════════
--
-- `chart_pane_studies` holds a pane's Pine studies and its built-in studies in
-- one row with one version, because they are one list to the user and a save
-- that landed half-applied would be worse than one that failed. The two halves
-- are owned by two different hooks, and each writes only its own column.
--
-- What the row could not say is which half had ever been written. Both halves
-- read the same `version`, so once either one created the row, `version > 0`
-- was true for both — and that value was carrying a meaning it could no longer
-- support:
--
--   the Pine half saw `version 1` with an empty `pine` column and concluded
--     the user had deliberately deleted their scripts, so it never uploaded
--     them again — on any pane whose built-in half happened to sync first;
--
--   and the built-in half, asked whether the server had anything, was told
--     yes on the strength of the OTHER half's studies, adopted an empty list
--     over the top of the user's own, and pushed that deletion everywhere.
--
-- A version is a concurrency token: it answers "has anything changed since I
-- read this row". It was being asked "has MY half ever existed", which is a
-- different question, and these two columns are the answer to it.
--
-- Both default false and are backfilled from the content that is already
-- there, which is the only safe reading of an existing row: a half with
-- studies in it was certainly written, and a half that is empty is
-- indistinguishable from never-written and is therefore treated as such — the
-- direction that re-uploads a user's work rather than silently discarding it.

ALTER TABLE chart_pane_studies
  ADD COLUMN IF NOT EXISTS pine_written   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS native_written boolean NOT NULL DEFAULT false;

-- Narrow and idempotent: it only ever sets a flag true, and only where the
-- column it describes actually holds something.
UPDATE chart_pane_studies
   SET pine_written = true
 WHERE pine_written = false AND jsonb_array_length(pine) > 0;

UPDATE chart_pane_studies
   SET native_written = true
 WHERE native_written = false AND jsonb_array_length(native) > 0;
