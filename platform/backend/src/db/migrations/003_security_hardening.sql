-- One alert per deployment + dedupe key, enforced atomically under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_unique_dedupe
  ON alerts (deployment_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Historical alert telemetry must not expose live webhook credentials.
UPDATE alerts
SET payload = (payload - 'secret' - 'bot_uuid') ||
  CASE WHEN payload ? 'secret' THEN jsonb_build_object('secret', '[REDACTED]') ELSE '{}'::jsonb END ||
  CASE WHEN payload ? 'bot_uuid' THEN jsonb_build_object('bot_uuid', '[REDACTED]') ELSE '{}'::jsonb END
WHERE payload ? 'secret' OR payload ? 'bot_uuid';
