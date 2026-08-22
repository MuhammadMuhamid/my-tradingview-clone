-- Chart layouts: server-side persistence of the TradingView-style workspace
-- (symbol, timeframe, history depth, strategy + params + backtest properties).
-- Previously stored only in browser localStorage; the database copy survives
-- refreshes, devices, and redeployments. Names are unique case-insensitively,
-- matching the frontend's name-based upsert semantics.

CREATE TABLE IF NOT EXISTS chart_layouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  symbol        text NOT NULL,
  timeframe     text NOT NULL,
  bars          integer NOT NULL DEFAULT 10000,
  strategy_key  text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  properties    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chart_layouts_name_key
  ON chart_layouts (upper(btrim(name)));
