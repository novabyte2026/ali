import type {
  AffiliateLink,
  Capability,
  CapabilityMatrix,
  LinkPlacement,
  NormalizedCoupon,
  NormalizedOffer,
  NormalizedProduct,
  ProviderId,
} from '@shelf/shared';

/**
 * The provider adapter interface.
 *
 * Every marketplace implements the same shape, but — and this is the whole
 * point — implementing a method does not mean the operation is available. Each
 * call goes through `ctx.guard`, which resolves the current policy, the
 * operator kill switches and whether credentials exist. An adapter that cannot
 * legitimately answer returns a refusal with a reason; it never falls back to
 * a guess, and it never reaches for an unauthorized route to get the data
 * another way.
 *
 * Adding a provider means writing one of these plus a policy record. The
 * search engine, matcher and pricing engine do not change.
 */

export type AdapterOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly meta: AdapterCallMeta }
  | { readonly ok: false; readonly failure: AdapterFailure; readonly meta: AdapterCallMeta }
  /**
   * The operation is not available for this provider right now. Distinct from
   * a failure: nothing went wrong, we are simply not permitted or not set up.
   */
  | {
      readonly ok: false;
      readonly refusal: AdapterRefusal;
      readonly meta: AdapterCallMeta;
    };

export interface AdapterFailure {
  readonly code:
    | 'ERROR_SOURCE_TIMEOUT'
    | 'ERROR_SOURCE_UNAVAILABLE'
    | 'ERROR_PROVIDER_RATE_LIMIT'
    | 'ERROR_PROVIDER_AUTH_REJECTED'
    | 'ERROR_PROVIDER_RESPONSE_INVALID'
    | 'ERROR_INVALID_PRODUCT';
  readonly retryable: boolean;
  /** For logs only. Never serialized to a client. */
  readonly internalNote: string;
  readonly httpStatus?: number;
}

export interface AdapterRefusal {
  readonly code:
    | 'ERROR_CAPABILITY_UNAVAILABLE'
    | 'ERROR_CAPABILITY_VERIFICATION_REQUIRED'
    | 'ERROR_SOURCE_NOT_CONFIGURED'
    | 'ERROR_SOURCE_DISABLED'
    | 'ERROR_POLICY_BLOCK';
  readonly capability: Capability;
  /** Translation key for the user-facing explanation. */
  readonly messageKey: string;
}

export interface AdapterCallMeta {
  readonly providerId: ProviderId;
  readonly operation: string;
  readonly durationMs: number;
  readonly httpStatus: number | null;
  readonly rateLimited: boolean;
  /** True when this result came from a labelled development fixture. */
  readonly demoFixture: boolean;
  /** Set when the provider reported its own request id, for support cases. */
  readonly providerRequestId?: string;
}

export function adapterOk<T>(value: T, meta: AdapterCallMeta): AdapterOutcome<T> {
  return { ok: true, value, meta };
}

export function adapterFailed<T>(
  failure: AdapterFailure,
  meta: AdapterCallMeta,
): AdapterOutcome<T> {
  return { ok: false, failure, meta };
}

export function adapterRefused<T>(
  refusal: AdapterRefusal,
  meta: AdapterCallMeta,
): AdapterOutcome<T> {
  return { ok: false, refusal, meta };
}

export function isRefusal<T>(
  outcome: AdapterOutcome<T>,
): outcome is Extract<AdapterOutcome<T>, { refusal: AdapterRefusal }> {
  return !outcome.ok && 'refusal' in outcome;
}

export function isFailure<T>(
  outcome: AdapterOutcome<T>,
): outcome is Extract<AdapterOutcome<T>, { failure: AdapterFailure }> {
  return !outcome.ok && 'failure' in outcome;
}

/**
 * The permission oracle handed to adapters. Implemented in the backend against
 * the database policy registry; adapters receive it rather than reading policy
 * themselves, so there is exactly one place where permission is decided.
 */
export interface CapabilityGuard {
  /** Resolved state for one capability, after policy, config and kill switch. */
  check(capability: Capability): {
    readonly allowed: boolean;
    readonly state: string;
    readonly policyVersion: string;
  };
  /** Full current matrix, for the provider descriptor endpoint. */
  matrix(): CapabilityMatrix;
  /** Seconds this provider's responses may be cached. 0 = request-scoped. */
  maxCacheSeconds(): number;
  /** Whether responses may be written to our own store at all. */
  persistencePermitted(): boolean;
  /** Hosts a link may point at, per this provider's policy. */
  allowedDestinationHosts(): ReadonlyArray<string>;
  /** Query parameters this programme forbids us from adding. */
  forbiddenQueryParams(): ReadonlyArray<string>;
  /** Disclosure text for a locale, or null when none is configured. */
  disclosure(locale: string): string | null;
  readonly policyVersion: string;
}

export interface AdapterContext {
  readonly guard: CapabilityGuard;
  readonly countryCode: string;
  readonly currency: string;
  readonly locale: string;
  readonly requestId: string;
  /** Cooperative cancellation: a user who retypes cancels the old search. */
  readonly signal: AbortSignal;
  /** Structured logger, pre-bound with provider and request ids. */
  readonly log: AdapterLogger;
}

export interface AdapterLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface AdapterSearchRequest {
  readonly keywords: string;
  readonly brand?: string;
  readonly categoryPath?: ReadonlyArray<string>;
  /** Minor units in `currency`. Passed to the provider when it supports it. */
  readonly priceMinMinor?: number;
  readonly priceMaxMinor?: number;
  readonly minRating?: number;
  readonly page: number;
  readonly pageSize: number;
  readonly sort?: 'RELEVANCE' | 'PRICE_ASC' | 'PRICE_DESC' | 'RATING_DESC' | 'NEWEST';
}

export interface AdapterSearchResult {
  /** Listing plus its offer, together: they are observed in one call. */
  readonly items: ReadonlyArray<{
    readonly product: NormalizedProduct;
    readonly offer: NormalizedOffer;
  }>;
  /** Provider-reported total, when it gives one. Null is common and fine. */
  readonly totalAvailable: number | null;
  readonly page: number;
}

export interface AdapterProductRequest {
  readonly providerProductId: string;
  readonly providerVariantId?: string;
}

export interface AdapterCouponRequest {
  readonly providerProductId?: string;
  readonly categoryPath?: ReadonlyArray<string>;
  readonly limit: number;
}

export interface AdapterLinkRequest {
  readonly destinationUrl: string;
  readonly providerProductId: string;
  readonly placement: LinkPlacement;
  readonly trackingId: string | null;
  readonly campaignId: string | null;
}

/** Why a URL could not be resolved to a product, when it could not. */
export type UrlRecognition =
  | { readonly recognized: true; readonly providerProductId: string; readonly variantId?: string }
  | { readonly recognized: false; readonly reason: 'HOST_NOT_MINE' | 'NO_PRODUCT_ID_IN_URL' };

export interface ProviderAdapter {
  readonly providerId: ProviderId;

  /**
   * Capability states this adapter can determine on its own: whether
   * credentials and endpoints are configured. Policy and operator state are
   * layered on top by the backend, which always takes the more restrictive of
   * the two.
   */
  configuredCapabilities(): Readonly<Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>>;

  searchProducts(
    request: AdapterSearchRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AdapterSearchResult>>;

  getProduct(
    request: AdapterProductRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<{ product: NormalizedProduct; offer: NormalizedOffer }>>;

  getOffers(
    request: AdapterProductRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<ReadonlyArray<NormalizedOffer>>>;

  getCoupons(
    request: AdapterCouponRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<ReadonlyArray<NormalizedCoupon>>>;

  /**
   * Builds a tracking link. Must either produce a link in the format the
   * programme specifies or refuse — concatenating a parameter that a programme
   * does not recognize produces an untracked click and a terms problem.
   */
  buildAffiliateLink(
    request: AdapterLinkRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AffiliateLink>>;

  /** Parses a pasted URL. Pure and offline: no page is fetched. */
  recognizeUrl(url: string): UrlRecognition;

  /**
   * Whether a specific piece of provider content may be used for a purpose.
   * Called by the normalizer before retaining images, review text or raw
   * payloads, so a content restriction is applied at the boundary rather than
   * being remembered at render time.
   */
  validateContentUsage(
    usage: 'DISPLAY' | 'PERSIST' | 'MODEL_TRAINING' | 'EXPORT',
    kind: 'IMAGE' | 'TITLE' | 'DESCRIPTION' | 'REVIEW_TEXT' | 'RATING' | 'PRICE' | 'RAW_PAYLOAD',
    ctx: AdapterContext,
  ): { readonly permitted: boolean; readonly reasonKey: string | null };

  /** Programme disclosure text for a locale. */
  getDisclosure(locale: string, ctx: AdapterContext): string | null;
}
