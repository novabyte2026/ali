-- 0007 — Initial provider and policy records.
--
-- READ THIS BEFORE SHIPPING.
--
-- The capability states below are *conservative starting positions*, not legal
-- advice and not a claim about what any programme currently permits. They were
-- chosen so that the system under-claims rather than over-claims:
--
--   AVAILABLE              — the operation is the documented purpose of the
--                            programme's own API and we hold the credentials
--                            for it.
--   VERIFICATION_REQUIRED  — plausibly permitted, but nobody has checked the
--                            current terms and recorded that check. Treated as
--                            unavailable at runtime and listed in the
--                            Compliance Center as an action item.
--   NOT_PERMITTED          — we have positive reason to believe it is outside
--                            the programme's terms.
--
-- Before a production release, a human must review each row against the
-- programme's current published terms and record the review via the admin
-- Compliance Center, which writes a new policy version and an audit entry.
-- docs/compliance.md carries the checklist. Rule 255.

INSERT INTO providers (
  provider_id, display_name, programme_name, enabled,
  countries, default_country, currencies, market_hosts, sort_order
) VALUES
  (
    'amazon', 'Amazon', 'Amazon Associates', FALSE,
    ARRAY['US','GB','DE','FR','IT','ES','CA','AU','IL'], 'US',
    ARRAY['USD','GBP','EUR','CAD','AUD'],
    '{"US":"www.amazon.com","GB":"www.amazon.co.uk","DE":"www.amazon.de","FR":"www.amazon.fr","IT":"www.amazon.it","ES":"www.amazon.es","CA":"www.amazon.ca","AU":"www.amazon.com.au","IL":"www.amazon.com"}'::jsonb,
    30
  ),
  (
    'aliexpress', 'AliExpress', 'AliExpress Affiliate Program', FALSE,
    ARRAY['IL','US','GB','DE','FR','IT','ES','NL','CA','AU'], 'IL',
    ARRAY['USD','EUR','ILS','GBP'],
    '{"default":"www.aliexpress.com"}'::jsonb,
    20
  ),
  (
    'temu', 'Temu', 'Temu Affiliate Program', FALSE,
    ARRAY['IL','US','GB','DE','FR','IT','ES','NL','CA','AU'], 'IL',
    ARRAY['USD','EUR','ILS','GBP'],
    '{"default":"www.temu.com"}'::jsonb,
    10
  )
ON CONFLICT (provider_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Amazon
--
-- Two positions below are deliberate and load-bearing for the product:
--
--  * priceHistory / priceAlerts are NOT_PERMITTED. The Associates programme
--    places tight limits on retaining Product Advertising API data, which a
--    long-run price series cannot be built within. Rather than build the
--    feature and hope, the platform declines it for this source and tells the
--    user plainly. Rule 23.
--  * max_cache_seconds is 3600 and persistence_permitted is FALSE, so Amazon
--    responses are cache-only and are never written to product_sources or
--    price_observations. The retention worker enforces it independently.
-- ---------------------------------------------------------------------------
INSERT INTO provider_policies (
  policy_id, provider_id, policy_version, terms_url, policy_url,
  required_disclosures, disclosure_placements,
  logo_use_permitted, logo_asset_path, name_must_appear_as, may_imply_partnership, branding_notes,
  max_cache_seconds, max_retention_seconds, model_training_permitted,
  persistence_permitted, cross_provider_display_permitted,
  allowed_destination_hosts, required_query_params, forbidden_query_params,
  interstitial_redirect_permitted,
  reviewed_by, reviewed_at, policy_checked_at, notes, effective_from
) VALUES (
  'pol_amazon_0001', 'amazon', '2025.01-initial',
  'https://affiliate-program.amazon.com/help/operating/agreement',
  'https://affiliate-program.amazon.com/help/operating/policies',
  '{
     "en": "As an Amazon Associate we may earn from qualifying purchases. Prices and availability are accurate as of the time shown and are subject to change. Any price and availability information displayed on Amazon at the time of purchase will apply.",
     "he": "אנחנו משתתפים בתוכנית השותפים של Amazon ועשויים לקבל עמלה מרכישות מתאימות. המחיר והזמינות נכונים למועד שמוצג כאן ועשויים להשתנות. המחיר והזמינות שיופיעו ב-Amazon בעת הרכישה הם הקובעים."
   }'::jsonb,
  ARRAY['FOOTER','NEAR_LINK','PRODUCT_PAGE','SEARCH_RESULTS'],
  FALSE, NULL, 'Amazon', FALSE,
  'Logo and trademark use requires separate written permission. Until that is recorded here the UI renders a neutral text badge and never a lookalike mark.',
  3600, NULL, FALSE,
  FALSE, TRUE,
  ARRAY['www.amazon.com','www.amazon.co.uk','www.amazon.de','www.amazon.fr','www.amazon.it','www.amazon.es','www.amazon.ca','www.amazon.com.au','amzn.to'],
  ARRAY['tag'], ARRAY[]::TEXT[],
  FALSE,
  NULL, NULL, NULL,
  'Starting position only; every capability needs confirmation against the current Operating Agreement before release. The price-timestamp disclosure is required wherever a price is shown, which is why every price carries an observedAt.',
  now()
) ON CONFLICT (policy_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- AliExpress
-- ---------------------------------------------------------------------------
INSERT INTO provider_policies (
  policy_id, provider_id, policy_version, terms_url, policy_url,
  required_disclosures, disclosure_placements,
  logo_use_permitted, logo_asset_path, name_must_appear_as, may_imply_partnership, branding_notes,
  max_cache_seconds, max_retention_seconds, model_training_permitted,
  persistence_permitted, cross_provider_display_permitted,
  allowed_destination_hosts, required_query_params, forbidden_query_params,
  interstitial_redirect_permitted,
  reviewed_by, reviewed_at, policy_checked_at, notes, effective_from
) VALUES (
  'pol_aliexpress_0001', 'aliexpress', '2025.01-initial',
  'https://portals.aliexpress.com', 'https://portals.aliexpress.com',
  '{
     "en": "We participate in the AliExpress affiliate programme and may earn a commission when you buy through our links. Prices and availability are set by the seller and shown as of the time indicated.",
     "he": "אנחנו משתתפים בתוכנית השותפים של AliExpress ועשויים לקבל עמלה כאשר רוכשים דרך הקישורים שלנו. המחיר והזמינות נקבעים על ידי המוכר ומוצגים לפי המועד המצוין."
   }'::jsonb,
  ARRAY['FOOTER','NEAR_LINK','PRODUCT_PAGE'],
  FALSE, NULL, 'AliExpress', FALSE,
  'Brand asset use pending written confirmation.',
  21600, 7776000, FALSE,
  TRUE, TRUE,
  ARRAY['www.aliexpress.com','aliexpress.com','s.click.aliexpress.com','a.aliexpress.com'],
  ARRAY[]::TEXT[], ARRAY[]::TEXT[],
  FALSE,
  NULL, NULL, NULL,
  'Affiliate link generation must go through the programme''s own link API rather than appending parameters by hand; the adapter does that and refuses to hand-assemble.',
  now()
) ON CONFLICT (policy_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Temu
--
-- Every capability ships as VERIFICATION_REQUIRED. The partner API surface is
-- granted per account and is not publicly documented, so inventing endpoint
-- shapes and asserting permissions would be exactly the fabrication this
-- platform is built to avoid. The adapter is complete and interface-compatible;
-- it refuses every operation with CAPABILITY_VERIFICATION_REQUIRED until an
-- operator records a real programme contract. Rule 297.
-- ---------------------------------------------------------------------------
INSERT INTO provider_policies (
  policy_id, provider_id, policy_version, terms_url, policy_url,
  required_disclosures, disclosure_placements,
  logo_use_permitted, logo_asset_path, name_must_appear_as, may_imply_partnership, branding_notes,
  max_cache_seconds, max_retention_seconds, model_training_permitted,
  persistence_permitted, cross_provider_display_permitted,
  allowed_destination_hosts, required_query_params, forbidden_query_params,
  interstitial_redirect_permitted,
  reviewed_by, reviewed_at, policy_checked_at, notes, effective_from
) VALUES (
  'pol_temu_0001', 'temu', '2025.01-unverified',
  NULL, NULL,
  '{
     "en": "We may earn a commission when you buy through our links. Prices and availability are set by the store.",
     "he": "אנחנו עשויים לקבל עמלה כאשר רוכשים דרך הקישורים שלנו. המחיר והזמינות נקבעים על ידי החנות."
   }'::jsonb,
  ARRAY['FOOTER','NEAR_LINK'],
  FALSE, NULL, 'Temu', FALSE,
  'Brand asset use not established.',
  0, NULL, FALSE,
  FALSE, FALSE,
  ARRAY['www.temu.com','temu.com'],
  ARRAY[]::TEXT[], ARRAY[]::TEXT[],
  FALSE,
  NULL, NULL, NULL,
  'No capability may be moved to AVAILABLE until the programme contract, endpoints and content permissions are recorded here by a named reviewer.',
  now()
) ON CONFLICT (policy_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Capability states.
--
-- Written as data so the whole matrix is reviewable in one place, and so a
-- reviewer changing one cell writes one new policy version rather than editing
-- application code.
-- ---------------------------------------------------------------------------
INSERT INTO provider_capabilities (provider_id, policy_id, capability, state, rationale)
VALUES
  -- Amazon ----------------------------------------------------------------
  ('amazon', 'pol_amazon_0001', 'search', 'AVAILABLE', 'SearchItems is the documented purpose of the Product Advertising API.'),
  ('amazon', 'pol_amazon_0001', 'productDetails', 'AVAILABLE', 'GetItems.'),
  ('amazon', 'pol_amazon_0001', 'urlLookup', 'AVAILABLE', 'ASIN is extracted from the URL path and resolved via GetItems. No page fetch.'),
  ('amazon', 'pol_amazon_0001', 'productImages', 'AVAILABLE', 'Images resource is returned for display by participants.'),
  ('amazon', 'pol_amazon_0001', 'productContent', 'AVAILABLE', 'ItemInfo title and features.'),
  ('amazon', 'pol_amazon_0001', 'productIdentifiers', 'AVAILABLE', 'ASIN always; EAN/UPC where the ExternalIds resource returns them.'),
  ('amazon', 'pol_amazon_0001', 'ratings', 'VERIFICATION_REQUIRED', 'PA-API 5.0 does not expose a numeric star rating; any other route needs confirmation.'),
  ('amazon', 'pol_amazon_0001', 'reviewCounts', 'VERIFICATION_REQUIRED', 'Same as ratings.'),
  ('amazon', 'pol_amazon_0001', 'reviewContent', 'NOT_PERMITTED', 'Review text is not licensed for display through this programme.'),
  ('amazon', 'pol_amazon_0001', 'currentPrice', 'AVAILABLE', 'Offers.Listings.Price, displayed with its observation time as the terms require.'),
  ('amazon', 'pol_amazon_0001', 'referencePrice', 'VERIFICATION_REQUIRED', 'A saving basis is sometimes returned; the rules for presenting it as a was-price need confirmation.'),
  ('amazon', 'pol_amazon_0001', 'shipping', 'VERIFICATION_REQUIRED', 'Free-shipping eligibility is available; a destination shipping cost generally is not.'),
  ('amazon', 'pol_amazon_0001', 'priceHistory', 'NOT_PERMITTED', 'Retaining a long-run price series is not compatible with the programme''s data retention limits.'),
  ('amazon', 'pol_amazon_0001', 'priceAlerts', 'NOT_PERMITTED', 'Depends on retained observations, which are not permitted here. Users are told this rather than offered a control that cannot work.'),
  ('amazon', 'pol_amazon_0001', 'coupons', 'VERIFICATION_REQUIRED', 'Promotion data exposure and display rules need confirmation.'),
  ('amazon', 'pol_amazon_0001', 'deals', 'VERIFICATION_REQUIRED', 'No confirmed deal discovery surface.'),
  ('amazon', 'pol_amazon_0001', 'availability', 'AVAILABLE', 'Offers.Listings.Availability.'),
  ('amazon', 'pol_amazon_0001', 'sellerInfo', 'VERIFICATION_REQUIRED', 'MerchantInfo is returned; display rules need confirmation.'),
  ('amazon', 'pol_amazon_0001', 'affiliateLinks', 'AVAILABLE', 'DetailPageURL arrives already carrying the partner tag; the adapter uses it as given.'),
  ('amazon', 'pol_amazon_0001', 'brandAssets', 'NOT_PERMITTED', 'No written logo permission recorded.'),
  ('amazon', 'pol_amazon_0001', 'persistProviderData', 'NOT_PERMITTED', 'Cache-only, one hour. Nothing is written to the catalog or observation tables.'),
  ('amazon', 'pol_amazon_0001', 'crossProviderComparison', 'AVAILABLE', 'Price comparison is an established use of the programme, conditional on showing the price observation time.'),

  -- AliExpress ------------------------------------------------------------
  ('aliexpress', 'pol_aliexpress_0001', 'search', 'AVAILABLE', 'Affiliate product query.'),
  ('aliexpress', 'pol_aliexpress_0001', 'productDetails', 'AVAILABLE', 'Affiliate product detail.'),
  ('aliexpress', 'pol_aliexpress_0001', 'urlLookup', 'AVAILABLE', 'Product id parsed from the URL and resolved through the detail API.'),
  ('aliexpress', 'pol_aliexpress_0001', 'productImages', 'AVAILABLE', 'Image URLs are returned for affiliate display.'),
  ('aliexpress', 'pol_aliexpress_0001', 'productContent', 'AVAILABLE', 'Title and attributes.'),
  ('aliexpress', 'pol_aliexpress_0001', 'productIdentifiers', 'AVAILABLE', 'Permission to display identifiers we receive. Most listings carry no GTIN, which the UI reports as unknown rather than guessing.'),
  ('aliexpress', 'pol_aliexpress_0001', 'ratings', 'AVAILABLE', 'Product evaluation rate is returned.'),
  ('aliexpress', 'pol_aliexpress_0001', 'reviewCounts', 'AVAILABLE', 'Returned alongside the rating.'),
  ('aliexpress', 'pol_aliexpress_0001', 'reviewContent', 'VERIFICATION_REQUIRED', 'Review text display not confirmed.'),
  ('aliexpress', 'pol_aliexpress_0001', 'currentPrice', 'AVAILABLE', 'Sale price in the requested currency.'),
  ('aliexpress', 'pol_aliexpress_0001', 'referencePrice', 'AVAILABLE', 'Original price is returned by the programme and may be shown as the seller''s stated reference.'),
  ('aliexpress', 'pol_aliexpress_0001', 'shipping', 'VERIFICATION_REQUIRED', 'Freight estimation is a separate API with per-account access; destination cost is reported as unknown until it is wired up.'),
  ('aliexpress', 'pol_aliexpress_0001', 'priceHistory', 'VERIFICATION_REQUIRED', 'Retention of observations needs confirmation; until then no series is written.'),
  ('aliexpress', 'pol_aliexpress_0001', 'priceAlerts', 'VERIFICATION_REQUIRED', 'Depends on the above.'),
  ('aliexpress', 'pol_aliexpress_0001', 'coupons', 'VERIFICATION_REQUIRED', 'Promotion and coupon surfaces vary by account and market.'),
  ('aliexpress', 'pol_aliexpress_0001', 'deals', 'AVAILABLE', 'Hot product query is a documented affiliate surface.'),
  ('aliexpress', 'pol_aliexpress_0001', 'availability', 'VERIFICATION_REQUIRED', 'Stock state is not reliably returned.'),
  ('aliexpress', 'pol_aliexpress_0001', 'sellerInfo', 'AVAILABLE', 'Store name and evaluation are returned.'),
  ('aliexpress', 'pol_aliexpress_0001', 'affiliateLinks', 'AVAILABLE', 'Generated through the programme''s own link API.'),
  ('aliexpress', 'pol_aliexpress_0001', 'brandAssets', 'NOT_PERMITTED', 'No written logo permission recorded.'),
  ('aliexpress', 'pol_aliexpress_0001', 'persistProviderData', 'AVAILABLE', 'Retention permitted within the policy window, which bounds max_retention_seconds at 90 days and drives the retention sweep.'),
  ('aliexpress', 'pol_aliexpress_0001', 'crossProviderComparison', 'AVAILABLE', 'Comparison is the purpose of the affiliate programme.'),

  -- Temu ------------------------------------------------------------------
  ('temu', 'pol_temu_0001', 'search', 'VERIFICATION_REQUIRED', 'Partner API surface not established for this account.'),
  ('temu', 'pol_temu_0001', 'productDetails', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'urlLookup', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'productImages', 'VERIFICATION_REQUIRED', 'Image display permission not established.'),
  ('temu', 'pol_temu_0001', 'productContent', 'VERIFICATION_REQUIRED', 'Content licence not established.'),
  ('temu', 'pol_temu_0001', 'productIdentifiers', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'ratings', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'reviewCounts', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'reviewContent', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'currentPrice', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'referencePrice', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'shipping', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'priceHistory', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'priceAlerts', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'coupons', 'VERIFICATION_REQUIRED', 'Referral and coupon tooling exists for the programme but its API access and display rules are not established here.'),
  ('temu', 'pol_temu_0001', 'deals', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'availability', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'sellerInfo', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'affiliateLinks', 'VERIFICATION_REQUIRED', 'Link format must come from the programme''s own tooling; until recorded the adapter emits the plain store URL with no tracking.'),
  ('temu', 'pol_temu_0001', 'brandAssets', 'NOT_PERMITTED', 'No written logo permission recorded.'),
  ('temu', 'pol_temu_0001', 'persistProviderData', 'VERIFICATION_REQUIRED', 'As above.'),
  ('temu', 'pol_temu_0001', 'crossProviderComparison', 'VERIFICATION_REQUIRED', 'As above.')
ON CONFLICT (policy_id, capability) DO NOTHING;

-- Affiliate routing per market. Tracking ids themselves come from the
-- environment at runtime; this table only records which market maps to which
-- marketplace host.
INSERT INTO affiliate_configurations (config_id, provider_id, country_code, marketplace_host)
VALUES
  ('afc_amazon_us', 'amazon', 'US', 'www.amazon.com'),
  ('afc_amazon_gb', 'amazon', 'GB', 'www.amazon.co.uk'),
  ('afc_amazon_de', 'amazon', 'DE', 'www.amazon.de'),
  ('afc_amazon_il', 'amazon', 'IL', 'www.amazon.com'),
  ('afc_aliexpress_il', 'aliexpress', 'IL', 'www.aliexpress.com'),
  ('afc_aliexpress_us', 'aliexpress', 'US', 'www.aliexpress.com'),
  ('afc_temu_il', 'temu', 'IL', 'www.temu.com'),
  ('afc_temu_us', 'temu', 'US', 'www.temu.com')
ON CONFLICT (config_id) DO NOTHING;
