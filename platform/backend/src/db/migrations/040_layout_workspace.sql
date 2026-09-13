-- TVP8: a saved layout captures the WORKSPACE, not only the symbol and the
-- strategy.
--
-- `lib/layouts.ts` said in its own docstring that a layout "snapshots the whole
-- workspace" and listed drawings among what it carries. It carried neither:
-- studies, drawings, the chart type, the per-pane chart settings, the price
-- scale and the pane grid were all localStorage-only, so opening a saved layout
-- restored a symbol and a timeframe onto whatever the browser happened to be
-- showing. Two independent reviews flagged the docstring as false before
-- anyone noticed the feature was.
--
-- One jsonb column rather than a column per piece: what a workspace holds is
-- the frontend's business and has changed twice already this year. The shape is
-- validated on the way IN by `lib/workspace.ts`'s own normaliser, and an
-- unknown or damaged record degrades to "restore what you can" exactly as the
-- localStorage path already does — which is why this can be additive and
-- nullable rather than a versioned schema.
ALTER TABLE chart_layouts
  ADD COLUMN IF NOT EXISTS workspace jsonb;
