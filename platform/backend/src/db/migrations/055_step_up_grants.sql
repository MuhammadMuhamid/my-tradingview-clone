-- 055: step-up grants (owner decision OD-2).
--
-- A correct authenticator code before a Bot or Platform command now also
-- leaves a short-lived grant, so the next few commands in the same browser do
-- not each need a new code. The browser holds only an opaque random handle in
-- the HttpOnly, SameSite=Strict cookie `srtrend_stepup`; only its SHA-256 is
-- stored here, so a read of this table cannot be replayed as a cookie.
--
-- A grant is valid only while every one of these still holds at the moment it
-- is used (`repositories/stepUpGrants.ts`): not revoked, not expired, the
-- account's session_version and role unchanged since it was minted. It is
-- never extended by use: five minutes from the code, then a new code.
--
-- Added without IF NOT EXISTS on purpose, as 052 explains: a clash with an
-- unshipped production migration must fail the deploy's dry run.

CREATE TABLE step_up_grants (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- users.session_version when minted; any bump (sign out everywhere, password
  -- change, two-factor on or off, reclaim) ends the grant.
  session_version integer     NOT NULL,
  -- users.role when minted; compared again at use.
  role            text        NOT NULL,
  -- sha256 (hex) of the cookie handle. Never the handle itself.
  handle_hash     text        NOT NULL UNIQUE,
  action_class    text        NOT NULL CHECK (action_class IN ('operate')),
  -- Only an authenticator code mints a grant; a password never does.
  method          text        NOT NULL CHECK (method = 'totp'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX step_up_grants_user_expires_idx ON step_up_grants (user_id, expires_at);
