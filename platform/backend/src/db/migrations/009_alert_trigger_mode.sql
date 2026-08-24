-- Alert trigger frequency, mirroring TradingView's three options.
--
--   once_per_bar_close : evaluate only when the candle closes (the previous,
--                        and still the default — an alert that only fires on a
--                        confirmed bar cannot be undone by a wick that
--                        retraces before the close)
--   once_per_bar       : fire as soon as the condition is met INTRABAR, at
--                        most once per candle
--   once               : fire the first time the condition is met, then
--                        disable the alert
--
-- Existing rows keep bar-close behaviour, so this migration changes nothing
-- about alerts that are already armed.

ALTER TABLE ma_alerts
  ADD COLUMN IF NOT EXISTS trigger_mode text NOT NULL DEFAULT 'once_per_bar_close'
    CHECK (trigger_mode IN ('once', 'once_per_bar', 'once_per_bar_close'));

-- Which candle the alert last fired on. `once_per_bar` compares against this
-- to stay silent for the rest of a bar it has already announced; a plain
-- timestamp cannot do that, because several ticks arrive within one second.
ALTER TABLE ma_alerts
  ADD COLUMN IF NOT EXISTS last_fired_bar_time timestamptz;
