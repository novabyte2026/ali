import {
  type AffiliateLink,
  type Capability,
  type NormalizedCoupon,
  type NormalizedOffer,
  type NormalizedProduct,
  type ProductIdentifiers,
  CAPABILITIES,
  cleanTitle,
  moneyFromDecimal,
  normalizeColour,
  normalizeCapacity,
  tokenSimilarity,
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
} from '../common/adapter.js';
import { mappingContextFrom } from '../common/mapping.js';
import { untrackedLink } from '../common/links.js';
import { buildTotalCost } from '../common/totals.js';
import { DEMO_CATALOG, type DemoListing } from './catalog.js';

/**
 * Development fixture adapter.
 *
 * This exists so the interface can be built and reviewed without live
 * programme credentials. Everything it returns is tagged
 * `dataOrigin: 'DEMO_FIXTURE'`, which propagates through the Datum provenance
 * into every API response, raises a `containsDemoData` flag on the search
 * summary, and makes the frontend render a persistent banner saying the data
 * is sample data.
 *
 * Three safeguards stop it reaching production:
 *   1. It is only constructed when ALLOW_DEMO_FIXTURES is true.
 *   2. The backend refuses to boot if that flag is true while NODE_ENV is
 *      production (see backend/src/config/index.ts).
 *   3. Nothing it returns is ever written to the catalog or observation
 *      tables, because its provenance fails the persistence check.
 *
 * It also deliberately does *not* fabricate the things the real adapters
 * cannot provide: shipping stays unknown for the Amazon-shaped fixtures,
 * ratings stay restricted where the capability is, and no coupon is ever
 * returned as VERIFIED. A demo that looks better than production would hide
 * exactly the gaps this architecture is designed to surface.
 */
export class DemoFixtureAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: string,
    private readonly listings: ReadonlyArray<DemoListing> = DEMO_CATALOG,
  ) {}

  configuredCapabilities(): Readonly<Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>> {
    const out = {} as Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>;
    for (const capability of CAPABILITIES) out[capability] = 'CONFIGURED';
    return out;
  }

  async searchProducts(
    request: AdapterSearchRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AdapterSearchResult>> {
    const mapping = mappingContextFrom(ctx, this.providerId, {
      origin: 'DEMO_FIXTURE',
      sourceRef: 'fixture:search',
    });

    const candidates = this.listings
      .filter((listing) => listing.providerId === this.providerId)
      .map((listing) => ({
        listing,
        score: tokenSimilarity(request.keywords, `${listing.title} ${listing.brand ?? ''}`),
      }))
      .filter((entry) => entry.score > 0.05)
      .sort((a, b) => b.score - a.score);

    const start = (Math.max(request.page, 1) - 1) * request.pageSize;
    const page = candidates.slice(start, start + request.pageSize);

    const items = page.map((entry) =>
      this.toNormalized(entry.listing, mapping, ctx.countryCode, ctx.currency),
    );

    return adapterOk(
      { items, totalAvailable: candidates.length, page: request.page },
      this.meta('searchProducts'),
    );
  }

  async getProduct(
    request: AdapterProductRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<{ product: NormalizedProduct; offer: NormalizedOffer }>> {
    type Result = { product: NormalizedProduct; offer: NormalizedOffer };
    const listing = this.listings.find(
      (entry) =>
        entry.providerId === this.providerId && entry.providerProductId === request.providerProductId,
    );
    if (!listing) {
      return adapterFailed<Result>(
        {
          code: 'ERROR_INVALID_PRODUCT',
          retryable: false,
          internalNote: `No fixture for ${request.providerProductId}`,
        },
        this.meta('getProduct'),
      );
    }

    const mapping = mappingContextFrom(ctx, this.providerId, {
      origin: 'DEMO_FIXTURE',
      sourceRef: 'fixture:product',
    });
    return adapterOk<Result>(
      this.toNormalized(listing, mapping, ctx.countryCode, ctx.currency),
      this.meta('getProduct'),
    );
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
   * Fixture coupons are never VERIFIED. Verification means a check through an
   * authorized channel actually happened, and in a fixture it did not — so the
   * demo shows the "unconfirmed" presentation, which is the one that needs
   * reviewing anyway.
   */
  async getCoupons(
    request: AdapterCouponRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<ReadonlyArray<NormalizedCoupon>>> {
    const mapping = mappingContextFrom(ctx, this.providerId, { origin: 'DEMO_FIXTURE' });
    const coupons = this.listings
      .filter((listing) => listing.providerId === this.providerId && listing.demoCoupon)
      .slice(0, request.limit)
      .map<NormalizedCoupon>((listing) => ({
        couponId: `demo_${this.providerId}_${listing.providerProductId}`,
        providerId: this.providerId,
        code: listing.demoCoupon?.code ?? null,
        title: listing.demoCoupon?.title ?? 'Sample promotion',
        terms: 'Sample data. Not a real promotion.',
        discountType: 'PERCENTAGE',
        discountPercent: {
          state: 'KNOWN',
          value: listing.demoCoupon?.percent ?? 10,
          provenance: {
            origin: 'DEMO_FIXTURE',
            providerId: this.providerId,
            observedAt: mapping.observedAt,
          },
        },
        discountAmount: { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE' },
        eligibility: {
          minimumOrder: { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE' },
          productIds: [listing.providerProductId],
          categoryPaths: [],
          countries: [],
          audience: 'UNKNOWN',
          stackable: { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE' },
        },
        startsAt: null,
        expiresAt: { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE' },
        status: 'POSSIBLY_ACTIVE',
        lastCheckedAt: null,
        verificationMethod: 'NONE',
        sourceUrl: null,
      }));

    return adapterOk(coupons, this.meta('getCoupons'));
  }

  async buildAffiliateLink(
    request: AdapterLinkRequest,
    ctx: AdapterContext,
  ): Promise<AdapterOutcome<AffiliateLink>> {
    // A fixture has no programme, so the link is honestly untracked.
    return adapterOk(
      untrackedLink({
        providerId: this.providerId,
        destinationUrl: request.destinationUrl,
        placement: request.placement,
        guard: ctx.guard,
        locale: ctx.locale,
        status: 'NOT_CONFIGURED',
      }),
      this.meta('buildAffiliateLink'),
    );
  }

  recognizeUrl(): UrlRecognition {
    return { recognized: false, reason: 'HOST_NOT_MINE' };
  }

  validateContentUsage(
    usage: 'DISPLAY' | 'PERSIST' | 'MODEL_TRAINING' | 'EXPORT',
  ): { permitted: boolean; reasonKey: string | null } {
    // Fixture data may be displayed (labelled) but never retained, so it can
    // never contaminate the catalog or a price series.
    return usage === 'DISPLAY'
      ? { permitted: true, reasonKey: null }
      : { permitted: false, reasonKey: 'content.demoFixture.displayOnly' };
  }

  getDisclosure(locale: string, ctx: AdapterContext): string | null {
    return ctx.guard.disclosure(locale);
  }

  // --- Internals ----------------------------------------------------------

  private toNormalized(
    listing: DemoListing,
    mapping: ReturnType<typeof mappingContextFrom>,
    countryCode: string,
    currency: string,
  ): { product: NormalizedProduct; offer: NormalizedOffer } {
    const provenance = {
      origin: 'DEMO_FIXTURE' as const,
      providerId: this.providerId,
      observedAt: mapping.observedAt,
      policyRef: `${mapping.guard.policyVersion}#demo`,
    };

    const identifiers: ProductIdentifiers = {
      providerProductId: listing.providerProductId,
      ...(listing.gtin ? { gtin: listing.gtin } : {}),
      ...(listing.mpn ? { mpn: listing.mpn } : {}),
      ...(listing.model ? { model: listing.model } : {}),
    };

    const variantAttributes = [
      ...(listing.capacity
        ? [
            {
              key: 'capacity' as const,
              normalized: normalizeCapacity(listing.capacity) ?? listing.capacity,
              raw: listing.capacity,
            },
          ]
        : []),
      ...(listing.colour
        ? [
            {
              key: 'colour' as const,
              normalized: normalizeColour(listing.colour) ?? listing.colour.toUpperCase(),
              raw: listing.colour,
            },
          ]
        : []),
    ];

    const priceMoney = moneyFromDecimal(listing.price, listing.currency);
    const price: NormalizedOffer['price'] = priceMoney
      ? { state: 'KNOWN', value: priceMoney, provenance }
      : { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE', providerId: this.providerId };

    const referenceMoney = listing.referencePrice
      ? moneyFromDecimal(listing.referencePrice, listing.currency)
      : null;
    const referencePrice: NormalizedOffer['referencePrice'] =
      referenceMoney && mapping.guard.check('referencePrice').allowed
        ? { state: 'KNOWN', value: referenceMoney, provenance }
        : { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE', providerId: this.providerId };

    const shippingMoney =
      listing.shipping === undefined ? null : moneyFromDecimal(listing.shipping, listing.currency);
    const shipping = {
      cost:
        shippingMoney && mapping.guard.check('shipping').allowed
          ? ({ state: 'KNOWN', value: shippingMoney, provenance } as NormalizedOffer['shipping']['cost'])
          : ({
              state: 'UNKNOWN',
              reason: 'NOT_PROVIDED_BY_SOURCE',
              providerId: this.providerId,
            } as NormalizedOffer['shipping']['cost']),
      free:
        listing.shipping === 0 && mapping.guard.check('shipping').allowed
          ? ({ state: 'KNOWN', value: true, provenance } as NormalizedOffer['shipping']['free'])
          : ({
              state: 'UNKNOWN',
              reason: 'NOT_PROVIDED_BY_SOURCE',
              providerId: this.providerId,
            } as NormalizedOffer['shipping']['free']),
      destinationCountry: countryCode,
      estimatedDays:
        listing.shippingDays && mapping.guard.check('shipping').allowed
          ? ({
              state: 'KNOWN',
              value: listing.shippingDays,
              provenance,
            } as NormalizedOffer['shipping']['estimatedDays'])
          : ({
              state: 'UNKNOWN',
              reason: 'NOT_PROVIDED_BY_SOURCE',
              providerId: this.providerId,
            } as NormalizedOffer['shipping']['estimatedDays']),
      service: {
        state: 'UNKNOWN',
        reason: 'NOT_PROVIDED_BY_SOURCE',
        providerId: this.providerId,
      } as NormalizedOffer['shipping']['service'],
    } satisfies NormalizedOffer['shipping'];

    const tax = {
      amount: {
        state: 'UNKNOWN',
        reason: 'NOT_COMPUTABLE',
        providerId: this.providerId,
      } as NormalizedOffer['tax']['amount'],
      includedInItemPrice: {
        state: 'UNKNOWN',
        reason: 'NOT_PROVIDED_BY_SOURCE',
        providerId: this.providerId,
      } as NormalizedOffer['tax']['includedInItemPrice'],
      appliedRate: null,
      destinationCountry: countryCode,
    } satisfies NormalizedOffer['tax'];

    const ratingAllowed = mapping.guard.check('ratings').allowed;
    const product: NormalizedProduct = {
      providerId: this.providerId,
      identifiers,
      title: cleanTitle(listing.title),
      rawTitle: listing.title,
      brand: listing.brand
        ? { state: 'KNOWN', value: listing.brand, provenance }
        : { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE', providerId: this.providerId },
      category: { state: 'KNOWN', value: listing.categoryPath.at(-1) ?? 'general', provenance },
      categoryPath: listing.categoryPath,
      variantAttributes,
      specifications: [],
      images: [],
      rating:
        ratingAllowed && listing.rating !== undefined
          ? { state: 'KNOWN', value: listing.rating, provenance }
          : ratingAllowed
            ? { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE', providerId: this.providerId }
            : { state: 'RESTRICTED', capability: 'ratings', providerId: this.providerId },
      reviewCount:
        mapping.guard.check('reviewCounts').allowed && listing.reviewCount !== undefined
          ? { state: 'KNOWN', value: listing.reviewCount, provenance }
          : mapping.guard.check('reviewCounts').allowed
            ? { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE', providerId: this.providerId }
            : { state: 'RESTRICTED', capability: 'reviewCounts', providerId: this.providerId },
      sourceUrl: listing.sourceUrl,
    };

    const offer: NormalizedOffer = {
      providerId: this.providerId,
      providerProductId: listing.providerProductId,
      providerVariantId: null,
      price,
      referencePrice,
      currency: listing.currency,
      availability: mapping.guard.check('availability').allowed
        ? { state: 'KNOWN', value: 'IN_STOCK', provenance }
        : { state: 'RESTRICTED', capability: 'availability', providerId: this.providerId },
      shipping,
      tax,
      seller: {
        name: { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE', providerId: this.providerId },
        rating: { state: 'UNKNOWN', reason: 'NOT_PROVIDED_BY_SOURCE', providerId: this.providerId },
        isMarketplaceFirstParty: {
          state: 'UNKNOWN',
          reason: 'NOT_PROVIDED_BY_SOURCE',
          providerId: this.providerId,
        },
      },
      appliedCoupons: [],
      totalCost: buildTotalCost({
        itemPrice: price,
        shippingCost: shipping.cost,
        shippingFree: shipping.free,
        tax: tax.amount,
        referencePrice,
        appliedCoupons: [],
        currency: listing.currency,
        providerId: this.providerId,
        observedAt: mapping.observedAt,
      }),
      sourceUrl: listing.sourceUrl,
      observedAt: mapping.observedAt,
    };

    return { product, offer };
  }

  private meta(operation: string) {
    return {
      providerId: this.providerId,
      operation,
      durationMs: 12,
      httpStatus: 200,
      rateLimited: false,
      demoFixture: true,
    };
  }
}
