-- 0002 — Providers, the policy registry, capability state and kill switches.
--
-- This migration is the legal spine of the product. The rule it enforces
-- structurally: no provider permission is expressed in application code. What
-- we may do with a marketplace's data lives in `provider_policies`, is
-- versioned, is editable by an operator, and every change is audited.
--
-- Capability states are deliberately conservative by default. A capability
-- ships as VERIFICATION_REQUIRED unless someone has checked the programme's
-- current terms and recorded that check — "we have not confirmed this" is a
-- different answer from "this is allowed", and the system refuses to conflate
-- them.

CREATE TYPE capability_state AS ENUM (
  'AVAILABLE',
  'NOT_PERMITTED',
  'VERIFICATION_REQUIRED',
  'NOT_CONFIGURED',
  'DISABLED_BY_OPERATOR'
);

CREATE TABLE providers (
  provider_id        TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  programme_name     TEXT NOT NULL,
  -- Operator master switch. Independent of credentials being present.
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  countries          TEXT[] NOT NULL DEFAULT '{}',
  default_country    TEXT NOT NULL,
  currencies         TEXT[] NOT NULL DEFAULT '{}',
  -- Marketplace host per country, e.g. {"IL":"www.amazon.com"}. Drives both
  -- link destinations and the destination host allowlist check.
  market_hosts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order         INTEGER NOT NULL DEFAULT 100,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT providers_default_country_shape CHECK (default_country ~ '^[A-Z]{2}$')
);

CREATE TRIGGER providers_set_updated_at
  BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Versioned policy records. Exactly one row per provider has
-- superseded_at IS NULL; that is the record in force.
CREATE TABLE provider_policies (
  policy_id        TEXT PRIMARY KEY,
  provider_id      TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  policy_version   TEXT NOT NULL,
  terms_url        TEXT,
  policy_url       TEXT,

  -- Disclosure text per locale: {"he": "...", "en": "..."}
  required_disclosures  JSONB NOT NULL DEFAULT '{}'::jsonb,
  disclosure_placements TEXT[] NOT NULL DEFAULT '{FOOTER,NEAR_LINK}',

  -- Branding
  logo_use_permitted    BOOLEAN NOT NULL DEFAULT FALSE,
  logo_asset_path       TEXT,
  name_must_appear_as   TEXT NOT NULL,
  may_imply_partnership BOOLEAN NOT NULL DEFAULT FALSE,
  branding_notes        TEXT,

  -- Data handling. max_cache_seconds = 0 means request-scoped only: the
  -- response may not outlive the request that fetched it.
  max_cache_seconds             INTEGER NOT NULL DEFAULT 0,
  max_retention_seconds         INTEGER,
  model_training_permitted      BOOLEAN NOT NULL DEFAULT FALSE,
  persistence_permitted         BOOLEAN NOT NULL DEFAULT FALSE,
  cross_provider_display_permitted BOOLEAN NOT NULL DEFAULT FALSE,

  -- Links
  allowed_destination_hosts TEXT[] NOT NULL DEFAULT '{}',
  required_query_params     TEXT[] NOT NULL DEFAULT '{}',
  forbidden_query_params    TEXT[] NOT NULL DEFAULT '{}',
  interstitial_redirect_permitted BOOLEAN NOT NULL DEFAULT FALSE,

  reviewed_by        TEXT,
  reviewed_at        TIMESTAMPTZ,
  policy_checked_at  TIMESTAMPTZ,
  notes              TEXT,
  effective_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT provider_policies_cache_non_negative CHECK (max_cache_seconds >= 0),
  CONSTRAINT provider_policies_retention_non_negative
    CHECK (max_retention_seconds IS NULL OR max_retention_seconds >= 0)
);

CREATE UNIQUE INDEX provider_policies_version_unique
  ON provider_policies (provider_id, policy_version);

-- Enforces "one policy in force per provider" at the database level rather
-- than hoping application code gets it right.
CREATE UNIQUE INDEX provider_policies_single_active
  ON provider_policies (provider_id)
  WHERE superseded_at IS NULL;

-- Capability state per provider, per policy version.
CREATE TABLE provider_capabilities (
  provider_id  TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  policy_id    TEXT NOT NULL REFERENCES provider_policies (policy_id) ON DELETE CASCADE,
  capability   TEXT NOT NULL,
  state        capability_state NOT NULL DEFAULT 'VERIFICATION_REQUIRED',
  -- Why this state. Required for NOT_PERMITTED so a future reader knows
  -- whether it is a programme restriction or a technical one.
  rationale    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (policy_id, capability)
);

CREATE INDEX provider_capabilities_provider_idx
  ON provider_capabilities (provider_id, capability);

-- Operator kill switches. Evaluated after policy and credentials, so engaging
-- one always wins. Effective immediately, no deploy (rule 200).
CREATE TABLE capability_kill_switches (
  provider_id  TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  capability   TEXT NOT NULL,
  engaged      BOOLEAN NOT NULL DEFAULT TRUE,
  engaged_by   TEXT,
  engaged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at  TIMESTAMPTZ,
  reason       TEXT,

  PRIMARY KEY (provider_id, capability)
);

CREATE INDEX capability_kill_switches_engaged_idx
  ON capability_kill_switches (provider_id)
  WHERE engaged = TRUE;

-- Affiliate programme configuration. Credentials themselves are NOT stored
-- here — they come from the environment or a secret manager. This table holds
-- only the non-secret routing: which tracking id to use for which market.
CREATE TABLE affiliate_configurations (
  config_id     TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  country_code  TEXT NOT NULL,
  tracking_id   TEXT,
  campaign_id   TEXT,
  marketplace_host TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT affiliate_configurations_country_shape CHECK (country_code ~ '^[A-Z]{2}$')
);

CREATE UNIQUE INDEX affiliate_configurations_provider_country_unique
  ON affiliate_configurations (provider_id, country_code)
  WHERE active = TRUE;

CREATE TRIGGER affiliate_configurations_set_updated_at
  BEFORE UPDATE ON affiliate_configurations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Compliance event log. Written whenever a capability check refuses something,
-- a disclosure is missing, a link fails validation or a retention sweep runs.
CREATE TABLE compliance_events (
  event_id       TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  provider_id    TEXT REFERENCES providers (provider_id) ON DELETE SET NULL,
  capability     TEXT,
  severity       TEXT NOT NULL DEFAULT 'INFO',
  policy_version TEXT,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT compliance_events_severity_valid
    CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL'))
);

CREATE INDEX compliance_events_recent_idx ON compliance_events (created_at DESC);
CREATE INDEX compliance_events_provider_idx
  ON compliance_events (provider_id, created_at DESC);
CREATE INDEX compliance_events_open_warnings_idx
  ON compliance_events (provider_id, severity, created_at DESC)
  WHERE severity <> 'INFO';

-- Audit log for every operator action that changes what the system shows.
CREATE TABLE audit_logs (
  entry_id     TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  actor_email  TEXT,
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT,
  before       JSONB,
  after        JSONB,
  reason       TEXT,
  request_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_recent_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_subject_idx ON audit_logs (subject_type, subject_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
