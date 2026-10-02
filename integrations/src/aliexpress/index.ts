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
import type { AliExpressConfig } from '../common/config.js';
import { HttpError, httpRequest, parseJson } from '../common/http.js';
import { mappingContextFrom } from '../common/mapping.js';
import { untrackedLink, wrapProviderGeneratedLink } from '../common/links.js';
import { resilienceFor } from '../common/resilience.js';
import { mapAliExpressProduct } from './mapper.js';
import { buildTopRequestBody } from './signer.js';
import {
  type AliExpressErrorResponse,
  type AliExpressLinkResult,
  type AliExpressProduct,
  type AliExpressProductQueryResult,
  METHOD_HOT_PRODUCT_QUERY,
  METHOD_LINK_GENERATE,
  METHOD_PRODUCT_DETAIL,
  METHOD_PRODUCT_QUERY,
  classifyAliExpressError,
  responseKeyFor,
  unwrapEnvelope,
  unwrapList,
} from './types.js';

const PROVIDER_ID = 'aliexpress';

/**
 * AliExpress adapter — Open Platform affiliate APIs.
 *
 * The notable constraint here is link generation. This programme requires
 * tracking links to be produced by its own `link.generate` endpoint; appending
 * a tracking parameter to a product URL by hand produces a link that looks
 * plausible and is not attributed. So `buildAffiliateLink` makes a network
 * call, and when that call fails it returns an explicitly untracked link
 * rather than a hand-assembled one. Losing a commission is recoverable;
 * shipping thousands of malformed links is not.
 */
export class AliExpressAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;

  private readonly resilience;

  constructor(
    private readonly config: AliExpressConfig,
    private readonly timeouts: {
      readonly requestTimeoutMs: number;
      readonly rateLimitWaitMs: number;
    },
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
      Boolean(this.config.appKey) &&
      Boolean(this.config.appSecret) &&
      Boolean(this.config.gateway);

    const out = {} as Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>;
    for (const capability of CAPABILITIES) {
      out[capability] = ready ? 'CONFIGURED' : 'NOT_CONFIGURED';
    }
    // Link generation additionally needs a tracking id; without it the
    // programme cannot attribute the click, so the capability is not
    // configured even though the rest of the integration is.
    if (ready && !this.config.trackingId) out.affiliateLinks = 'NOT_CONFIGURED';
    return out;
  }

  async searchProducts(
    request: AdapterSearchRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AdapterSearchResult>> {
    const gate = this.gate<AdapterSearchResult>('search', ctx, 'searchProducts');
    if (gate) return gate;

    const business: Record<string, string | number | undefined> = {
      keywords: request.keywords,
      page_no: Math.max(request.page, 1),
      page_size: Math.min(Math.max(request.pageSize, 1), 50),
      target_currency: ctx.currency.toUpperCase(),
      target_language: ctx.locale === 'he' ? 'EN' : ctx.locale.toUpperCase(),
      ship_to_country: ctx.countryCode.toUpperCase(),
      tracking_id: this.config.trackingId || undefined,
      fields:
        'product_id,product_title,product_main_image_url,product_small_image_urls,product_detail_url,' +
        'target_sale_price,target_sale_price_currency,target_original_price,target_original_price_currency,' +
        'evaluate_rate,lastest_volume,first_level_category_name,second_level_category_name,shop_name,ship_to_days,sku_id',
    };

    if (request.sort) business.sort = mapSort(request.sort);
    // The gateway's price filters are in whole units of the target currency.
    if (typeof request.priceMinMinor === 'number') {
      business.min_sale_price = Math.floor(request.priceMinMinor / 100);
    }
    if (typeof request.priceMaxMinor === 'number') {
      business.max_sale_price = Math.ceil(request.priceMaxMinor / 100);
    }
    if (request.categoryPath && request.categoryPath.length > 0) {
      business.keywords = `${request.keywords} ${request.categoryPath.at(-1)}`.trim();
    }

    const call = await this.call<AliExpressProductQueryResult>(
      METHOD_PRODUCT_QUERY,
      business,
      ctx,
    );
    if (!call.ok) return call as AdapterOutcome<AdapterSearchResult>;

    const mapping = mappingContextFrom(ctx, PROVIDER_ID, { sourceRef: METHOD_PRODUCT_QUERY });
    const products = unwrapList<AliExpressProduct>(call.value.products, 'product');
    const items = products
      .map((raw) =>
        mapAliExpressProduct(raw, mapping, {
          countryCode: ctx.countryCode,
          currency: ctx.currency,
        }),
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return adapterOk(
      {
        items,
        totalAvailable: call.value.total_record_count ?? null,
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

    const call = await this.call<AliExpressProductQueryResult>(
      METHOD_PRODUCT_DETAIL,
      {
        product_ids: request.providerProductId,
        target_currency: ctx.currency.toUpperCase(),
        target_language: ctx.locale === 'he' ? 'EN' : ctx.locale.toUpperCase(),
        ship_to_country: ctx.countryCode.toUpperCase(),
        tracking_id: this.config.trackingId || undefined,
      },
      ctx,
    );
    if (!call.ok) return call as AdapterOutcome<Result>;

    const products = unwrapList<AliExpressProduct>(call.value.products, 'product');
    const first = products[0];
    if (!first) {
      return adapterFailed<Result>(
        {
          code: 'ERROR_INVALID_PRODUCT',
          retryable: false,
          internalNote: `Product ${request.providerProductId} returned no detail`,
        },
        call.meta,
      );
    }

    const mapping = mappingContextFrom(ctx, PROVIDER_ID, { sourceRef: METHOD_PRODUCT_DETAIL });
    const mapped = mapAliExpressProduct(first, mapping, {
      countryCode: ctx.countryCode,
      currency: ctx.currency,
    });
    if (!mapped) {
      return adapterFailed<Result>(
        {
          code: 'ERROR_PROVIDER_RESPONSE_INVALID',
          retryable: false,
          internalNote: 'Product lacked an id, title or usable detail URL',
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
   * Coupon surfaces vary by affiliate account and market, so the capability
   * ships as VERIFICATION_REQUIRED and this refuses. Returning `[]` would read
   * as "this product has no coupons", which we have no basis to assert.
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

  /** Hot-product discovery, used by the Deal Hunter where permitted. */
  async getDeals(
    request: { readonly categoryPath?: ReadonlyArray<string>; readonly limit: number },
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AdapterSearchResult>> {
    const gate = this.gate<AdapterSearchResult>('deals', ctx, 'getDeals');
    if (gate) return gate;

    const call = await this.call<AliExpressProductQueryResult>(
      METHOD_HOT_PRODUCT_QUERY,
      {
        page_no: 1,
        page_size: Math.min(Math.max(request.limit, 1), 50),
        target_currency: ctx.currency.toUpperCase(),
        target_language: ctx.locale === 'he' ? 'EN' : ctx.locale.toUpperCase(),
        ship_to_country: ctx.countryCode.toUpperCase(),
        tracking_id: this.config.trackingId || undefined,
        ...(request.categoryPath?.length ? { keywords: request.categoryPath.at(-1) } : {}),
      },
      ctx,
    );
    if (!call.ok) return call as AdapterOutcome<AdapterSearchResult>;

    const mapping = mappingContextFrom(ctx, PROVIDER_ID, { sourceRef: METHOD_HOT_PRODUCT_QUERY });
    const items = unwrapList<AliExpressProduct>(call.value.products, 'product')
      .map((raw) =>
        mapAliExpressProduct(raw, mapping, {
          countryCode: ctx.countryCode,
          currency: ctx.currency,
        }),
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return adapterOk({ items, totalAvailable: call.value.total_record_count ?? null, page: 1 }, call.meta);
  }

  async buildAffiliateLink(
    request: AdapterLinkRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AffiliateLink>> {
    const gate = this.gate<AffiliateLink>('affiliateLinks', ctx, 'buildAffiliateLink');
    if (gate) return gate;

    const trackingId = request.trackingId ?? this.config.trackingId;
    if (!trackingId) {
      return adapterOk(
        untrackedLink({
          providerId: PROVIDER_ID,
          destinationUrl: request.destinationUrl,
          placement: request.placement,
          guard: ctx.guard,
          locale: ctx.locale,
          status: 'NOT_CONFIGURED',
        }),
        this.meta('buildAffiliateLink', 0, null, false),
      );
    }

    const call = await this.call<AliExpressLinkResult>(
      METHOD_LINK_GENERATE,
      {
        promotion_link_type: '0',
        source_values: request.destinationUrl,
        tracking_id: trackingId,
      },
      ctx,
    );

    if (!call.ok) {
      // The programme's generator is the only permitted way to make a tracked
      // link, so a failure means we hand back an honest untracked one.
      ctx.log.warn('Link generation failed; serving untracked destination', {
        productId: request.providerProductId,
      });
      return adapterOk(
        untrackedLink({
          providerId: PROVIDER_ID,
          destinationUrl: request.destinationUrl,
          placement: request.placement,
          guard: ctx.guard,
          locale: ctx.locale,
          status: 'PROVIDER_REFUSED',
        }),
        this.meta('buildAffiliateLink', call.meta.durationMs, call.meta.httpStatus, false),
      );
    }

    const links = unwrapList<{ source_value?: string; promotion_link?: string }>(
      call.value.promotion_links,
      'promotion_link',
    );
    const generated = links[0]?.promotion_link;

    if (!generated) {
      return adapterOk(
        untrackedLink({
          providerId: PROVIDER_ID,
          destinationUrl: request.destinationUrl,
          placement: request.placement,
          guard: ctx.guard,
          locale: ctx.locale,
          status: 'PROVIDER_REFUSED',
        }),
        call.meta,
      );
    }

    return adapterOk(
      wrapProviderGeneratedLink({
        providerId: PROVIDER_ID,
        destinationUrl: request.destinationUrl,
        generatedUrl: generated,
        placement: request.placement,
        trackingId,
        campaignId: request.campaignId,
        guard: ctx.guard,
        locale: ctx.locale,
      }),
      call.meta,
    );
  }

  recognizeUrl(url: string): UrlRecognition {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { recognized: false, reason: 'HOST_NOT_MINE' };
    }

    const host = parsed.hostname.toLowerCase();
    if (!/(^|\.)aliexpress\.(com|ru|us)$/.test(host)) {
      return { recognized: false, reason: 'HOST_NOT_MINE' };
    }

    // /item/1005001234567890.html, or /i/1005001234567890.html
    const match = parsed.pathname.match(/\/(?:item|i)\/(\d{6,20})\.html/);
    const productId = match?.[1];
    if (productId) {
      const sku = parsed.searchParams.get('sku_id') ?? undefined;
      return sku
        ? { recognized: true, providerProductId: productId, variantId: sku }
        : { recognized: true, providerProductId: productId };
    }

    const queryId = parsed.searchParams.get('productId') ?? parsed.searchParams.get('product_id');
    if (queryId && /^\d{6,20}$/.test(queryId)) {
      return { recognized: true, providerProductId: queryId };
    }

    return { recognized: false, reason: 'NO_PRODUCT_ID_IN_URL' };
  }

  validateContentUsage(
    usage: 'DISPLAY' | 'PERSIST' | 'MODEL_TRAINING' | 'EXPORT',
    kind: 'IMAGE' | 'TITLE' | 'DESCRIPTION' | 'REVIEW_TEXT' | 'RATING' | 'PRICE' | 'RAW_PAYLOAD',
    ctx: AdapterContext,
  ): { permitted: boolean; reasonKey: string | null } {
    if (usage === 'MODEL_TRAINING') {
      return { permitted: false, reasonKey: 'content.modelTraining.notPermitted' };
    }
    if (usage === 'EXPORT') {
      return { permitted: false, reasonKey: 'content.export.notPermitted' };
    }
    if (usage === 'PERSIST' && !ctx.guard.persistencePermitted()) {
      return { permitted: false, reasonKey: 'content.persistence.notPermitted' };
    }

    const capability: Capability =
      kind === 'IMAGE'
        ? 'productImages'
        : kind === 'PRICE'
          ? 'currentPrice'
          : kind === 'RATING'
            ? 'ratings'
            : kind === 'REVIEW_TEXT'
              ? 'reviewContent'
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
        { code: 'ERROR_SOURCE_NOT_CONFIGURED', capability, messageKey: 'provider.notConfigured' },
        this.meta(operation, 0, null, false),
      );
    }

    if (!this.resilience.breaker.allowRequest()) {
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
    method: string,
    business: Record<string, string | number | boolean | undefined | null>,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<T>> {
    const admitted = await this.resilience.bucket.acquire(this.timeouts.rateLimitWaitMs, ctx.signal);
    if (!admitted) {
      return adapterFailed<T>(
        {
          code: 'ERROR_PROVIDER_RATE_LIMIT',
          retryable: true,
          internalNote: 'Local quota exhausted; skipped rather than queued',
        },
        this.meta(method, 0, null, true),
      );
    }

    const body = buildTopRequestBody({
      method,
      appKey: this.config.appKey,
      appSecret: this.config.appSecret,
      businessParams: business,
      now: this.clock(),
    });

    const startedAt = Date.now();
    try {
      const response = await httpRequest({
        method: 'POST',
        url: this.config.gateway,
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body,
        timeoutMs: this.timeouts.requestTimeoutMs,
        signal: ctx.signal,
        maxAttempts: 3,
      });

      const parsed = parseJson<Record<string, unknown> & AliExpressErrorResponse>(
        response.body,
        `${method} response`,
      );

      // The gateway reports errors with HTTP 200 and an error_response body.
      if (parsed.error_response) {
        const classified = classifyAliExpressError(
          parsed.error_response.code,
          parsed.error_response.sub_code,
        );
        const note = `${parsed.error_response.code ?? ''}/${parsed.error_response.sub_code ?? ''}: ${
          parsed.error_response.sub_msg ?? parsed.error_response.msg ?? ''
        }`;

        if (classified.kind === 'AUTH') {
          // Configuration fault, not an outage: must not trip the breaker.
          return adapterFailed<T>(
            { code: 'ERROR_PROVIDER_AUTH_REJECTED', retryable: false, internalNote: note },
            this.meta(method, response.durationMs, response.status, false),
          );
        }

        this.resilience.breaker.recordFailure();
        return adapterFailed<T>(
          {
            code:
              classified.kind === 'RATE_LIMIT'
                ? 'ERROR_PROVIDER_RATE_LIMIT'
                : classified.kind === 'INVALID_REQUEST'
                  ? 'ERROR_PROVIDER_RESPONSE_INVALID'
                  : 'ERROR_SOURCE_UNAVAILABLE',
            retryable: classified.kind !== 'INVALID_REQUEST',
            internalNote: note,
          },
          this.meta(
            method,
            response.durationMs,
            response.status,
            classified.kind === 'RATE_LIMIT',
          ),
        );
      }

      const envelope = unwrapEnvelope<T>(parsed, responseKeyFor(method));
      if (!envelope || envelope.result === undefined) {
        // An envelope we cannot read is a response-shape change. Surfacing it
        // as invalid gets it into the admin log instead of silently returning
        // zero results, which would look like "this source has nothing".
        this.resilience.breaker.recordFailure();
        return adapterFailed<T>(
          {
            code: 'ERROR_PROVIDER_RESPONSE_INVALID',
            retryable: false,
            internalNote: `Unrecognized envelope for ${method}`,
          },
          this.meta(method, response.durationMs, response.status, false),
        );
      }

      this.resilience.breaker.recordSuccess();
      return adapterOk(
        envelope.result,
        this.meta(method, response.durationMs, response.status, false),
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof HttpError) {
        if (error.failure.code !== 'ERROR_PROVIDER_AUTH_REJECTED') {
          this.resilience.breaker.recordFailure();
        }
        return adapterFailed<T>(
          error.failure,
          this.meta(
            method,
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
        this.meta(method, durationMs, null, false),
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

function mapSort(sort: NonNullable<AdapterSearchRequest['sort']>): string {
  switch (sort) {
    case 'PRICE_ASC':
      return 'SALE_PRICE_ASC';
    case 'PRICE_DESC':
      return 'SALE_PRICE_DESC';
    case 'NEWEST':
      return 'LAST_VOLUME_DESC';
    default:
      return 'SALE_PRICE_ASC';
  }
}
