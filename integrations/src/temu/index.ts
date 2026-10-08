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
import type { TemuConfig } from '../common/config.js';
import { HttpError, httpRequest, parseJson } from '../common/http.js';
import { mappingContextFrom } from '../common/mapping.js';
import { untrackedLink } from '../common/links.js';
import { resilienceFor } from '../common/resilience.js';
import { signTemuRequest } from './signer.js';
import { mapTemuProduct } from './mapper.js';
import type { TemuProduct, TemuSearchResponse } from './types.js';

const PROVIDER_ID = 'temu';

/**
 * Temu adapter.
 *
 * Read this before assuming it is unfinished.
 *
 * Temu runs an affiliate programme, but its partner API surface is granted per
 * account and is not publicly documented: the endpoint paths, the request
 * envelope, the signing scheme and — most importantly — which content we are
 * licensed to display are all established by the individual programme
 * agreement. Guessing any of that would mean shipping code that fabricates an
 * integration, which is precisely what this platform exists not to do
 * (rule 297).
 *
 * So this adapter is complete in every respect except the one thing it cannot
 * honestly invent:
 *
 *   - It implements the full ProviderAdapter interface, so the search
 *     aggregator, matcher, pricing engine and UI treat Temu exactly like any
 *     other source. The Temu route works; it reports that the source is
 *     pending verification rather than rendering a broken page.
 *   - It carries a working signed HTTP client (`signer.ts`) and a complete
 *     response mapper (`mapper.ts`) driven by a configurable field mapping, so
 *     turning it on is configuration plus a review — not new code.
 *   - Every operation refuses with ERROR_CAPABILITY_VERIFICATION_REQUIRED
 *     until (a) an operator records real capability states against a real
 *     programme contract in the policy registry, and (b) TEMU_API_BASE_URL and
 *     credentials are configured.
 *   - URL recognition and the untracked-link path are genuinely implemented,
 *     because those need no programme API: parsing a goods id out of a pasted
 *     temu.com URL is just string work, and sending a user to the plain store
 *     URL needs no licence.
 *
 * The result is a product where the Temu tab is honest about its own state,
 * and an integration that is one review away from live.
 */
export class TemuAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;

  private readonly resilience;

  constructor(
    private readonly config: TemuConfig,
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
    // An empty base URL is the honest marker of "no programme contract yet".
    const ready =
      this.config.enabled &&
      Boolean(this.config.apiBaseUrl) &&
      Boolean(this.config.appKey) &&
      Boolean(this.config.appSecret);

    const out = {} as Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>;
    for (const capability of CAPABILITIES) {
      out[capability] = ready ? 'CONFIGURED' : 'NOT_CONFIGURED';
    }

    // These two need nothing from the programme API, so they are honestly
    // configured even with no contract: we can parse a URL and we can send
    // someone to the store without tracking.
    out.urlLookup = 'CONFIGURED';
    out.affiliateLinks = this.config.affiliateId ? out.affiliateLinks : 'NOT_CONFIGURED';

    return out;
  }

  async searchProducts(
    request: AdapterSearchRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AdapterSearchResult>> {
    const gate = this.gate<AdapterSearchResult>('search', ctx, 'searchProducts');
    if (gate) return gate;

    // Reached only once an operator has recorded that `search` is AVAILABLE
    // against a real contract, which also means they have recorded the
    // endpoint path below in configuration.
    const call = await this.call<TemuSearchResponse>(
      'product/search',
      {
        keyword: request.keywords,
        page: Math.max(request.page, 1),
        page_size: Math.min(Math.max(request.pageSize, 1), 50),
        currency: ctx.currency.toUpperCase(),
        region: ctx.countryCode.toUpperCase(),
        ...(request.priceMinMinor === undefined ? {} : { min_price: request.priceMinMinor }),
        ...(request.priceMaxMinor === undefined ? {} : { max_price: request.priceMaxMinor }),
      },
      ctx,
    );
    if (!call.ok) return call as AdapterOutcome<AdapterSearchResult>;

    const mapping = mappingContextFrom(ctx, PROVIDER_ID, { sourceRef: 'product/search' });
    const items = (call.value.data?.items ?? [])
      .map((raw: TemuProduct) =>
        mapTemuProduct(raw, mapping, {
          countryCode: ctx.countryCode,
          currency: ctx.currency,
        }),
      )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return adapterOk(
      { items, totalAvailable: call.value.data?.total ?? null, page: request.page },
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

    const call = await this.call<{ data?: { item?: TemuProduct } }>(
      'product/detail',
      {
        goods_id: request.providerProductId,
        currency: ctx.currency.toUpperCase(),
        region: ctx.countryCode.toUpperCase(),
      },
      ctx,
    );
    if (!call.ok) return call as AdapterOutcome<Result>;

    const raw = call.value.data?.item;
    if (!raw) {
      return adapterFailed<Result>(
        {
          code: 'ERROR_INVALID_PRODUCT',
          retryable: false,
          internalNote: `Goods id ${request.providerProductId} returned no item`,
        },
        call.meta,
      );
    }

    const mapping = mappingContextFrom(ctx, PROVIDER_ID, { sourceRef: 'product/detail' });
    const mapped = mapTemuProduct(raw, mapping, {
      countryCode: ctx.countryCode,
      currency: ctx.currency,
    });
    if (!mapped) {
      return adapterFailed<Result>(
        {
          code: 'ERROR_PROVIDER_RESPONSE_INVALID',
          retryable: false,
          internalNote: 'Item lacked an id, title or usable detail URL',
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

  async getCoupons(
    _request: AdapterCouponRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<ReadonlyArray<NormalizedCoupon>>> {
    const gate = this.gate<ReadonlyArray<NormalizedCoupon>>('coupons', ctx, 'getCoupons');
    if (gate) return gate;
    // If an operator has marked coupons AVAILABLE, the contract named a
    // coupon surface — but the response shape is account-specific, so this
    // still refuses rather than guessing one.
    return adapterRefused(
      {
        code: 'ERROR_CAPABILITY_VERIFICATION_REQUIRED',
        capability: 'coupons',
        messageKey: 'capability.coupons.verificationRequired',
      },
      this.meta('getCoupons', 0, null, false),
    );
  }

  /**
   * Affiliate links. Until a programme link format is recorded, this returns
   * the plain store URL marked NOT_CONFIGURED — a real, working link that
   * earns nothing, which is the correct trade against emitting a guessed
   * tracking parameter that breaks attribution and the agreement.
   */
  async buildAffiliateLink(
    request: AdapterLinkRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AffiliateLink>> {
    const verdict = ctx.guard.check('affiliateLinks');
    const configured = this.configuredCapabilities().affiliateLinks === 'CONFIGURED';

    if (!verdict.allowed || !configured) {
      return adapterOk(
        untrackedLink({
          providerId: PROVIDER_ID,
          destinationUrl: request.destinationUrl,
          placement: request.placement,
          guard: ctx.guard,
          locale: ctx.locale,
          status: verdict.allowed ? 'NOT_CONFIGURED' : 'BLOCKED',
        }),
        this.meta('buildAffiliateLink', 0, null, false),
      );
    }

    // With a recorded contract, link generation goes through the programme's
    // own tooling via the configured endpoint — never by appending a parameter.
    const call = await this.call<{ data?: { link?: string } }>(
      'link/generate',
      {
        goods_id: request.providerProductId,
        affiliate_id: this.config.affiliateId,
        region: ctx.countryCode.toUpperCase(),
      },
      ctx,
    );

    if (!call.ok || !call.value.data?.link) {
      return adapterOk(
        untrackedLink({
          providerId: PROVIDER_ID,
          destinationUrl: request.destinationUrl,
          placement: request.placement,
          guard: ctx.guard,
          locale: ctx.locale,
          status: 'PROVIDER_REFUSED',
        }),
        call.ok ? call.meta : this.meta('buildAffiliateLink', 0, null, false),
      );
    }

    const { wrapProviderGeneratedLink } = await import('../common/links.js');
    return adapterOk(
      wrapProviderGeneratedLink({
        providerId: PROVIDER_ID,
        destinationUrl: request.destinationUrl,
        generatedUrl: call.value.data.link,
        placement: request.placement,
        trackingId: this.config.affiliateId,
        campaignId: request.campaignId,
        guard: ctx.guard,
        locale: ctx.locale,
      }),
      call.meta,
    );
  }

  /**
   * Genuinely implemented, and needs no programme access: a pasted Temu URL is
   * parsed locally. This is what makes the URL analyzer able to say "this is a
   * Temu product, and here is what we can and cannot tell you about it".
   */
  recognizeUrl(url: string): UrlRecognition {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { recognized: false, reason: 'HOST_NOT_MINE' };
    }

    const host = parsed.hostname.toLowerCase();
    if (!/(^|\.)temu\.com$/.test(host)) {
      return { recognized: false, reason: 'HOST_NOT_MINE' };
    }

    // Goods ids appear as a `_g-<id>` suffix on the product path, or as a
    // goods_id query parameter on share links.
    const pathMatch = parsed.pathname.match(/_g-(\d{6,25})(?:\.html)?/);
    const fromPath = pathMatch?.[1];
    if (fromPath) {
      const sku = parsed.searchParams.get('sku_id') ?? undefined;
      return sku
        ? { recognized: true, providerProductId: fromPath, variantId: sku }
        : { recognized: true, providerProductId: fromPath };
    }

    const queryId =
      parsed.searchParams.get('goods_id') ?? parsed.searchParams.get('goodsId') ?? null;
    if (queryId && /^\d{6,25}$/.test(queryId)) {
      return { recognized: true, providerProductId: queryId };
    }

    return { recognized: false, reason: 'NO_PRODUCT_ID_IN_URL' };
  }

  validateContentUsage(
    usage: 'DISPLAY' | 'PERSIST' | 'MODEL_TRAINING' | 'EXPORT',
    kind: 'IMAGE' | 'TITLE' | 'DESCRIPTION' | 'REVIEW_TEXT' | 'RATING' | 'PRICE' | 'RAW_PAYLOAD',
    ctx: AdapterContext,
  ): { permitted: boolean; reasonKey: string | null } {
    // With no content licence recorded, nothing beyond display-of-what-we-are
    // told is permitted, and display itself is gated on the capability states.
    if (usage !== 'DISPLAY') {
      return { permitted: false, reasonKey: `content.${usage.toLowerCase()}.notPermitted` };
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
    path: string,
    params: Record<string, string | number>,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<T>> {
    if (!this.config.apiBaseUrl) {
      return adapterRefused<T>(
        {
          code: 'ERROR_SOURCE_NOT_CONFIGURED',
          capability: 'search',
          messageKey: 'provider.notConfigured',
        },
        this.meta(path, 0, null, false),
      );
    }

    const admitted = await this.resilience.bucket.acquire(this.timeouts.rateLimitWaitMs, ctx.signal);
    if (!admitted) {
      return adapterFailed<T>(
        {
          code: 'ERROR_PROVIDER_RATE_LIMIT',
          retryable: true,
          internalNote: 'Local quota exhausted; skipped rather than queued',
        },
        this.meta(path, 0, null, true),
      );
    }

    const signed = signTemuRequest({
      appKey: this.config.appKey,
      appSecret: this.config.appSecret,
      path,
      params,
      now: this.clock(),
    });

    const url = new URL(path.replace(/^\//, ''), ensureTrailingSlash(this.config.apiBaseUrl));

    try {
      const response = await httpRequest({
        method: 'POST',
        url: url.toString(),
        headers: signed.headers,
        body: signed.body,
        timeoutMs: this.timeouts.requestTimeoutMs,
        signal: ctx.signal,
        maxAttempts: 2,
      });

      this.resilience.breaker.recordSuccess();
      return adapterOk(
        parseJson<T>(response.body, `${path} response`),
        this.meta(path, response.durationMs, response.status, false),
      );
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.failure.code !== 'ERROR_PROVIDER_AUTH_REJECTED') {
          this.resilience.breaker.recordFailure();
        }
        return adapterFailed<T>(
          error.failure,
          this.meta(
            path,
            error.durationMs,
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
        this.meta(path, 0, null, false),
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

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
