-- 0003 — Product identity, per-source listings, variants and matches.
--
-- Three levels, deliberately separate:
--   product_groups   — a product identity we believe in (one thing in the world)
--   product_sources  — one provider's listing (what a marketplace says)
--   product_matches  — the evidence linking a listing to a group
--
-- Keeping matches as rows rather than a derived join is what makes the
-- decision auditable: the admin debugger can show exactly which signals led us
-- to call two listings the same product, and a later improvement to the engine
-- can be replayed against the stored evidence.
--
-- `raw_payload` holds the provider's own response. It is retained only where
-- that provider's policy permits persistence, is swept by the retention
-- worker, and is never served to a non-admin client.

CREATE TABLE product_groups (
  product_group_id TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  brand            TEXT,
  gtin             TEXT,
  mpn              TEXT,
  model            TEXT,
  category_path    TEXT[] NOT NULL DEFAULT '{}',
  -- Canonical variant key, e.g. 'capacity=128GB;colour=BLACK'. Empty when the
  -- group is variant-agnostic.
  variant_key      TEXT NOT NULL DEFAULT '',
  primary_image_url TEXT,
  -- True only when every member listing is identifier-backed. Gates whether
  -- the UI may present members as price rows for one product.
  comparable_across_sources BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT product_groups_gtin_shape CHECK (gtin IS NULL OR gtin ~ '^\d{14}$')
);

CREATE INDEX product_groups_gtin_idx ON product_groups (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX product_groups_mpn_idx ON product_groups (mpn) WHERE mpn IS NOT NULL;
CREATE INDEX product_groups_brand_model_idx ON product_groups (brand, model)
  WHERE brand IS NOT NULL AND model IS NOT NULL;
CREATE INDEX product_groups_category_idx ON product_groups USING GIN (category_path);
CREATE INDEX product_groups_title_trgm_idx ON product_groups USING GIN (title gin_trgm_ops);

-- One provider listing. Unique per (provider, product, variant).
CREATE TABLE product_sources (
  product_source_id   TEXT PRIMARY KEY,
  provider_id         TEXT NOT NULL REFERENCES providers (provider_id) ON DELETE CASCADE,
  provider_product_id TEXT NOT NULL,
  provider_variant_id TEXT,

  title               TEXT NOT NULL,
  raw_title           TEXT NOT NULL,
  brand               TEXT,
  gtin                TEXT,
  mpn                 TEXT,
  model               TEXT,
  category_path       TEXT[] NOT NULL DEFAULT '{}',
  variant_key         TEXT NOT NULL DEFAULT '',
  -- [{key, normalized, raw}]
  variant_attributes  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{key, label, value, unit}]
  specifications      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{url, width, height}] — only images we hold display permission for.
  images              JSONB NOT NULL DEFAULT '[]'::jsonb,

  rating              NUMERIC(3, 2),
  review_count        INTEGER,
  source_url          TEXT NOT NULL,

  -- Provider's own payload, admin-only, retention-swept.
  raw_payload         JSONB,
  -- Which policy version licensed storing this row.
  stored_under_policy TEXT,
  data_origin         TEXT NOT NULL DEFAULT 'PROVIDER_API',

  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after         TIMESTAMPTZ,

  CONSTRAINT product_sources_rating_range
    CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  CONSTRAINT product_sources_review_count_non_negative
    CHECK (review_count IS NULL OR review_count >= 0)
);

CREATE UNIQUE INDEX product_sources_identity_unique
  ON product_sources (provider_id, provider_product_id, coalesce(provider_variant_id, ''));
CREATE INDEX product_sources_gtin_idx ON product_sources (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX product_sources_mpn_idx ON product_sources (mpn) WHERE mpn IS NOT NULL;
CREATE INDEX product_sources_purge_idx ON product_sources (purge_after)
  WHERE purge_after IS NOT NULL;
CREATE INDEX product_sources_provider_seen_idx
  ON product_sources (provider_id, last_seen_at DESC);

-- The match decision, with its evidence retained.
CREATE TABLE product_matches (
  match_id          TEXT PRIMARY KEY,
  product_group_id  TEXT NOT NULL REFERENCES product_groups (product_group_id) ON DELETE CASCADE,
  product_source_id TEXT NOT NULL REFERENCES product_sources (product_source_id) ON DELETE CASCADE,
  match_level       TEXT NOT NULL,
  score             NUMERIC(4, 3) NOT NULL,
  band              TEXT NOT NULL,
  -- [{signal, field, weight, messageKey}]
  evidence          JSONB NOT NULL DEFAULT '[]'::jsonb,
  variant_conflict  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Engine version, so a scoring change can be identified and recomputed.
  engine_version    TEXT NOT NULL,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT product_matches_score_range CHECK (score >= 0 AND score <= 1),
  CONSTRAINT product_matches_level_valid CHECK (
    match_level IN (
      'EXACT_MATCH', 'LIKELY_SAME_MODEL', 'VARIANT_MATCH',
      'STRONG_SIMILARITY', 'ALTERNATIVE', 'WEAK_SIMILARITY', 'UNKNOWN'
    )
  ),
  CONSTRAINT product_matches_band_valid CHECK (band IN ('HIGH', 'MEDIUM', 'LOW'))
);

CREATE UNIQUE INDEX product_matches_pair_unique
  ON product_matches (product_group_id, product_source_id);
CREATE INDEX product_matches_source_idx ON product_matches (product_source_id);
CREATE INDEX product_matches_group_level_idx
  ON product_matches (product_group_id, match_level);
