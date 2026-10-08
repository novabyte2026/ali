-- 0005 — Favourites, watchlists, saved searches, alerts, carts, deals.
--
-- Everything here belongs to a signed-in user and is deleted with them. A
-- guest has no rows in any of these tables, which is the point: the guest
-- limitation is a data-model boundary enforced by foreign keys, not a hidden
-- button in the UI.

CREATE TABLE favorites (
  favorite_id       TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  product_group_id  TEXT REFERENCES product_groups (product_group_id) ON DELETE SET NULL,
  provider_id       TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  provider_product_id TEXT NOT NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX favorites_user_product_unique
  ON favorites (user_id, provider_id, provider_product_id);
CREATE INDEX favorites_user_idx ON favorites (user_id, created_at DESC);

CREATE TABLE watchlist_entries (
  entry_id          TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  product_group_id  TEXT REFERENCES product_groups (product_group_id) ON DELETE SET NULL,
  provider_id       TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  provider_product_id TEXT NOT NULL,
  provider_variant_id TEXT,
  country_code      TEXT NOT NULL,
  -- Snapshot at the time of adding, so "changed since you saved it" is real.
  baseline_price_minor BIGINT,
  baseline_currency TEXT,
  baseline_observed_at TIMESTAMPTZ,
  last_checked_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX watchlist_entries_unique
  ON watchlist_entries (user_id, provider_id, provider_product_id, coalesce(provider_variant_id, ''));
CREATE INDEX watchlist_entries_user_idx ON watchlist_entries (user_id, created_at DESC);
CREATE INDEX watchlist_entries_sweep_idx ON watchlist_entries (last_checked_at NULLS FIRST);

CREATE TABLE saved_searches (
  saved_search_id TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  query           TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'all',
  filters         JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort            TEXT NOT NULL DEFAULT 'MOST_RELEVANT',
  country_code    TEXT NOT NULL,
  currency        TEXT NOT NULL,
  notify_on_new_results BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at     TIMESTAMPTZ
);

CREATE INDEX saved_searches_user_idx ON saved_searches (user_id, created_at DESC);
CREATE INDEX saved_searches_notify_idx ON saved_searches (notify_on_new_results, last_run_at NULLS FIRST)
  WHERE notify_on_new_results = TRUE;

-- Search history. Rows exist only for users who turned it on; the writer
-- checks `users.store_search_history` and the retention worker sweeps it.
CREATE TABLE search_history (
  history_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  query        TEXT NOT NULL,
  mode         TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  country_code TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after  TIMESTAMPTZ NOT NULL
);

CREATE INDEX search_history_user_idx ON search_history (user_id, created_at DESC);
CREATE INDEX search_history_purge_idx ON search_history (purge_after);

CREATE TABLE alerts (
  alert_id          TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  provider_id       TEXT REFERENCES providers (provider_id) ON DELETE CASCADE,
  product_group_id  TEXT REFERENCES product_groups (product_group_id) ON DELETE CASCADE,
  provider_product_id TEXT,
  provider_variant_id TEXT,
  country_code      TEXT NOT NULL,
  target_price_minor BIGINT,
  target_currency   TEXT,
  threshold_percent NUMERIC(5, 2),
  channels          TEXT[] NOT NULL DEFAULT '{IN_APP}',
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  -- Set when a capability change after creation made the alert unservable.
  -- The user is told, rather than the alert silently never firing.
  suspended_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_evaluated_at TIMESTAMPTZ,
  last_triggered_at TIMESTAMPTZ,

  CONSTRAINT alerts_kind_valid CHECK (
    kind IN ('PRICE_CHANGE', 'TARGET_PRICE', 'NEW_COUPON', 'NEW_DEAL',
             'AVAILABILITY_CHANGE', 'DEAL_ENDING', 'PRICE_ANOMALY')
  ),
  CONSTRAINT alerts_target_price_present CHECK (
    kind <> 'TARGET_PRICE'
    OR (target_price_minor IS NOT NULL AND target_currency IS NOT NULL)
  )
);

CREATE INDEX alerts_user_idx ON alerts (user_id, created_at DESC);
CREATE INDEX alerts_evaluation_idx ON alerts (active, last_evaluated_at NULLS FIRST)
  WHERE active = TRUE AND suspended_reason IS NULL;

CREATE TABLE alert_events (
  event_id     TEXT PRIMARY KEY,
  alert_id     TEXT NOT NULL REFERENCES alerts (alert_id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered_channels TEXT[] NOT NULL DEFAULT '{}',
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ
);

CREATE INDEX alert_events_user_idx ON alert_events (user_id, triggered_at DESC);
CREATE INDEX alert_events_unread_idx ON alert_events (user_id) WHERE read_at IS NULL;

-- Smart Cart: a comparison worksheet across stores. Not a checkout.
CREATE TABLE shopping_carts (
  cart_id      TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT 'My comparison',
  currency     TEXT NOT NULL,
  country_code TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX shopping_carts_user_idx ON shopping_carts (user_id, updated_at DESC);

CREATE TRIGGER shopping_carts_set_updated_at
  BEFORE UPDATE ON shopping_carts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cart_items (
  line_id      TEXT PRIMARY KEY,
  cart_id      TEXT NOT NULL REFERENCES shopping_carts (cart_id) ON DELETE CASCADE,
  provider_id  TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  provider_product_id TEXT NOT NULL,
  provider_variant_id TEXT,
  title        TEXT NOT NULL,
  image_url    TEXT,
  quantity     INTEGER NOT NULL DEFAULT 1,
  -- Offer snapshot at the moment of adding, including its observed_at.
  offer_snapshot JSONB NOT NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cart_items_quantity_positive CHECK (quantity > 0 AND quantity <= 99)
);

CREATE UNIQUE INDEX cart_items_unique
  ON cart_items (cart_id, provider_id, provider_product_id, coalesce(provider_variant_id, ''));
CREATE INDEX cart_items_cart_idx ON cart_items (cart_id);

-- Deals discovered by the hunter, with the evidence that made them deals.
CREATE TABLE deal_events (
  deal_id          TEXT PRIMARY KEY,
  provider_id      TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  product_group_id TEXT REFERENCES product_groups (product_group_id) ON DELETE CASCADE,
  provider_product_id TEXT NOT NULL,
  country_code     TEXT NOT NULL,
  -- [{kind, messageKey, savingsMinor, currency, basis}]
  evidence         JSONB NOT NULL DEFAULT '[]'::jsonb,
  strength         NUMERIC(4, 3) NOT NULL DEFAULT 0,
  band             TEXT NOT NULL DEFAULT 'LOW',
  coupon_id        TEXT REFERENCES coupons (coupon_id) ON DELETE SET NULL,
  -- Provider-stated end time only. NULL means we show no countdown at all.
  ends_at          TIMESTAMPTZ,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at       TIMESTAMPTZ,
  data_origin      TEXT NOT NULL DEFAULT 'PROVIDER_API',

  CONSTRAINT deal_events_strength_range CHECK (strength >= 0 AND strength <= 1),
  CONSTRAINT deal_events_band_valid CHECK (band IN ('HIGH', 'MEDIUM', 'LOW'))
);

CREATE UNIQUE INDEX deal_events_active_unique
  ON deal_events (provider_id, provider_product_id, country_code)
  WHERE retired_at IS NULL;
CREATE INDEX deal_events_feed_idx
  ON deal_events (country_code, strength DESC, last_confirmed_at DESC)
  WHERE retired_at IS NULL;
CREATE INDEX deal_events_provider_idx ON deal_events (provider_id, last_confirmed_at DESC);

CREATE TABLE deal_radar_subscriptions (
  radar_id       TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  category_path  TEXT[],
  keywords       TEXT,
  provider_ids   TEXT[] NOT NULL DEFAULT '{}',
  budget_max_minor BIGINT,
  budget_currency TEXT,
  min_rating     NUMERIC(3, 2),
  min_strength   NUMERIC(4, 3) NOT NULL DEFAULT 0.5,
  country_code   TEXT NOT NULL,
  require_verified_coupon BOOLEAN NOT NULL DEFAULT FALSE,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scanned_at TIMESTAMPTZ
);

CREATE INDEX deal_radar_user_idx ON deal_radar_subscriptions (user_id, created_at DESC);
CREATE INDEX deal_radar_scan_idx ON deal_radar_subscriptions (active, last_scanned_at NULLS FIRST)
  WHERE active = TRUE;
