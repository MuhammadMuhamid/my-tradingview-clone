-- Watchlists move from browser localStorage to the database.
--
-- The lists were per-browser, which is fine for one desktop and useless the
-- moment the same account is opened on a phone — precisely the device the MA
-- alerts are meant to reach. Server-side, one watchlist follows the user
-- everywhere, the same way chart_layouts already do.

CREATE TABLE IF NOT EXISTS watchlists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  -- Ordered symbol list; order is the user's own arrangement, so an array
  -- rather than a child table with a sort column.
  symbols    text[] NOT NULL DEFAULT '{}',
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS watchlists_name_key
  ON watchlists (upper(btrim(name)));
