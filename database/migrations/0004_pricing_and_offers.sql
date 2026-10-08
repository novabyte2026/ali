-- 0004 — Offers, price/shipping observations, coupons and FX rates.
--
-- Money is stored as integer minor units plus a currency code. There is no
-- NUMERIC price column anywhere, because the moment a price becomes a float
-- somebody's total is off by a cent and nobody can explain why.
--
-- Observations are append-only. `offers` is the latest view for serving;
-- `price_observations` is the history, and it is written only where the
-- provider's policy permits retention. That is why a price chart exists for
-- some sources and is honestly absent for others.

CREATE TABLE offers (
  offer_id            TEXT PRIMARY KEY,
  product_source_id   TEXT NOT NULL REFERENCES product_sources (product_source_id) ON DELETE CASCADE,
  provider_id         TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  country_code        TEXT NOT NULL,

  price_minor         BIGINT,
  currency            TEXT NOT NULL,
  -- Provider-supplied list price. NULL unless the referencePrice capability is
  -- AVAILABLE; we never reconstruct a "was" price from our own history.
  reference_price_minor BIGINT,

  availability        TEXT NOT NULL DEFAULT 'UNKNOWN',

  shipping_cost_minor BIGINT,
  shipping_free       BOOLEAN,
  shipping_days_low   INTEGER,
  shipping_days_high  INTEGER,
  shipping_service    TEXT,

  tax_amount_minor    BIGINT,
  tax_included_in_price BOOLEAN,
  tax_applied_rate    NUMERIC(6, 4),

  seller_name         TEXT,
  seller_rating       NUMERIC(3, 2),
  seller_first_party  BOOLEAN,

  source_url          TEXT NOT NULL,
  data_origin         TEXT NOT NULL DEFAULT 'PROVIDER_API',
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after         TIMESTAMPTZ,

  CONSTRAINT offers_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT offers_country_shape CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT offers_price_non_negative CHECK (price_minor IS NULL OR price_minor >= 0),
  CONSTRAINT offers_shipping_non_negative
    CHECK (shipping_cost_minor IS NULL OR shipping_cost_minor >= 0),
  CONSTRAINT offers_shipping_days_ordered CHECK (
    shipping_days_low IS NULL OR shipping_days_high IS NULL
    OR shipping_days_low <= shipping_days_high
  ),
  CONSTRAINT offers_availability_valid CHECK (
    availability IN ('IN_STOCK', 'LIMITED_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'UNKNOWN')
  )
);

CREATE UNIQUE INDEX offers_source_country_unique
  ON offers (product_source_id, country_code);
CREATE INDEX offers_provider_observed_idx ON offers (provider_id, observed_at DESC);
CREATE INDEX offers_price_idx ON offers (currency, price_minor)
  WHERE price_minor IS NOT NULL;
CREATE INDEX offers_purge_idx ON offers (purge_after) WHERE purge_after IS NOT NULL;

-- Append-only price history. One row per observed change, not per poll.
CREATE TABLE price_observations (
  observation_id      TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  provider_product_id TEXT NOT NULL,
  provider_variant_id TEXT,
  country_code        TEXT NOT NULL,
  price_minor         BIGINT NOT NULL,
  currency            TEXT NOT NULL,
  availability        TEXT NOT NULL DEFAULT 'UNKNOWN',
  data_origin         TEXT NOT NULL DEFAULT 'PROVIDER_API',
  confidence          TEXT NOT NULL DEFAULT 'HIGH',
  -- Policy version under which retaining this observation was permitted.
  stored_under_policy TEXT,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after         TIMESTAMPTZ,

  CONSTRAINT price_observations_price_non_negative CHECK (price_minor >= 0),
  CONSTRAINT price_observations_confidence_valid
    CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW'))
);

CREATE INDEX price_observations_series_idx
  ON price_observations (provider_id, provider_product_id, coalesce(provider_variant_id, ''), country_code, observed_at DESC);
CREATE INDEX price_observations_purge_idx ON price_observations (purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE shipping_observations (
  observation_id      TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  provider_product_id TEXT NOT NULL,
  destination_country TEXT NOT NULL,
  cost_minor          BIGINT,
  currency            TEXT NOT NULL,
  free                BOOLEAN,
  days_low            INTEGER,
  days_high           INTEGER,
  service             TEXT,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after         TIMESTAMPTZ,

  CONSTRAINT shipping_observations_country_shape
    CHECK (destination_country ~ '^[A-Z]{2}$')
);

CREATE INDEX shipping_observations_lookup_idx
  ON shipping_observations (provider_id, provider_product_id, destination_country, observed_at DESC);

-- Coupons. `code` is NULL for automatic promotions. We never generate a code.
CREATE TABLE coupons (
  coupon_id        TEXT PRIMARY KEY,
  provider_id      TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  code             TEXT,
  title            TEXT NOT NULL,
  terms            TEXT,

  discount_type    TEXT NOT NULL DEFAULT 'UNSPECIFIED',
  discount_percent NUMERIC(5, 2),
  discount_amount_minor BIGINT,
  discount_currency TEXT,

  minimum_order_minor BIGINT,
  minimum_order_currency TEXT,
  eligible_product_ids TEXT[] NOT NULL DEFAULT '{}',
  eligible_category_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  eligible_countries TEXT[] NOT NULL DEFAULT '{}',
  audience         TEXT NOT NULL DEFAULT 'UNKNOWN',
  stackable        BOOLEAN,

  starts_at        TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,

  status           TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_checked_at  TIMESTAMPTZ,
  verification_method TEXT NOT NULL DEFAULT 'NONE',
  source_url       TEXT,
  data_origin      TEXT NOT NULL DEFAULT 'PROVIDER_API',

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after      TIMESTAMPTZ,

  CONSTRAINT coupons_status_valid CHECK (
    status IN ('VERIFIED', 'RECENTLY_CHECKED', 'POSSIBLY_ACTIVE', 'EXPIRED', 'INVALID', 'UNKNOWN')
  ),
  CONSTRAINT coupons_discount_type_valid CHECK (
    discount_type IN ('PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING', 'TIERED', 'BUNDLE', 'UNSPECIFIED')
  ),
  CONSTRAINT coupons_audience_valid CHECK (
    audience IN ('ANY', 'NEW_CUSTOMERS', 'APP_ONLY', 'ACCOUNT_SPECIFIC', 'UNKNOWN')
  ),
  CONSTRAINT coupons_verification_method_valid CHECK (
    verification_method IN ('PROVIDER_API', 'PROVIDER_FEED', 'AFFILIATE_TOOL', 'NONE')
  ),
  -- A percentage coupon must carry a percentage; a fixed one an amount. Stops
  -- a half-populated row from rendering as "discount available" with no value.
  CONSTRAINT coupons_discount_value_present CHECK (
    (discount_type <> 'PERCENTAGE' OR discount_percent IS NOT NULL)
    AND (discount_type <> 'FIXED_AMOUNT'
         OR (discount_amount_minor IS NOT NULL AND discount_currency IS NOT NULL))
  )
);

CREATE UNIQUE INDEX coupons_provider_code_unique
  ON coupons (provider_id, code)
  WHERE code IS NOT NULL;
CREATE INDEX coupons_provider_status_idx ON coupons (provider_id, status, expires_at DESC);
CREATE INDEX coupons_expiry_idx ON coupons (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX coupons_eligible_products_idx ON coupons USING GIN (eligible_product_ids);

CREATE TRIGGER coupons_set_updated_at
  BEFORE UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every verification attempt, so a status claim can be traced to a check.
CREATE TABLE coupon_checks (
  check_id     TEXT PRIMARY KEY,
  coupon_id    TEXT NOT NULL REFERENCES coupons (coupon_id) ON DELETE CASCADE,
  method       TEXT NOT NULL,
  result       TEXT NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX coupon_checks_coupon_idx ON coupon_checks (coupon_id, checked_at DESC);

-- FX rates with their own as-of date, so a converted figure can be dated in
-- the UI rather than appearing as though we knew the rate at display time.
CREATE TABLE exchange_rates (
  base_currency  TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate           NUMERIC(18, 8) NOT NULL,
  as_of          TIMESTAMPTZ NOT NULL,
  source         TEXT NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (base_currency, quote_currency, as_of),
  CONSTRAINT exchange_rates_rate_positive CHECK (rate > 0)
);

CREATE INDEX exchange_rates_latest_idx
  ON exchange_rates (base_currency, quote_currency, as_of DESC);
