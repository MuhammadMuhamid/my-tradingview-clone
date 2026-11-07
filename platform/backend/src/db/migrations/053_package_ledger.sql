-- 053: packages, cohorts, memberships and the append-only ledger behind them.
--
-- A package is a strategy run on several coins (its deployments) in fixed-term
-- cohorts, one at a time. Members' money is recorded by the administrator after
-- they've checked the deposit; nothing here moves funds. Every balance is derived
-- from ledger_entries, which can't be changed or deleted, only added to.
--
-- Amounts are NUMERIC(38,8), read and written as decimal strings.

CREATE TABLE packages (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text          NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description       text          NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  term              text          NOT NULL CHECK (term IN ('half_month', 'month', 'quarter', 'half_year')),
  min_amount        numeric(38,8) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  -- Each BUY spends this percentage of the running cohort's free equity.
  trade_percent     numeric(38,8) NOT NULL CHECK (trade_percent > 0 AND trade_percent <= 100),
  join_instructions text          NOT NULL DEFAULT '' CHECK (length(join_instructions) <= 4000),
  status            text          NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'paused', 'closed')),
  created_by        uuid          REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX packages_name_key ON packages (lower(btrim(name)));

-- A deployment trades for one package at most.
CREATE TABLE package_deployments (
  package_id    uuid NOT NULL REFERENCES packages (id) ON DELETE RESTRICT,
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments (id) ON DELETE RESTRICT,
  PRIMARY KEY (package_id, deployment_id)
);

CREATE TABLE cohorts (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id        uuid          NOT NULL REFERENCES packages (id) ON DELETE RESTRICT,
  -- Half-open window: starts_at is the first instant, ends_at the next cohort's first.
  starts_at         timestamptz   NOT NULL,
  ends_at           timestamptz   NOT NULL,
  deposit_cutoff_at timestamptz   NOT NULL,
  status            text          NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'running', 'settling', 'settled', 'cancelled')),
  opening_capital   numeric(38,8),
  closing_value     numeric(38,8),
  created_at        timestamptz   NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND deposit_cutoff_at <= starts_at),
  UNIQUE (package_id, starts_at)
);
-- One cohort at a time: windows of a package never overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE cohorts ADD CONSTRAINT cohorts_no_overlap
  EXCLUDE USING gist (package_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status <> 'cancelled');

CREATE TABLE memberships (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id    uuid        NOT NULL REFERENCES cohorts (id) ON DELETE RESTRICT,
  -- RESTRICT: an account with recorded money can't be deleted out from under its ledger.
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status       text        NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
  UNIQUE (cohort_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE ledger_entries (
  id              bigserial     PRIMARY KEY,
  cohort_id       uuid          NOT NULL REFERENCES cohorts (id) ON DELETE RESTRICT,
  membership_id   uuid          REFERENCES memberships (id) ON DELETE RESTRICT,
  kind            text          NOT NULL
                  CHECK (kind IN ('CAPITAL_IN', 'CAPITAL_OUT', 'TRADE_PNL', 'FEE', 'ADJUSTMENT')),
  amount          numeric(38,8) NOT NULL,
  source_type     text,
  source_id       text,
  -- The same deposit, trade or correction recorded twice is one entry.
  idempotency_key text          NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  note            text          NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  recorded_by     uuid          REFERENCES users (id) ON DELETE SET NULL,
  recorded_at     timestamptz   NOT NULL DEFAULT now(),
  CHECK (kind <> 'CAPITAL_IN' OR (amount > 0 AND membership_id IS NOT NULL)),
  CHECK (kind <> 'CAPITAL_OUT' OR (amount < 0 AND membership_id IS NOT NULL)),
  CHECK (kind <> 'TRADE_PNL' OR membership_id IS NULL),
  CHECK (kind <> 'ADJUSTMENT' OR length(btrim(note)) > 0)
);
CREATE INDEX ledger_entries_cohort_idx ON ledger_entries (cohort_id, recorded_at);
CREATE INDEX ledger_entries_membership_idx ON ledger_entries (membership_id);

-- Which cohort holds each position the package's deployments open.
CREATE TABLE cohort_trades (
  id              bigserial     PRIMARY KEY,
  cohort_id       uuid          NOT NULL REFERENCES cohorts (id) ON DELETE RESTRICT,
  deployment_id   uuid          NOT NULL REFERENCES deployments (id) ON DELETE RESTRICT,
  symbol          text          NOT NULL,
  order_intent_id bigint        UNIQUE REFERENCES order_intents (id) ON DELETE RESTRICT,
  quote_spent     numeric(38,8) NOT NULL CHECK (quote_spent >= 0),
  status          text          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at       timestamptz   NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE INDEX cohort_trades_cohort_idx ON cohort_trades (cohort_id, status);

CREATE TABLE admin_audit (
  id       bigserial   PRIMARY KEY,
  actor    uuid        REFERENCES users (id) ON DELETE SET NULL,
  action   text        NOT NULL,
  target   text        NOT NULL,
  detail   jsonb       NOT NULL DEFAULT '{}',
  at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION package_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on % is not permitted; record a correcting entry instead',
    TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION package_ledger_append_only();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION package_ledger_append_only();
CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION package_ledger_append_only();
CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION package_ledger_append_only();
