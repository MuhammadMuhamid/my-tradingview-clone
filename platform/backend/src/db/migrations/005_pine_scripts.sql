-- Pine editor: user-authored scripts, compiled and executed by src/pine/.
-- Source is stored verbatim; everything else is derived at compile time so a
-- script never carries stale metadata.
CREATE TABLE IF NOT EXISTS pine_scripts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  source      text NOT NULL,
  -- 'indicator' | 'strategy', refreshed on every save
  kind        text NOT NULL DEFAULT 'indicator',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Names are the handle used in the editor's script list, so keep them unique
-- case-insensitively (matching how chart_layouts behaves).
CREATE UNIQUE INDEX IF NOT EXISTS pine_scripts_name_key
  ON pine_scripts (lower(name));
