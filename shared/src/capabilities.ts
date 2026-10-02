/**
 * Provider capability model.
 *
 * Nothing in this codebase assumes that two marketplaces permit the same
 * operations. A capability is a named thing we might do with a provider's data,
 * and for each provider each capability resolves to one of four states. The
 * resolution comes from configuration plus the database policy registry — never
 * from a hardcoded `if (providerId === 'amazon')` in feature code.
 *
 * `VERIFICATION_REQUIRED` exists because "we have not confirmed this is
 * permitted" is a genuinely different answer from "this is not permitted", and
 * conflating them either blocks legitimate features or ships illegitimate ones.
 */

export const CAPABILITIES = [
  /** Keyword product search. */
  'search',
  /** Fetch a single product's detail by provider id. */
  'productDetails',
  /** Resolve a pasted product URL to a provider product id. */
  'urlLookup',
  /** Display provider-supplied product images. */
  'productImages',
  /** Display provider-supplied descriptions, bullets and specifications. */
  'productContent',
  /** Display structured identifiers (GTIN/EAN/UPC/MPN/ASIN/SKU). */
  'productIdentifiers',
  /** Display aggregate star ratings. */
  'ratings',
  /** Display review counts. */
  'reviewCounts',
  /** Display review text or excerpts. */
  'reviewContent',
  /** Display the current offer price. */
  'currentPrice',
  /** Display a provider-supplied reference/list price for discount maths. */
  'referencePrice',
  /** Display shipping cost and delivery estimates. */
  'shipping',
  /** Persist observed prices to build a history series. */
  'priceHistory',
  /** Notify a user when a price changes or hits a target. */
  'priceAlerts',
  /** Surface coupons/promo codes. */
  'coupons',
  /** Surface time-limited deals and promotions. */
  'deals',
  /** Display stock/availability state. */
  'availability',
  /** Display seller identity and seller ratings. */
  'sellerInfo',
  /** Generate affiliate tracking links. */
  'affiliateLinks',
  /** Display the provider's brand mark in source badges. */
  'brandAssets',
  /** Store provider responses beyond the request that fetched them. */
  'persistProviderData',
  /** Combine this provider's offers with another's in one comparison view. */
  'crossProviderComparison',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityState =
  /** Permitted, configured and switched on. */
  | 'AVAILABLE'
  /** Known to be outside what we are licensed or technically allowed to do. */
  | 'NOT_PERMITTED'
  /**
   * Built, but we have not confirmed against this provider's current terms
   * that we may use it. Treated as unavailable at runtime and surfaced to
   * operators in the Compliance Center as an action item.
   */
  | 'VERIFICATION_REQUIRED'
  /** Permitted, but credentials/endpoints are absent from configuration. */
  | 'NOT_CONFIGURED'
  /** Permitted and configured, but an operator switched it off. */
  | 'DISABLED_BY_OPERATOR';

export type CapabilityMatrix = Readonly<Record<Capability, CapabilityState>>;

export interface CapabilityVerdict {
  readonly capability: Capability;
  readonly providerId: string;
  readonly state: CapabilityState;
  readonly allowed: boolean;
  /** Policy registry version the verdict was computed against. */
  readonly policyVersion: string;
}

/** Only AVAILABLE permits use. Everything else is a refusal with a reason. */
export function isCapabilityAllowed(state: CapabilityState): boolean {
  return state === 'AVAILABLE';
}

/**
 * Operator-facing severity. A capability we never claimed is fine; one that is
 * permitted but unconfigured is a deployment gap; one awaiting verification is
 * a compliance action item.
 */
export function capabilitySeverity(
  state: CapabilityState,
): 'OK' | 'INFO' | 'ATTENTION' | 'ACTION_REQUIRED' {
  switch (state) {
    case 'AVAILABLE':
      return 'OK';
    case 'NOT_PERMITTED':
      return 'INFO';
    case 'DISABLED_BY_OPERATOR':
      return 'INFO';
    case 'NOT_CONFIGURED':
      return 'ATTENTION';
    case 'VERIFICATION_REQUIRED':
      return 'ACTION_REQUIRED';
  }
}

export function emptyMatrix(state: CapabilityState = 'VERIFICATION_REQUIRED'): CapabilityMatrix {
  const matrix = {} as Record<Capability, CapabilityState>;
  for (const capability of CAPABILITIES) matrix[capability] = state;
  return matrix;
}

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Capabilities a user-facing feature needs. Used by feature gates so a feature
 * is offered only where every input it depends on is actually available —
 * rather than rendering a control that fails when clicked.
 */
export const FEATURE_CAPABILITY_REQUIREMENTS = {
  search: ['search'],
  productPage: ['productDetails'],
  priceComparison: ['currentPrice', 'crossProviderComparison'],
  sameProductCheaper: ['search', 'productIdentifiers', 'crossProviderComparison'],
  alternatives: ['search'],
  couponList: ['coupons'],
  dealFeed: ['deals'],
  dealRadar: ['deals', 'persistProviderData'],
  priceHistoryChart: ['priceHistory', 'persistProviderData'],
  priceAlert: ['priceAlerts', 'persistProviderData'],
  availabilityAlert: ['availability', 'persistProviderData'],
  urlAnalyzer: ['urlLookup', 'productDetails'],
  smartCart: ['currentPrice'],
  reviewsDisplay: ['ratings', 'reviewCounts'],
  sellerDisplay: ['sellerInfo'],
} as const satisfies Record<string, readonly Capability[]>;

export type FeatureName = keyof typeof FEATURE_CAPABILITY_REQUIREMENTS;

export const FEATURE_NAMES = Object.keys(FEATURE_CAPABILITY_REQUIREMENTS) as FeatureName[];

export interface FeatureGateVerdict {
  readonly feature: FeatureName;
  readonly providerId: string;
  readonly enabled: boolean;
  /** Capabilities that blocked the feature, with their states. */
  readonly blockedBy: ReadonlyArray<{
    readonly capability: Capability;
    readonly state: CapabilityState;
  }>;
}

export function evaluateFeature(
  feature: FeatureName,
  providerId: string,
  matrix: CapabilityMatrix,
): FeatureGateVerdict {
  const required = FEATURE_CAPABILITY_REQUIREMENTS[feature];
  const blockedBy = required
    .filter((capability) => !isCapabilityAllowed(matrix[capability]))
    .map((capability) => ({ capability, state: matrix[capability] }));
  return { feature, providerId, enabled: blockedBy.length === 0, blockedBy };
}
