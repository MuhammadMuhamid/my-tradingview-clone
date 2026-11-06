-- 052: email verification, two-factor sign-in, GitHub sign-in and sign-in history.
--
-- Columns and tables are added without IF NOT EXISTS on purpose. Production has
-- migrations this repository doesn't ship, and a clash should fail the deploy's
-- dry run rather than silently reuse something with another shape.

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
-- GitHub's stable numeric id, never the login, which can change.
ALTER TABLE users ADD COLUMN github_id text;
-- AES-GCM ciphertext, as security/secrets.ts writes it. Present before
-- totp_enabled_at while setup waits for its first correct code.
ALTER TABLE users ADD COLUMN totp_secret_enc text;
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
-- The newest time step accepted, so a code can't be used twice.
ALTER TABLE users ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX users_github_id_key ON users (github_id) WHERE github_id IS NOT NULL;

-- Google only signs in an address it has verified. An account that also has a
-- password may have been created by anyone, so it verifies like any other.
UPDATE users SET email_verified_at = now()
 WHERE google_sub IS NOT NULL AND password_hash IS NULL AND email IS NOT NULL;

CREATE TABLE email_verification_tokens (
  token_hash  text        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email       text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);

CREATE TABLE totp_recovery_codes (
  code_hash text        PRIMARY KEY,
  user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  used_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX totp_recovery_codes_user_idx ON totp_recovery_codes (user_id);

CREATE TABLE login_events (
  id         bigserial   PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  method     text        NOT NULL CHECK (method IN ('password', 'google', 'github')),
  two_factor boolean     NOT NULL DEFAULT false,
  ip         text,
  user_agent text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_user_at_idx ON login_events (user_id, at DESC);
