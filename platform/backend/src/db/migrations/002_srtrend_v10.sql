INSERT INTO strategies (key, name, description, pine_source)
VALUES (
  'srtrend_v10',
  'SR+Trend Final (v10)',
  'MTF pivot support/retest strategy with MA, SuperTrend, LinReg, VWMA, structure and volume filters; adaptive targets, break-even, trailing, HTF runner and structural exits.',
  'srtrendfinal.pine'
)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  pine_source = EXCLUDED.pine_source;
