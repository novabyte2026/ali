import {
  type AffiliateLink,
  type Capability,
  type NormalizedCoupon,
  type NormalizedOffer,
  type NormalizedProduct,
  CAPABILITIES,
} from '@shelf/shared';
import {
  type AdapterContext,
  type AdapterCouponRequest,
  type AdapterLinkRequest,
  type AdapterOutcome,
  type AdapterProductRequest,
  type AdapterSearchRequest,
  type AdapterSearchResult,
  type ProviderAdapter,
  type UrlRecognition,
  adapterFailed,
  adapterOk,
  adapterRefused,
} from '../common/adapter.js';
import type { AmazonConfig } from '../common/config.js';
import { HttpError, httpRequest, parseJson } from '../common/http.js';
import { mappingContextFrom } from '../common/mapping.js';
import { resilienceFor } from '../common/resilience.js';
import { buildAffiliateLinkFromUrl } from '../common/links.js';
import { mapAmazonItem } from './mapper.js';
import { signPaapiRequest } from './signer.js';
import {
  GET_ITEMS_RESOURCES,
  SEARCH_RESOURCES,
  classifyPaapiError,
  type PaapiGetItemsResponse,
  type PaapiItem,
  type PaapiSearchResponse,
} from './types.js';

const PROVIDER_ID = 'amazon';
const TARGET_PREFIX = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1';

/**
 * Amazon adapter — Product Advertising API 5.0 with Associates attribution.
 *
 * Amazon is not treated as "one more generic API" (rule 21). Three things are
 * specific to it and are handled here rather than generically:
 *
 *  1. Requests are AWS SigV4 signed against the `ProductAdvertisingAPI`
 *     service, per marketplace host and region.
 *  2. Affiliate attribution is already present: `DetailPageURL` arrives
 *     carrying the partner tag, so the link engine reuses it rather than
 *     rebuilding a URL and risking a malformed or untracked link.
 *  3. The quota is small — new accounts start near one request per second and
 *     it shrinks if exceeded — so every call goes through the token bucket and
 *     a search will skip this source rather than queue behind it.
 *
 * Capability posture, from the policy registry rather than from here: price
 * history and price alerts are NOT_PERMITTED for this source because a
 * long-run observation series is not compatible with the programme's data
 * retention limits. The adapter therefore has no code path that writes
 * observations, and the API refuses to create such an alert with an
 * explanation instead of offering a control that cannot work.
 */
export class AmazonAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;

  private readonly resilience;

  constructor(
    private readonly config: AmazonConfig,
    private readonly timeouts: { readonly requestTimeoutMs: number; readonly rateLimitWaitMs: number },
    /** Injected for deterministic signature tests. */
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.resilience = resilienceFor(PROVIDER_ID, {
      requestsPerSecond: config.rateLimitRps,
      burst: config.rateLimitBurst,
    });
  }

  configuredCapabilities(): Readonly<Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>> {
    const ready =
      this.config.enabled &&
      Boolean(this.config.accessKey) &&
      Boolean(this.config.secretKey) &&
      Boolean(this.config.partnerTag) &&
      Boolean(this.config.host) &&
      Boolean(this.config.region) &&
      Boolean(this.config.marketplace);

    const state = ready ? 'CONFIGURED' : 'NOT_CONFIGURED';
    const out = {} as Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>;
    for (const capability of CAPABILITIES) out[capability] = state;
    return out;
  }

  async searchProducts(
    request: AdapterSearchRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AdapterSearchResult>> {
    const gate = this.gate<AdapterSearchResult>('search', ctx, 'searchProducts');
    if (gate) return gate;

    const payload: Record<string, unknown> = {
      Keywords: request.keywords,
      SearchIndex: 'All',
      ItemCount: Math.min(Math.max(request.pageSize, 1), 10),
      ItemPage: Math.min(Math.max(request.page, 1), 10),
      PartnerTag: this.config.partnerTag,
      PartnerType: 'Associates',
      Marketplace: this.config.marketplace,
      Resources: SEARCH_RESOURCES,
    };

    if (request.brand) payload.Brand = request.brand;
    // PA-API takes price filters in the marketplace currency's minor units.
    if (typeof request.priceMinMinor === 'number') payload.MinPrice = request.priceMinMinor;
    if (typeof request.priceMaxMinor === 'number') payload.MaxPrice = request.priceMaxMinor;
    if (request.minRating && request.minRating >= 4) payload.MinReviewsRating = 4;
    if (request.sort) {
      const sortBy = mapSort(request.sort);
      if (sortBy) payload.SortBy = sortBy;
    }

    const call = await this.call<PaapiSearchResponse>('SearchItems', '/paapi5/searchitems', payload, ctx);
    if (!call.ok) return call as AdapterOutcome<AdapterSearchResult>;

    const body = call.value;
    const errorOutcome = this.handlePaapiErrors<AdapterSearchResult>(body.Errors, call.meta, 'search');
    if (errorOutcome) return errorOutcome;

    const mapping = mappingContextFrom(ctx, PROVIDER_ID, { sourceRef: 'SearchItems' });
    const items = (body.SearchResult?.Items ?? [])
      .map((item) =>
        mapAmazonItem(item, mapping, {
          countryCode: ctx.countryCode,
          currency: currencyForMarketplace(this.config.marketplace, ctx.currency),
        }),
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return adapterOk(
      {
        items,
        totalAvailable: body.SearchResult?.TotalResultCount ?? null,
        page: request.page,
      },
      call.meta,
    );
  }

  async getProduct(
    request: AdapterProductRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<{ product: NormalizedProduct; offer: NormalizedOffer }>> {
    type Result = { product: NormalizedProduct; offer: NormalizedOffer };
    const gate = this.gate<Result>('productDetails', ctx, 'getProduct');
    if (gate) return gate;

    const payload = {
      ItemIds: [request.providerProductId],
      ItemIdType: 'ASIN',
      PartnerTag: this.config.partnerTag,
      PartnerType: 'Associates',
      Marketplace: this.config.marketplace,
      Resources: GET_ITEMS_RESOURCES,
    };

    const call = await this.call<PaapiGetItemsResponse>('GetItems', '/paapi5/getitems', payload, ctx);
    if (!call.ok) return call as AdapterOutcome<Result>;

    const errorOutcome = this.handlePaapiErrors<Result>(call.value.Errors, call.meta, 'product');
    if (errorOutcome) return errorOutcome;

    const item: PaapiItem | undefined = call.value.ItemsResult?.Items?.[0];
    if (!item) {
      return adapterFailed<Result>(
        {
          code: 'ERROR_INVALID_PRODUCT',
          retryable: false,
          internalNote: `ASIN ${request.providerProductId} returned no item`,
        },
        call.meta,
      );
    }

    const mapping = mappingContextFrom(ctx, PROVIDER_ID, { sourceRef: 'GetItems' });
    const mapped = mapAmazonItem(item, mapping, {
      countryCode: ctx.countryCode,
      currency: currencyForMarketplace(this.config.marketplace, ctx.currency),
    });

    if (!mapped) {
      return adapterFailed<Result>(
        {
          code: 'ERROR_PROVIDER_RESPONSE_INVALID',
          retryable: false,
          internalNote: 'Item lacked a title, ASIN or usable detail URL',
        },
        call.meta,
      );
    }

    return adapterOk<Result>(mapped, call.meta);
  }

  async getOffers(
    request: AdapterProductRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<ReadonlyArray<NormalizedOffer>>> {
    const product = await this.getProduct(request, ctx);
    if (!product.ok) return product as AdapterOutcome<ReadonlyArray<NormalizedOffer>>;
    return adapterOk([product.value.offer], product.meta);
  }

  /**
   * Promotion data exposure through this programme is not established for this
   * integration, so the capability is VERIFICATION_REQUIRED and this refuses
   * rather than returning an empty list. An empty list would read in the UI as
   * "no coupons exist", which is a different and unsupported claim.
   */
  async getCoupons(
    _request: AdapterCouponRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<ReadonlyArray<NormalizedCoupon>>> {
    const gate = this.gate<ReadonlyArray<NormalizedCoupon>>('coupons', ctx, 'getCoupons');
    if (gate) return gate;
    return adapterRefused(
      {
        code: 'ERROR_CAPABILITY_VERIFICATION_REQUIRED',
        capability: 'coupons',
        messageKey: 'capability.coupons.verificationRequired',
      },
      this.meta('getCoupons', 0, null, false),
    );
  }

  async buildAffiliateLink(
    request: AdapterLinkRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AffiliateLink>> {
    const gate = this.gate<AffiliateLink>('affiliateLinks', ctx, 'buildAffiliateLink');
    if (gate) return gate;

    // DetailPageURL already carries the partner tag when PartnerTag was sent
    // with the request, which is the programme's own link format. We ensure the
    // tag is present and otherwise leave the URL exactly as Amazon produced it.
    const link = buildAffiliateLinkFromUrl({
      providerId: PROVIDER_ID,
      destinationUrl: request.destinationUrl,
      placement: request.placement,
      trackingId: request.trackingId ?? this.config.partnerTag,
      campaignId: request.campaignId,
      guard: ctx.guard,
      locale: ctx.locale,
      requiredParams: { tag: request.trackingId ?? this.config.partnerTag },
    });

    return adapterOk(link, this.meta('buildAffiliateLink', 0, null, false));
  }

  /**
   * Extracts an ASIN from a pasted URL. Pure string work: we never fetch the
   * page, which would be both slower and outside what the programme permits.
   */
  recognizeUrl(url: string): UrlRecognition {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { recognized: false, reason: 'HOST_NOT_MINE' };
    }

    const host = parsed.hostname.toLowerCase();
    const isAmazonHost = /(^|\.)amazon\.[a-z.]{2,8}$/.test(host) || host === 'amzn.to';
    if (!isAmazonHost) return { recognized: false, reason: 'HOST_NOT_MINE' };

    // /dp/ASIN, /gp/product/ASIN, /gp/aw/d/ASIN, or an asin query parameter.
    const patterns = [
      /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
      /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
      /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?]|$)/i,
      /\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    ];
    for (const pattern of patterns) {
      const match = parsed.pathname.match(pattern);
      const asin = match?.[1]?.toUpperCase();
      if (asin) return { recognized: true, providerProductId: asin };
    }

    const queryAsin = parsed.searchParams.get('asin') ?? parsed.searchParams.get('ASIN');
    if (queryAsin && /^[A-Z0-9]{10}$/i.test(queryAsin)) {
      return { recognized: true, providerProductId: queryAsin.toUpperCase() };
    }

    return { recognized: false, reason: 'NO_PRODUCT_ID_IN_URL' };
  }

  validateContentUsage(
    usage: 'DISPLAY' | 'PERSIST' | 'MODEL_TRAINING' | 'EXPORT',
    kind: 'IMAGE' | 'TITLE' | 'DESCRIPTION' | 'REVIEW_TEXT' | 'RATING' | 'PRICE' | 'RAW_PAYLOAD',
    ctx: AdapterContext,
  ): { permitted: boolean; reasonKey: string | null } {
    if (kind === 'REVIEW_TEXT') {
      return { permitted: false, reasonKey: 'content.reviewText.notLicensed' };
    }
    if (usage === 'MODEL_TRAINING') {
      // Runtime processing and model training are different things, and this
      // programme's content is tagged as not usable for the latter.
      return { permitted: false, reasonKey: 'content.modelTraining.notPermitted' };
    }
    if (usage === 'PERSIST' && !ctx.guard.persistencePermitted()) {
      return { permitted: false, reasonKey: 'content.persistence.notPermitted' };
    }
    if (usage === 'EXPORT') {
      return { permitted: false, reasonKey: 'content.export.notPermitted' };
    }

    const capability: Capability =
      kind === 'IMAGE'
        ? 'productImages'
        : kind === 'PRICE'
          ? 'currentPrice'
          : kind === 'RATING'
            ? 'ratings'
            : 'productContent';

    const verdict = ctx.guard.check(capability);
    return {
      permitted: verdict.allowed,
      reasonKey: verdict.allowed ? null : `capability.${capability}.${verdict.state}`,
    };
  }

  getDisclosure(locale: string, ctx: AdapterContext): string | null {
    return ctx.guard.disclosure(locale);
  }

  // --- Internals ----------------------------------------------------------

  /**
   * Single place where permission, configuration and circuit state are
   * checked. Returns a refusal outcome when the call must not happen, or null
   * to proceed.
   */
  private gate<T>(
    capability: Capability,
    ctx: AdapterContext,
    operation: string,
  ): AdapterOutcome<T> | null {
    const verdict = ctx.guard.check(capability);
    if (!verdict.allowed) {
      return adapterRefused<T>(
        {
          code:
            verdict.state === 'VERIFICATION_REQUIRED'
              ? 'ERROR_CAPABILITY_VERIFICATION_REQUIRED'
              : verdict.state === 'NOT_CONFIGURED'
                ? 'ERROR_SOURCE_NOT_CONFIGURED'
                : verdict.state === 'DISABLED_BY_OPERATOR'
                  ? 'ERROR_SOURCE_DISABLED'
                  : 'ERROR_CAPABILITY_UNAVAILABLE',
          capability,
          messageKey: `capability.${capability}.${verdict.state}`,
        },
        this.meta(operation, 0, null, false),
      );
    }

    if (this.configuredCapabilities()[capability] === 'NOT_CONFIGURED') {
      return adapterRefused<T>(
        {
          code: 'ERROR_SOURCE_NOT_CONFIGURED',
          capability,
          messageKey: 'provider.notConfigured',
        },
        this.meta(operation, 0, null, false),
      );
    }

    if (!this.resilience.breaker.allowRequest()) {
      ctx.log.warn('Circuit open, skipping provider call', { operation });
      return adapterFailed<T>(
        {
          code: 'ERROR_SOURCE_UNAVAILABLE',
          retryable: true,
          internalNote: `Circuit open after ${this.resilience.breaker.failureCount} failures`,
        },
        this.meta(operation, 0, null, false),
      );
    }

    return null;
  }

  private async call<T>(
    operation: string,
    path: string,
    payload: Record<string, unknown>,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<T>> {
    const admitted = await this.resilience.bucket.acquire(
      this.timeouts.rateLimitWaitMs,
      ctx.signal,
    );
    if (!admitted) {
      // Better to tell the user this source did not answer than to make every
      // other source wait behind a quota we cannot exceed.
      return adapterFailed<T>(
        {
          code: 'ERROR_PROVIDER_RATE_LIMIT',
          retryable: true,
          internalNote: 'Local quota exhausted; skipped rather than queued',
        },
        this.meta(operation, 0, null, true),
      );
    }

    const body = JSON.stringify(payload);
    const signed = signPaapiRequest({
      accessKey: this.config.accessKey,
      secretKey: this.config.secretKey,
      region: this.config.region,
      host: this.config.host,
      path,
      target: `${TARGET_PREFIX}.${operation}`,
      payload: body,
      now: this.clock(),
    });

    const startedAt = Date.now();
    try {
      const response = await httpRequest({
        method: 'POST',
        url: signed.url,
        headers: signed.headers,
        body,
        timeoutMs: this.timeouts.requestTimeoutMs,
        signal: ctx.signal,
        // PA-API operations are reads, but the quota is tight enough that a
        // blind retry can cost more than it saves. One retry only.
        maxAttempts: 2,
      });

      this.resilience.breaker.recordSuccess();
      const parsed = parseJson<T>(response.body, `${operation} response`);
      return adapterOk(parsed, this.meta(operation, response.durationMs, response.status, false));
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof HttpError) {
        // A rejected signature or a bad partner tag is our configuration
        // problem, not the source being down; it must not trip the breaker and
        // disable a provider that is actually healthy.
        if (error.failure.code !== 'ERROR_PROVIDER_AUTH_REJECTED') {
          this.resilience.breaker.recordFailure();
        }
        ctx.log.warn('Amazon call failed', {
          operation,
          code: error.failure.code,
          note: error.failure.internalNote,
        });
        return adapterFailed<T>(
          error.failure,
          this.meta(
            operation,
            durationMs,
            error.status,
            error.failure.code === 'ERROR_PROVIDER_RATE_LIMIT',
          ),
        );
      }

      this.resilience.breaker.recordFailure();
      return adapterFailed<T>(
        {
          code: 'ERROR_SOURCE_UNAVAILABLE',
          retryable: true,
          internalNote: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        this.meta(operation, durationMs, null, false),
      );
    }
  }

  /**
   * PA-API reports application errors in a 200 body. `NoResults` is a valid
   * empty answer, not a failure — treating it as one would open the circuit on
   * an obscure search term.
   */
  private handlePaapiErrors<T>(
    errors: ReadonlyArray<{ Code?: string; Message?: string }> | undefined,
    meta: ReturnType<AmazonAdapter['meta']>,
    _context: string,
  ): AdapterOutcome<T> | null {
    if (!errors || errors.length === 0) return null;

    const first = errors[0];
    const classified = classifyPaapiError(first?.Code);

    switch (classified.kind) {
      case 'NO_RESULTS':
        return null;
      case 'RATE_LIMIT':
        this.resilience.breaker.recordFailure();
        return adapterFailed<T>(
          {
            code: 'ERROR_PROVIDER_RATE_LIMIT',
            retryable: true,
            internalNote: `${first?.Code}: ${first?.Message ?? ''}`,
          },
          { ...meta, rateLimited: true },
        );
      case 'AUTH':
        return adapterFailed<T>(
          {
            code: 'ERROR_PROVIDER_AUTH_REJECTED',
            retryable: false,
            internalNote: `${first?.Code}: ${first?.Message ?? ''}`,
          },
          meta,
        );
      case 'INVALID_REQUEST':
        return adapterFailed<T>(
          {
            code: 'ERROR_PROVIDER_RESPONSE_INVALID',
            retryable: false,
            internalNote: `${first?.Code}: ${first?.Message ?? ''}`,
          },
          meta,
        );
      default:
        return adapterFailed<T>(
          {
            code: 'ERROR_SOURCE_UNAVAILABLE',
            retryable: true,
            internalNote: `${first?.Code ?? 'UnknownError'}: ${first?.Message ?? ''}`,
          },
          meta,
        );
    }
  }

  private meta(
    operation: string,
    durationMs: number,
    httpStatus: number | null,
    rateLimited: boolean,
  ) {
    return {
      providerId: PROVIDER_ID,
      operation,
      durationMs,
      httpStatus,
      rateLimited,
      demoFixture: false,
    };
  }
}

function mapSort(sort: NonNullable<AdapterSearchRequest['sort']>): string | null {
  switch (sort) {
    case 'PRICE_ASC':
      return 'Price:LowToHigh';
    case 'PRICE_DESC':
      return 'Price:HighToLow';
    case 'RATING_DESC':
      return 'AvgCustomerReviews';
    case 'NEWEST':
      return 'NewestArrivals';
    case 'RELEVANCE':
      return 'Relevance';
    default:
      return null;
  }
}

/**
 * PA-API prices arrive in the marketplace's own currency regardless of what
 * the user asked for. We record the marketplace currency and let the pricing
 * engine convert with a dated rate, rather than relabelling the number.
 */
function currencyForMarketplace(marketplace: string, fallback: string): string {
  const map: Record<string, string> = {
    'www.amazon.com': 'USD',
    'www.amazon.co.uk': 'GBP',
    'www.amazon.de': 'EUR',
    'www.amazon.fr': 'EUR',
    'www.amazon.it': 'EUR',
    'www.amazon.es': 'EUR',
    'www.amazon.nl': 'EUR',
    'www.amazon.ca': 'CAD',
    'www.amazon.com.au': 'AUD',
    'www.amazon.co.jp': 'JPY',
  };
  return map[marketplace] ?? fallback;
}
