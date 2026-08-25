-- ── Paper (simulation) mode ─────────────────────────────────────────────────
--
-- The platform had two delivery modes that touch money (`custom`, `3commas`)
-- and one that does nothing at all (`off`). There was no way to run a
-- deployment forward on live bars and see what it WOULD have done — which is
-- what the selection pipeline's own metadata demands before a configuration is
-- armed: "forward/paper validation is mandatory" (OPT-01).
--
-- `paper` is a delivery mode, not a flag on a live one, so a paper deployment
-- takes a different branch in `fireAlert` before anything is dispatched.

ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_delivery_check;
ALTER TABLE deployments
  ADD CONSTRAINT deployments_delivery_check
  CHECK (delivery IN ('3commas', 'custom', 'off', 'paper'));

-- Simulated fills. Separate from `executions`, which records what the exchange
-- actually did: mixing the two would make a paper fill indistinguishable from a
-- real one in exactly the query an operator runs to check a real one.
CREATE TABLE IF NOT EXISTS paper_fills (
  id             bigserial PRIMARY KEY,
  deployment_id  uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  alert_id       bigint REFERENCES alerts(id) ON DELETE SET NULL,
  bar_time       timestamptz NOT NULL,
  filled_at      timestamptz NOT NULL DEFAULT now(),
  action         text NOT NULL CHECK (action IN ('buy', 'sell')),
  price          numeric NOT NULL,
  qty            numeric NOT NULL,
  quote          numeric NOT NULL,
  commission     numeric NOT NULL,
  -- Null on a buy; net of BOTH sides' commission on a sell.
  realised_pnl   numeric,
  -- The position AFTER this fill, so a run can be resumed without replaying.
  position_qty   numeric NOT NULL DEFAULT 0,
  cost_basis     numeric NOT NULL DEFAULT 0,
  entry_price    numeric,
  reason         text
);

CREATE INDEX IF NOT EXISTS paper_fills_by_deployment
  ON paper_fills (deployment_id, bar_time DESC);

-- One simulated fill per logical order, for the same reason the live path has a
-- unique dedupe key: a retry must not book a second fill.
CREATE UNIQUE INDEX IF NOT EXISTS paper_fills_one_per_alert
  ON paper_fills (alert_id) WHERE alert_id IS NOT NULL;
