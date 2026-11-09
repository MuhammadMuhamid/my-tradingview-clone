-- 056: the environment a Bot realization declares (owner decision OD-5).
--
-- Realization contract v2 events carry `environment` (DRY_RUN | TESTNET |
-- MAINNET | UNKNOWN), the environment of the SELL that realized them, as the
-- Bot recorded it when it placed that order. It is stored here exactly as
-- declared; UNKNOWN, every v1 event and every legacy row stay NULL. The Journal
-- reads it through `journal/environment.ts`, which still applies the
-- no-REAL-without-proof rule (a declaration that contradicts the row's own
-- `dry-` exchange id reads UNKNOWN). P&L and fees stay the Bot's modeled
-- figures; nothing here relabels them as exchange-observed.
--
-- Added without IF NOT EXISTS on purpose, as 052 explains.

ALTER TABLE realised_pnl ADD COLUMN declared_environment text
  CONSTRAINT realised_pnl_declared_environment_ck
  CHECK (declared_environment IN ('DRY_RUN', 'TESTNET', 'MAINNET'));
