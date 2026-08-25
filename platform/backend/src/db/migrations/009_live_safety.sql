-- ════════════════════════════════════════════════════════════════════════════
-- Live-trading safety: durable intent, risk controls, and a single-emitter lease
-- ════════════════════════════════════════════════════════════════════════════
--
-- Additive only. No existing column changes type, no row is rewritten, and the
-- two CHECK constraints that widen are replaced with supersets — so this can be
-- applied to a live database without touching what is already there.

-- ── 1. `blocked` becomes a recordable delivery outcome (X-12) ───────────────
--
-- The receiver answers HTTP 200 for three different meanings, one of which
-- (`ignored_stale_sell`) placed no order and left itself long. Recording that
-- as `sent` is the defect; recording it as `failed` would hide that the
-- receiver is holding a position. It needs its own value.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_delivery_status_check;
ALTER TABLE alerts
  ADD CONSTRAINT alerts_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sent', 'failed', 'skipped', 'blocked'));

-- The receiver's own `status` field, when it reported one. Kept separate from
-- `delivery_status` so the sender's interpretation and the receiver's statement
-- can be compared after the fact.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS receiver_outcome text;

-- ── 2. Durable order intent (BE-13, BE-16) ─────────────────────────────────
--
-- The old sequence was: deliver, then persist state. A process death between
-- those two lines left `runtime_state.position = 'flat'` while the bot was
-- long, and the next bar produced a different dedupe key — so a second BUY was
-- sent and accepted.
--
-- The fix is a row written BEFORE delivery and resolved after. On restart, an
-- unresolved row is a delivery whose outcome is unknown: the runner must
-- reconcile rather than re-fire.
CREATE TABLE IF NOT EXISTS order_intents (
  id             bigserial PRIMARY KEY,
  deployment_id  uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  alert_id       bigint REFERENCES alerts(id) ON DELETE SET NULL,

  -- The canonical dedupe key. UNIQUE per deployment, so the database — not a
  -- read-then-write in application code — is the authority on whether this
  -- logical order has already been attempted (BE-16).
  dedupe_key     text NOT NULL,

  action         text NOT NULL CHECK (action IN ('buy', 'sell')),
  bar_time       timestamptz NOT NULL,
  exit_leg       text,

  -- 'pending'   : written, delivery not yet attempted or outcome unknown
  -- 'delivered' : the receiver placed an order
  -- 'duplicate' : the receiver suppressed it; the original order did execute
  -- 'blocked'   : no order placed AND the receiver is not in the requested state
  -- 'rejected'  : the receiver refused the payload (4xx)
  -- 'failed'    : delivery itself failed
  -- 'stale'     : superseded before resolution; recovery decided not to retry
  state          text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','delivered','duplicate','blocked','rejected','failed','stale')),

  -- Non-null once the intent stops being pending.
  resolved_at    timestamptz,
  detail         text,

  -- Which process wrote it, so an orphan can be attributed after a crash.
  emitter_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One intent per (deployment, dedupe key). This is the idempotency guarantee:
-- an INSERT ... ON CONFLICT DO NOTHING that returns no row means this exact
-- logical order was already attempted, whatever happened to it afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS order_intents_unique_key
  ON order_intents (deployment_id, dedupe_key);

CREATE INDEX IF NOT EXISTS order_intents_pending
  ON order_intents (deployment_id, created_at)
  WHERE state = 'pending';

-- ── 3. Single-emitter lease (X-06, BE-18) ──────────────────────────────────
--
-- Single-emitter was enforced only by an in-memory Set and a comment, so two
-- processes — a laptop launch agent and the cloud deployment — could both emit
-- against the same production bot, with their runtime state in DIFFERENT
-- databases. Whichever database this table lives in is now the authority.
CREATE TABLE IF NOT EXISTS emitter_lease (
  -- Exactly one row, ever.
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder      text NOT NULL,
  hostname    text,
  pid         integer,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  -- Renewed on a timer. A lease past this instant is up for grabs, which is
  -- what lets a crashed emitter be replaced without operator action.
  expires_at  timestamptz NOT NULL
);

-- ── 4. Risk controls (BE-11, BOT-011) ──────────────────────────────────────
--
-- A repository-wide search for killSwitch/dailyLoss/maxExposure/maxOpenPositions
-- previously returned nothing in either repository. With correlated deployments
-- across correlated coins, one market move can fire every one of them on the
-- same bar close with nothing to stop it.
--
-- Stored as one row so a read is a single query on the hot signal path.
CREATE TABLE IF NOT EXISTS risk_controls (
  id                      integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- The kill switch. When true, `fireAlert` refuses before `deliver`.
  trading_halted          boolean NOT NULL DEFAULT false,
  halted_reason           text,
  halted_at               timestamptz,
  -- 'operator' | 'daily_loss' | 'exposure' | 'concurrency' | 'data_gap'
  halted_by               text,

  -- Total quote currency allowed at risk across all active deployments.
  -- NULL disables the check.
  max_total_exposure_quote numeric,
  -- Maximum simultaneously-long deployments. NULL disables the check.
  max_concurrent_positions integer,
  -- Rolling realised loss over `daily_loss_window_hours` that trips the switch.
  -- Positive number, expressed as a loss. NULL disables the check.
  max_daily_loss_quote     numeric,
  daily_loss_window_hours  integer NOT NULL DEFAULT 24,

  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Seed the singleton with every limit disabled and trading NOT halted, so this
-- migration changes no behaviour on its own. Turning a limit on is a
-- deliberate operator action.
INSERT INTO risk_controls (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 5. Realised-P&L ledger for the rolling daily-loss check ────────────────
--
-- The platform had no record of realised outcomes at all — the alerts table
-- records what was SENT, not what it earned. Without this the daily-loss limit
-- has nothing to sum.
CREATE TABLE IF NOT EXISTS realised_pnl (
  id            bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  alert_id      bigint REFERENCES alerts(id) ON DELETE SET NULL,
  closed_at     timestamptz NOT NULL DEFAULT now(),
  -- Signed: negative is a loss. In quote currency.
  pnl_quote     numeric NOT NULL,
  entry_price   numeric,
  exit_price    numeric,
  quantity      numeric,
  reason        text
);

CREATE INDEX IF NOT EXISTS realised_pnl_recent ON realised_pnl (closed_at DESC);

-- ── 6. Feed health, so "Live" can be an honest claim (BE-14) ───────────────
--
-- `ensureCandles` tolerated ~1.5% missing bars with no contiguity check, no
-- padding and no log line — 31 absent bars in a 2100-bar 15m warmup, nearly
-- eight hours, over which every rolling indicator computed on a silently
-- compressed timeline.
CREATE TABLE IF NOT EXISTS feed_health (
  symbol           text NOT NULL,
  interval         text NOT NULL,
  -- 'live' | 'delayed' | 'reconnecting' | 'gap' | 'error' | 'unknown'
  state            text NOT NULL DEFAULT 'unknown',
  last_bar_time    timestamptz,
  last_checked_at  timestamptz NOT NULL DEFAULT now(),
  missing_bars     integer NOT NULL DEFAULT 0,
  detail           text,
  PRIMARY KEY (symbol, interval)
);
