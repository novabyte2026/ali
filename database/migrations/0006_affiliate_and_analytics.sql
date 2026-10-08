-- 0006 — Affiliate attribution, analytics, provider health, job state.
--
-- Separation that matters (rule 168): affiliate attribution, product analytics
-- and personal data live in different tables with different retention. A click
-- record carries a rotating session hash and an optional user id; an analytics
-- event carries the session hash only unless the user consented. Neither table
-- stores an IP address or a user agent string in the clear.

CREATE TABLE affiliate_clicks (
  click_id         TEXT PRIMARY KEY,
  provider_id      TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  -- NULL for guests. We do not mint a pseudo-user to fill the column.
  user_id          TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  session_hash     TEXT NOT NULL,
  product_group_id TEXT REFERENCES product_groups (product_group_id) ON DELETE SET NULL,
  provider_product_id TEXT,
  placement        TEXT NOT NULL,
  country_code     TEXT,
  device_type      TEXT NOT NULL DEFAULT 'UNKNOWN',
  campaign_id      TEXT,
  tracking_id      TEXT,
  -- Host we actually sent the visitor to, for link-integrity auditing.
  destination_host TEXT NOT NULL,
  link_status      TEXT NOT NULL DEFAULT 'OK',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT affiliate_clicks_device_valid
    CHECK (device_type IN ('DESKTOP', 'MOBILE', 'TABLET', 'UNKNOWN'))
);

CREATE INDEX affiliate_clicks_provider_idx ON affiliate_clicks (provider_id, created_at DESC);
CREATE INDEX affiliate_clicks_session_idx ON affiliate_clicks (session_hash, created_at DESC);
CREATE INDEX affiliate_clicks_user_idx ON affiliate_clicks (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX affiliate_clicks_placement_idx ON affiliate_clicks (placement, created_at DESC);

-- Conversions as reported by the programme. A click is never treated as a sale.
CREATE TABLE affiliate_conversions (
  conversion_id      TEXT PRIMARY KEY,
  provider_id        TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  provider_order_ref TEXT,
  click_id           TEXT REFERENCES affiliate_clicks (click_id) ON DELETE SET NULL,
  state              TEXT NOT NULL DEFAULT 'REPORTED',
  commission_minor   BIGINT,
  commission_currency TEXT,
  reported_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at         TIMESTAMPTZ,
  -- Which import run produced this row, so a bad import can be rolled back.
  import_batch_id    TEXT,

  CONSTRAINT affiliate_conversions_state_valid
    CHECK (state IN ('REPORTED', 'APPROVED', 'REVERSED', 'UNKNOWN'))
);

CREATE UNIQUE INDEX affiliate_conversions_order_unique
  ON affiliate_conversions (provider_id, provider_order_ref)
  WHERE provider_order_ref IS NOT NULL;
CREATE INDEX affiliate_conversions_provider_idx
  ON affiliate_conversions (provider_id, reported_at DESC);

CREATE TABLE analytics_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  user_id      TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  provider_id  TEXT REFERENCES providers (provider_id) ON DELETE SET NULL,
  country_code TEXT,
  device_type  TEXT NOT NULL DEFAULT 'UNKNOWN',
  -- Allowlisted keys only; the ingest path drops anything else.
  properties   JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after  TIMESTAMPTZ NOT NULL
);

CREATE INDEX analytics_events_type_idx ON analytics_events (event_type, occurred_at DESC);
CREATE INDEX analytics_events_session_idx ON analytics_events (session_hash, occurred_at DESC);
CREATE INDEX analytics_events_purge_idx ON analytics_events (purge_after);

-- Search telemetry, separate from behavioural analytics: this exists to run
-- the system (latency, failure, cache effectiveness), not to study users.
CREATE TABLE search_telemetry (
  telemetry_id   TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL,
  mode           TEXT NOT NULL,
  country_code   TEXT NOT NULL,
  providers_queried   INTEGER NOT NULL DEFAULT 0,
  providers_succeeded INTEGER NOT NULL DEFAULT 0,
  result_count   INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL,
  cache_hit      BOOLEAN NOT NULL DEFAULT FALSE,
  had_budget     BOOLEAN NOT NULL DEFAULT FALSE,
  zero_results   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after    TIMESTAMPTZ NOT NULL
);

CREATE INDEX search_telemetry_window_idx ON search_telemetry (created_at DESC);
CREATE INDEX search_telemetry_purge_idx ON search_telemetry (purge_after);

-- Per-call provider telemetry, feeding the Source Health panel.
CREATE TABLE provider_call_log (
  call_id      TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  operation    TEXT NOT NULL,
  status       TEXT NOT NULL,
  error_code   TEXT,
  duration_ms  INTEGER NOT NULL,
  http_status  INTEGER,
  rate_limited BOOLEAN NOT NULL DEFAULT FALSE,
  request_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after  TIMESTAMPTZ NOT NULL,

  CONSTRAINT provider_call_log_status_valid
    CHECK (status IN ('OK', 'EMPTY', 'FAILED', 'TIMEOUT', 'RATE_LIMITED', 'CIRCUIT_OPEN'))
);

CREATE INDEX provider_call_log_health_idx
  ON provider_call_log (provider_id, created_at DESC);
CREATE INDEX provider_call_log_purge_idx ON provider_call_log (purge_after);

-- Durable job state. The queue driver may be in-memory or Redis; this table is
-- the record of what ran, so a restart does not lose the schedule.
CREATE TABLE job_runs (
  run_id       TEXT PRIMARY KEY,
  job_name     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'RUNNING',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  duration_ms  INTEGER,
  items_processed INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  error_code   TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT job_runs_status_valid
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'SKIPPED'))
);

CREATE INDEX job_runs_name_idx ON job_runs (job_name, started_at DESC);
CREATE INDEX job_runs_active_idx ON job_runs (status) WHERE status = 'RUNNING';

-- Advisory singleton lock, so two worker instances do not run one job twice.
CREATE TABLE job_locks (
  job_name    TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Outbound mail/notification queue, so a delivery failure is retryable and
-- visible rather than lost in a log line.
CREATE TABLE notification_outbox (
  notification_id TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  template     TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'PENDING',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  send_after   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,

  CONSTRAINT notification_outbox_status_valid
    CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  CONSTRAINT notification_outbox_channel_valid
    CHECK (channel IN ('EMAIL', 'IN_APP'))
);

CREATE INDEX notification_outbox_pending_idx
  ON notification_outbox (status, send_after)
  WHERE status = 'PENDING';
CREATE INDEX notification_outbox_user_idx ON notification_outbox (user_id, created_at DESC);
