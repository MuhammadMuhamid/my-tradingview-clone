INSERT INTO strategies (key, name, description, pine_source)
VALUES (
  'mtf_lean',
  'MTF Confluence Lean',
  'Long-only multi-timeframe confluence engine with G1-G4 trend gates, S1-S7 structure filters, R:R brackets, partial TP1/TP2 exits, runner, break-even and trailing stops.',
  'MTF_Confluence_Lean.pine'
)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  pine_source = EXCLUDED.pine_source;
