-- 0001 — Users, identities, sessions, consent.
--
-- Design notes that matter for review:
--   * Session tokens are never stored. Only a salted SHA-256 hash is kept, so
--     a database leak does not hand over live sessions.
--   * Privacy preferences default to the minimum: search history off,
--     personalized ranking off, analytics off. A comparison engine does not
--     need a behavioural profile in order to work.
--   * Deletion is real deletion of personal rows, with an anonymized stub kept
--     only where an affiliate attribution record legally must survive.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE user_role AS ENUM ('guest', 'user', 'admin');

CREATE TABLE users (
  user_id          TEXT PRIMARY KEY,
  -- Stored as the provider gave it, matched on the generated lowercase form.
  -- Avoids depending on the citext extension being available.
  email            TEXT NOT NULL,
  email_normalized TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  display_name     TEXT,
  avatar_url       TEXT,
  role             user_role NOT NULL DEFAULT 'user',

  -- Preferences
  locale           TEXT NOT NULL DEFAULT 'he',
  country_code     TEXT NOT NULL DEFAULT 'IL',
  currency         TEXT NOT NULL DEFAULT 'ILS',
  default_source_mode TEXT NOT NULL DEFAULT 'all',
  default_sort     TEXT NOT NULL DEFAULT 'MOST_RELEVANT',
  reduced_motion   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Privacy: all opt-in.
  store_search_history   BOOLEAN NOT NULL DEFAULT FALSE,
  personalized_ranking   BOOLEAN NOT NULL DEFAULT FALSE,
  product_analytics      BOOLEAN NOT NULL DEFAULT FALSE,
  marketing_emails       BOOLEAN NOT NULL DEFAULT FALSE,

  -- Notifications
  email_alerts     BOOLEAN NOT NULL DEFAULT TRUE,
  in_app_alerts    BOOLEAN NOT NULL DEFAULT TRUE,
  deal_digest      TEXT NOT NULL DEFAULT 'OFF',

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,

  CONSTRAINT users_locale_valid CHECK (locale IN ('he', 'en')),
  CONSTRAINT users_deal_digest_valid CHECK (deal_digest IN ('OFF', 'DAILY', 'WEEKLY')),
  CONSTRAINT users_country_shape CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT users_currency_shape CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX users_email_unique ON users (email_normalized) WHERE deleted_at IS NULL;
CREATE INDEX users_role_idx ON users (role) WHERE deleted_at IS NULL;

-- One row per external login. A user may later link more than one provider.
CREATE TABLE user_identities (
  identity_id       TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  provider_subject  TEXT NOT NULL,
  email_at_provider TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ,

  CONSTRAINT user_identities_provider_valid CHECK (provider IN ('google'))
);

CREATE UNIQUE INDEX user_identities_subject_unique
  ON user_identities (provider, provider_subject);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- Opaque, rotating sessions. The raw token exists only in the user's cookie.
CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  -- Set when this session is replaced by rotation, so a replayed old token is
  -- detectable rather than merely invalid.
  rotated_to      TEXT REFERENCES sessions (session_id) ON DELETE SET NULL,
  user_agent_hash TEXT,
  ip_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT
);

CREATE UNIQUE INDEX sessions_token_hash_unique ON sessions (token_hash);
CREATE INDEX sessions_user_active_idx ON sessions (user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at)
  WHERE revoked_at IS NULL;

-- Short-lived OAuth transaction state. PKCE verifier is stored server-side so
-- it never travels through the browser.
CREATE TABLE oauth_transactions (
  state_hash     TEXT PRIMARY KEY,
  code_verifier  TEXT NOT NULL,
  redirect_after TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX oauth_transactions_expiry_idx ON oauth_transactions (expires_at);

-- Immutable consent ledger. Answers "what did this person agree to, when".
CREATE TABLE user_consents (
  consent_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  consent_kind TEXT NOT NULL,
  granted      BOOLEAN NOT NULL,
  policy_version TEXT,
  source       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_consents_user_idx ON user_consents (user_id, consent_kind, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
