/**
 * Production-readiness register (rule 253).
 *
 * Every feature in the product declares its own honest state here, and the
 * register is served at /api/v1/meta/features and rendered in the admin
 * console. The point is that nobody — operator, reviewer or user — has to
 * reverse-engineer from the UI whether something is wired to a live source.
 *
 * `PARTIAL` and `PLANNED` are legitimate states to ship in. Presenting either
 * as `PRODUCTION_READY` is not.
 */

export type FeatureStatus =
  /** Implemented end to end against live provider data. */
  | 'PRODUCTION_READY'
  /** Implemented, but a dependency limits it (capability, credential, scope). */
  | 'PARTIAL'
  /** Code exists and is exercised by tests, but no live integration yet. */
  | 'INTEGRATION_PENDING'
  /** Designed and typed, not implemented. */
  | 'PLANNED';

export interface FeatureStatusEntry {
  readonly id: string;
  readonly area:
    | 'search'
    | 'matching'
    | 'pricing'
    | 'coupons'
    | 'deals'
    | 'affiliate'
    | 'compliance'
    | 'accounts'
    | 'cart'
    | 'alerts'
    | 'admin'
    | 'analytics'
    | 'platform';
  readonly status: FeatureStatus;
  /** What is actually true today. Written for a sceptical reader. */
  readonly note: string;
  /** What has to happen for this to become PRODUCTION_READY. */
  readonly blockedBy?: string;
}

export const FEATURE_STATUS: ReadonlyArray<FeatureStatusEntry> = [
  // --- Search -------------------------------------------------------------
  {
    id: 'search.natural_language_parsing',
    area: 'search',
    status: 'PRODUCTION_READY',
    note: 'Hebrew and English budget, rating, brand, variant and source extraction, with the recognized tokens returned so the user can remove any of them.',
  },
  {
    id: 'search.parallel_aggregation',
    area: 'search',
    status: 'PRODUCTION_READY',
    note: 'Providers are queried concurrently with per-provider timeout, rate limit and circuit breaker. Partial failure degrades to the sources that answered.',
  },
  {
    id: 'search.streaming_progress',
    area: 'search',
    status: 'PRODUCTION_READY',
    note: 'Server-sent events carry real per-provider state transitions. No synthetic percentage is ever emitted.',
  },
  {
    id: 'search.ranking',
    area: 'search',
    status: 'PRODUCTION_READY',
    note: 'Hard filters, then intent/budget/match/quality/freshness scoring. Commission is not an input; there is no code path that reads it during ranking.',
  },
  {
    id: 'search.image_lookup',
    area: 'search',
    status: 'PLANNED',
    note: 'API contract, capability gate and low-confidence copy are defined; no vision model is wired up, and the endpoint returns ERROR_CAPABILITY_UNAVAILABLE rather than a guess.',
    blockedBy: 'Image embedding service selection and a provider-permitted image-search path.',
  },

  // --- Matching -----------------------------------------------------------
  {
    id: 'matching.identifier_based',
    area: 'matching',
    status: 'PRODUCTION_READY',
    note: 'GTIN (checksum-validated) and MPN agreement produce EXACT_MATCH. Variant conflicts demote to VARIANT_MATCH and are excluded from single-product price rows.',
  },
  {
    id: 'matching.heuristic_similarity',
    area: 'matching',
    status: 'PRODUCTION_READY',
    note: 'Title, spec and category evidence is capped so it can never assert identity on its own; the cap is covered by a unit test.',
  },
  {
    id: 'matching.image_similarity',
    area: 'matching',
    status: 'PLANNED',
    note: 'Signal and weight cap are defined. Not computed. Would remain incapable of asserting identity by design.',
    blockedBy: 'Perceptual hashing service, and per-provider confirmation that image processing is permitted.',
  },

  // --- Pricing ------------------------------------------------------------
  {
    id: 'pricing.total_cost_model',
    area: 'pricing',
    status: 'PRODUCTION_READY',
    note: 'Item, shipping, tax, discount and coupon combine with state propagation: any estimated or missing component prevents the total from presenting itself as exact.',
  },
  {
    id: 'pricing.tax_estimation',
    area: 'pricing',
    status: 'PARTIAL',
    note: 'Destination VAT produces a labelled ESTIMATED range from configured rates. Import duty, de-minimis handling and carrier fees are reported as not computable rather than estimated.',
    blockedBy: 'A duty/landed-cost data source, per destination country.',
  },
  {
    id: 'pricing.currency_conversion',
    area: 'pricing',
    status: 'PARTIAL',
    note: 'Conversion via a dated rate table; every converted figure carries the rate as-of date. The static driver ships with the repository and must be replaced for production.',
    blockedBy: 'An FX rate feed configured through FX_DRIVER=http.',
  },
  {
    id: 'pricing.price_history',
    area: 'pricing',
    status: 'PARTIAL',
    note: 'Observation store, series and percentile statistics are implemented and gated on the priceHistory + persistProviderData capabilities, which are not AVAILABLE for every provider by default.',
    blockedBy: 'Per-programme confirmation that retaining price observations is permitted.',
  },

  // --- Coupons ------------------------------------------------------------
  {
    id: 'coupons.verification_states',
    area: 'coupons',
    status: 'PRODUCTION_READY',
    note: 'Six-state model. Only VERIFIED codes are deducted from a total; POSSIBLY_ACTIVE is displayed as unconfirmed. No code is ever generated by us.',
  },
  {
    id: 'coupons.provider_ingestion',
    area: 'coupons',
    status: 'INTEGRATION_PENDING',
    note: 'Adapter interface, store, checker worker and eligibility model are complete. Live ingestion runs only for providers whose coupons capability is AVAILABLE and configured.',
    blockedBy: 'Authorized coupon endpoints per programme.',
  },

  // --- Deals --------------------------------------------------------------
  {
    id: 'deals.hunter',
    area: 'deals',
    status: 'PARTIAL',
    note: 'Seven evidence kinds implemented. The history-based kinds are unavailable wherever observation retention is not permitted, so the feed is genuinely thinner on those sources.',
  },
  {
    id: 'deals.radar',
    area: 'deals',
    status: 'PRODUCTION_READY',
    note: 'User subscriptions are refused at creation when the chosen providers cannot support deal discovery, with the reason returned.',
  },

  // --- Affiliate ----------------------------------------------------------
  {
    id: 'affiliate.link_engine',
    area: 'affiliate',
    status: 'PARTIAL',
    note: 'Per-adapter link construction, destination host allowlist, forbidden-parameter checks and disclosure resolution. Falls back to the plain store URL when a programme is unconfigured rather than emitting a malformed tracking link.',
    blockedBy: 'Programme credentials per provider.',
  },
  {
    id: 'affiliate.click_tracking',
    area: 'affiliate',
    status: 'PRODUCTION_READY',
    note: 'Clicks are recorded against a rotating session hash, separately from personal data, with placement and country.',
  },
  {
    id: 'affiliate.conversion_import',
    area: 'affiliate',
    status: 'PLANNED',
    note: 'Schema and reporting states exist. Nothing imports programme reports, and the admin UI shows commission as estimated until it does.',
    blockedBy: 'Programme reporting API access per provider.',
  },

  // --- Compliance ---------------------------------------------------------
  {
    id: 'compliance.policy_registry',
    area: 'compliance',
    status: 'PRODUCTION_READY',
    note: 'Versioned, database-backed, operator-editable with an audit trail. No provider permission is hardcoded in feature code.',
  },
  {
    id: 'compliance.capability_gates',
    area: 'compliance',
    status: 'PRODUCTION_READY',
    note: 'Every provider read passes a capability check; refusals are recorded as compliance events and surfaced as RESTRICTED to the UI.',
  },
  {
    id: 'compliance.kill_switches',
    area: 'compliance',
    status: 'PRODUCTION_READY',
    note: 'Per provider, per capability, effective immediately without a deploy, audited.',
  },
  {
    id: 'compliance.provider_terms_verification',
    area: 'compliance',
    status: 'PARTIAL',
    note: 'Default capability states are conservative and many ship as VERIFICATION_REQUIRED. Confirming them against each programme is a release gate, not a code task.',
    blockedBy: 'Human review against each programme’s current terms before production (see docs/compliance.md).',
  },

  // --- Accounts -----------------------------------------------------------
  {
    id: 'accounts.google_oauth',
    area: 'accounts',
    status: 'PARTIAL',
    note: 'Full authorization-code flow with PKCE, state binding, rotating opaque sessions and server-side revocation. Requires Google client credentials.',
    blockedBy: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.',
  },
  {
    id: 'accounts.rbac',
    area: 'accounts',
    status: 'PRODUCTION_READY',
    note: 'Role plus explicit permission checks in middleware on every non-public route. Guest limits are server-enforced and covered by tests that call the endpoints directly.',
  },
  {
    id: 'accounts.privacy_controls',
    area: 'accounts',
    status: 'PRODUCTION_READY',
    note: 'Search history off by default, granular consent, export and deletion implemented.',
  },

  // --- Cart / alerts ------------------------------------------------------
  {
    id: 'cart.smart_cart',
    area: 'cart',
    status: 'PRODUCTION_READY',
    note: 'Cross-store basket with per-store shipping and totals. Explicitly not a checkout; copy and CTAs route to each store.',
  },
  {
    id: 'alerts.engine',
    area: 'alerts',
    status: 'PARTIAL',
    note: 'Creation is capability-gated per kind and per provider; the worker evaluates and delivers in-app immediately.',
    blockedBy: 'SMTP configuration for e-mail delivery; MAIL_DRIVER=console otherwise.',
  },

  // --- Admin / analytics --------------------------------------------------
  {
    id: 'admin.compliance_center',
    area: 'admin',
    status: 'PRODUCTION_READY',
    note: 'Policy versions, verification backlog, disclosure configuration, kill switches and warning counts per provider.',
  },
  {
    id: 'admin.source_health',
    area: 'admin',
    status: 'PRODUCTION_READY',
    note: 'Live latency percentiles, success rate, circuit state and rate-limit posture per provider.',
  },
  {
    id: 'admin.product_debugger',
    area: 'admin',
    status: 'PRODUCTION_READY',
    note: 'Raw provider payload, normalized view, match evidence, price derivation and link result, admin-only.',
  },
  {
    id: 'analytics.event_pipeline',
    area: 'analytics',
    status: 'PRODUCTION_READY',
    note: 'Allowlisted properties per event type; anything else is dropped on ingest. Session-scoped by default, user-scoped only with consent.',
  },

  // --- Platform -----------------------------------------------------------
  {
    id: 'platform.demo_fixtures',
    area: 'platform',
    status: 'PRODUCTION_READY',
    note: 'Fixtures are tagged dataOrigin=DEMO_FIXTURE, propagate a demo flag to every response, drive a persistent UI banner, and the backend refuses to boot with them enabled in production.',
  },
  {
    id: 'platform.caching',
    area: 'platform',
    status: 'PRODUCTION_READY',
    note: 'Per-provider TTL capped by that provider’s policy maxCacheSeconds; cached figures are re-dated and demoted to UNKNOWN past their freshness tolerance.',
  },
  {
    id: 'platform.queue',
    area: 'platform',
    status: 'PARTIAL',
    note: 'Driver abstraction with an in-memory implementation for single-process development and a Redis implementation for real deployments.',
    blockedBy: 'QUEUE_DRIVER=redis plus REDIS_URL in any multi-instance deployment.',
  },
];

export function featureStatus(id: string): FeatureStatusEntry | undefined {
  return FEATURE_STATUS.find((entry) => entry.id === id);
}

export function featuresByStatus(status: FeatureStatus): ReadonlyArray<FeatureStatusEntry> {
  return FEATURE_STATUS.filter((entry) => entry.status === status);
}
