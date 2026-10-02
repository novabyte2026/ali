import type { FastifyInstance } from 'fastify';
import {
  type NormalizedOffer,
  type NormalizedProduct,
  AppError,
  assertsSameProduct,
  eligibleForCheaperSameProduct,
  exactValue,
  isSupportedCountry,
  isSupportedCurrency,
} from '@shelf/shared';
import {
  type AdapterContext,
  isRefusal,
  recognizeProductUrl,
} from '@shelf/integrations';
import type { AppContext } from '../context.js';
import { requirePermission } from '../middleware/index.js';
import { priceOffer, compareOffers } from '../pricing/engine.js';
import { groupListings } from '../products/grouping.js';
import { matchProducts, satisfiesSameProductRequest } from '../matching/engine.js';
import { selectCouponsForOffer } from '../coupons/engine.js';
import { aggregateSearch } from '../search/aggregator.js';

/**
 * Product, comparison and lookup routes.
 *
 * The two interesting endpoints are the ones that answer the questions people
 * actually have about a marketplace product:
 *
 *   /cheaper      — "is this exact thing available for less somewhere else?"
 *                   Only identifier-backed matches are returned, and a variant
 *                   difference disqualifies a candidate outright. It will
 *                   frequently return nothing, which is the honest answer.
 *
 *   /alternatives — "what else would do the job?" A different question with a
 *                   different contract: these are explicitly not the same
 *                   product, and the response says so (rules 30, 31).
 *
 *   /analyze-url  — "I have a link, tell me about it." Recognizes the source
 *                   locally, then fetches only what the provider's capabilities
 *                   permit.
 */

export async function registerProductRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v1/products/:providerId/:providerProductId',
    { preHandler: [requirePermission('product:view')] },
    async (request) => {
      const { providerId, providerProductId } = request.params as {
        providerId: string;
        providerProductId: string;
      };
      const query = request.query as { country?: string; currency?: string; locale?: string };
      const locale = query.locale ?? request.profile?.preferences.locale ?? ctx.defaults.locale;
      const countryCode = resolveCountry(query.country, request, ctx);
      const currency = resolveCurrency(query.currency, request, ctx);

      const loaded = await loadProduct(ctx, {
        providerId,
        providerProductId,
        countryCode,
        currency,
        locale,
        requestId: request.requestId,
      });

      const guard = await ctx.guards.forProvider(providerId, locale);
      const coupons = guard.check('coupons').allowed
        ? await ctx.coupons.forProduct(providerId, providerProductId, countryCode)
        : [];

      const applied = selectCouponsForOffer(coupons, loaded.offer, { countryCode, limit: 5 });

      const priced = await priceOffer(loaded.offer, {
        targetCurrency: currency,
        countryCode,
        guard,
        converter: ctx.converter,
        appliedCoupons: applied,
      });

      return {
        product: loaded.product,
        offer: priced,
        // Why we are showing what we are showing, and what we cannot show.
        provenance: {
          policyVersion: guard.policyVersion,
          observedAt: priced.observedAt,
          missingComponents: priced.totalCost.missingComponents,
          restrictedFields: restrictedFieldsOf(loaded.product, priced),
        },
        disclosure: {
          required: true,
          text: guard.disclosure(locale),
          placements: guard.disclosurePlacements(),
        },
      };
    },
  );

  /**
   * Cross-source comparison for one product identity.
   *
   * Searches the other providers for the same identifiers, keeps only matches
   * that are identifier-backed, and returns a verdict that refuses to name a
   * cheapest when the totals are not comparable (rule 28).
   */
  app.get(
    '/api/v1/products/:providerId/:providerProductId/comparison',
    { preHandler: [requirePermission('comparison:basic')] },
    async (request) => {
      const { providerId, providerProductId } = request.params as {
        providerId: string;
        providerProductId: string;
      };
      const query = request.query as { country?: string; currency?: string; locale?: string };
      const locale = query.locale ?? request.profile?.preferences.locale ?? ctx.defaults.locale;
      const countryCode = resolveCountry(query.country, request, ctx);
      const currency = resolveCurrency(query.currency, request, ctx);

      const anchor = await loadProduct(ctx, {
        providerId,
        providerProductId,
        countryCode,
        currency,
        locale,
        requestId: request.requestId,
      });

      const anchorGuard = await ctx.guards.forProvider(providerId, locale);
      const anchorOffer = await priceOffer(anchor.offer, {
        targetCurrency: currency,
        countryCode,
        guard: anchorGuard,
        converter: ctx.converter,
        appliedCoupons: [],
      });

      // Search terms built from identifiers, not from the title: a title
      // search would return similar products and we are looking for this one.
      const searchTerm = buildIdentitySearchTerm(anchor.product);
      const candidates = searchTerm
        ? await findMatchesAcrossProviders(ctx, {
            anchor: anchor.product,
            excludeProviderId: providerId,
            searchTerm,
            countryCode,
            currency,
            locale,
            requestId: request.requestId,
          })
        : [];

      const crossProviderAllowed = new Set<string>();
      for (const id of [providerId, ...candidates.map((entry) => entry.product.providerId)]) {
        const guard = await ctx.guards.forProvider(id, locale);
        if (guard.crossProviderDisplayPermitted()) crossProviderAllowed.add(id);
      }

      const groups = groupListings(
        [{ product: anchor.product, offer: anchorOffer }, ...candidates],
        { crossProviderAllowed },
      );

      // The group containing the anchor is the one we are comparing.
      const group =
        groups.find((candidate) =>
          candidate.offerings.some(
            (offering) =>
              offering.providerId === providerId &&
              offering.offer.providerProductId === providerProductId,
          ),
        ) ?? groups[0];

      if (!group) throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'productGroup' } });

      const offers = group.offerings.map((offering) => offering.offer);
      const verdict = compareOffers(offers, currency);

      return {
        group,
        verdict,
        // Stated explicitly so the UI never has to guess whether it may
        // present these as price rows for one product.
        comparableAsSingleProduct: group.comparableAcrossSources,
        searchedProviders: candidates.length > 0 ? [...new Set(candidates.map((c) => c.product.providerId))] : [],
        noMatchReasonKey:
          group.offerings.length === 1
            ? searchTerm
              ? 'comparison.noIdentifierMatchFound'
              : 'comparison.productHasNoIdentifiers'
            : null,
      };
    },
  );

  /** "Find this exact product cheaper." Returns nothing when nothing qualifies. */
  app.get(
    '/api/v1/products/:providerId/:providerProductId/cheaper',
    { preHandler: [requirePermission('comparison:basic')] },
    async (request) => {
      const { providerId, providerProductId } = request.params as {
        providerId: string;
        providerProductId: string;
      };
      const query = request.query as { country?: string; currency?: string; locale?: string };
      const locale = query.locale ?? request.profile?.preferences.locale ?? ctx.defaults.locale;
      const countryCode = resolveCountry(query.country, request, ctx);
      const currency = resolveCurrency(query.currency, request, ctx);

      const anchor = await loadProduct(ctx, {
        providerId,
        providerProductId,
        countryCode,
        currency,
        locale,
        requestId: request.requestId,
      });

      const anchorGuard = await ctx.guards.forProvider(providerId, locale);
      const anchorOffer = await priceOffer(anchor.offer, {
        targetCurrency: currency,
        countryCode,
        guard: anchorGuard,
        converter: ctx.converter,
        appliedCoupons: [],
      });

      const searchTerm = buildIdentitySearchTerm(anchor.product);
      if (!searchTerm) {
        // No identifiers means we cannot establish that anything else is the
        // same product. Saying so is the whole feature working correctly.
        return {
          anchor: { product: anchor.product, offer: anchorOffer },
          cheaper: [],
          reasonKey: 'cheaper.productHasNoIdentifiers',
        };
      }

      const candidates = await findMatchesAcrossProviders(ctx, {
        anchor: anchor.product,
        excludeProviderId: providerId,
        searchTerm,
        countryCode,
        currency,
        locale,
        requestId: request.requestId,
      });

      const anchorPrice = exactValue(anchorOffer.price);

      const cheaper = candidates
        .map((candidate) => ({
          candidate,
          match: matchProducts(anchor.product, candidate.product),
        }))
        .filter(({ candidate, match }) => {
          // Three gates, all of which must pass.
          if (!eligibleForCheaperSameProduct(match.level)) return false;
          if (match.variantConflict) return false;

          const check = satisfiesSameProductRequest(candidate.product, {
            ...(anchor.product.identifiers.model
              ? { model: anchor.product.identifiers.model }
              : {}),
            ...(exactValue(anchor.product.brand)
              ? { brand: exactValue(anchor.product.brand) as string }
              : {}),
            variantHints: anchor.product.variantAttributes.map((attribute) => ({
              key: attribute.key,
              value: attribute.normalized,
            })),
          });
          if (!check.satisfies) return false;

          // And it must actually be cheaper.
          const price = exactValue(candidate.offer.price);
          if (!price || !anchorPrice || price.currency !== anchorPrice.currency) return false;
          return price.minor < anchorPrice.minor;
        })
        .map(({ candidate, match }) => ({
          product: candidate.product,
          offer: candidate.offer,
          match,
        }))
        .sort((a, b) => (exactValue(a.offer.price)?.minor ?? 0) - (exactValue(b.offer.price)?.minor ?? 0));

      return {
        anchor: { product: anchor.product, offer: anchorOffer },
        cheaper,
        reasonKey: cheaper.length === 0 ? 'cheaper.noSameProductFoundCheaper' : null,
      };
    },
  );

  /**
   * Alternatives. Explicitly a different contract from `cheaper`: these are
   * similar products for the same need, not the same product, and every entry
   * carries its match level so the UI labels it accordingly.
   */
  app.get(
    '/api/v1/products/:providerId/:providerProductId/alternatives',
    { preHandler: [requirePermission('search:basic')] },
    async (request) => {
      const { providerId, providerProductId } = request.params as {
        providerId: string;
        providerProductId: string;
      };
      const query = request.query as {
        country?: string;
        currency?: string;
        locale?: string;
        budgetMax?: string;
      };
      const locale = query.locale ?? request.profile?.preferences.locale ?? ctx.defaults.locale;
      const countryCode = resolveCountry(query.country, request, ctx);
      const currency = resolveCurrency(query.currency, request, ctx);

      const anchor = await loadProduct(ctx, {
        providerId,
        providerProductId,
        countryCode,
        currency,
        locale,
        requestId: request.requestId,
      });

      const providerIds = await ctx.policies.searchableProviderIds();
      const controller = new AbortController();
      request.raw.on('close', () => controller.abort());

      // Searched by category and title words rather than identifiers, because
      // we are deliberately looking for other products.
      const term = [
        exactValue(anchor.product.brand) ?? '',
        anchor.product.categoryPath.at(-1) ?? '',
        anchor.product.title.split(/\s+/).slice(0, 4).join(' '),
      ]
        .filter(Boolean)
        .join(' ')
        .trim();

      const result = await aggregateSearch(ctx.aggregatorDeps, {
        request: {
          query: query.budgetMax ? `${term} up to ${query.budgetMax}` : term,
          mode: 'all',
          filters: {},
          sort: 'MOST_RELEVANT',
          page: 1,
          pageSize: 18,
          countryCode,
          currency,
          locale,
        },
        requestId: request.requestId,
        signal: controller.signal,
        providerIds,
      });

      const alternatives = result.items
        .filter(
          (item) =>
            // Exclude the anchor itself and anything that is the same product
            // — those belong to the comparison and cheaper flows.
            !item.group.offerings.some(
              (offering) =>
                offering.providerId === providerId &&
                offering.offer.providerProductId === providerProductId,
            ) && !assertsSameProduct(item.matchLevel),
        )
        .slice(0, 12);

      return {
        anchor: { product: anchor.product },
        alternatives,
        // Stated in the payload so a client cannot mistake these for the same
        // product under a different name.
        contract: 'These are different products that may suit the same need.',
      };
    },
  );

  /**
   * URL analyzer. Recognizes the provider locally, with no network call, then
   * fetches only what that provider's capabilities permit.
   */
  app.post(
    '/api/v1/products/analyze-url',
    { preHandler: [requirePermission('product:view')] },
    async (request) => {
      const body = request.body as { url?: string; country?: string; currency?: string };
      const url = body.url?.trim();

      if (!url || url.length > 2000) {
        throw new AppError('ERROR_INVALID_PRODUCT_URL', { details: { field: 'url' } });
      }

      const recognition = recognizeProductUrl(ctx.registry, url);
      if (!recognition.recognized) {
        return {
          recognized: false,
          reasonKey:
            recognition.reason === 'UNKNOWN_HOST'
              ? 'urlAnalyzer.unsupportedStore'
              : 'urlAnalyzer.noProductIdInUrl',
          supportedProviders: ctx.registry.map((entry) => entry.providerId),
        };
      }

      const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;
      const countryCode = resolveCountry(body.country, request, ctx);
      const currency = resolveCurrency(body.currency, request, ctx);

      const guard = await ctx.guards.forProvider(recognition.providerId, locale);

      // The source is identified even when we may not fetch details, which is
      // itself useful: the user learns what they pasted and why we cannot say
      // more about it.
      if (!guard.check('productDetails').allowed) {
        return {
          recognized: true,
          providerId: recognition.providerId,
          providerProductId: recognition.providerProductId,
          detailsAvailable: false,
          reasonKey: `capability.productDetails.${guard.check('productDetails').state}`,
        };
      }

      const loaded = await loadProduct(ctx, {
        providerId: recognition.providerId,
        providerProductId: recognition.providerProductId,
        countryCode,
        currency,
        locale,
        requestId: request.requestId,
      });

      const priced = await priceOffer(loaded.offer, {
        targetCurrency: currency,
        countryCode,
        guard,
        converter: ctx.converter,
        appliedCoupons: [],
      });

      return {
        recognized: true,
        providerId: recognition.providerId,
        providerProductId: recognition.providerProductId,
        detailsAvailable: true,
        product: loaded.product,
        offer: priced,
        identityConfidence: loaded.product.identifiers.gtin
          ? 'HIGH'
          : loaded.product.identifiers.model
            ? 'MEDIUM'
            : 'LOW',
        comparisonPossible: Boolean(
          loaded.product.identifiers.gtin ?? loaded.product.identifiers.mpn,
        ),
      };
    },
  );

  /**
   * Image lookup. The contract and the capability gate exist; no vision model
   * is wired up, so it refuses rather than guessing at a product. Listed as
   * PLANNED in the feature register.
   */
  app.post(
    '/api/v1/products/analyze-image',
    { preHandler: [requirePermission('product:view')] },
    async () => {
      throw new AppError('ERROR_CAPABILITY_UNAVAILABLE', {
        details: { capability: 'imageLookup', featureStatus: 'PLANNED' },
      });
    },
  );
}

// --- Helpers --------------------------------------------------------------

async function loadProduct(
  ctx: AppContext,
  args: {
    readonly providerId: string;
    readonly providerProductId: string;
    readonly countryCode: string;
    readonly currency: string;
    readonly locale: string;
    readonly requestId: string;
  },
): Promise<{ product: NormalizedProduct; offer: NormalizedOffer }> {
  const entry = ctx.registry.find((candidate) => candidate.providerId === args.providerId);
  if (!entry) {
    throw new AppError('ERROR_UNSUPPORTED_SOURCE', { details: { providerId: args.providerId } });
  }

  const guard = (await ctx.guards.forProvider(args.providerId, args.locale)).withRequestId(
    args.requestId,
  );

  const adapterCtx: AdapterContext = {
    guard,
    countryCode: args.countryCode,
    currency: args.currency,
    locale: args.locale,
    requestId: args.requestId,
    signal: AbortSignal.timeout(ctx.config.search.providerTimeoutMs),
    log: ctx.log.child({ providerId: args.providerId }),
  };

  const outcome = await entry.adapter.getProduct(
    { providerProductId: args.providerProductId },
    adapterCtx,
  );

  ctx.health.record(args.providerId, {
    operation: 'getProduct',
    durationMs: outcome.meta.durationMs,
    status: outcome.ok ? 'OK' : 'FAILED',
    rateLimited: outcome.meta.rateLimited,
    requestId: args.requestId,
  });

  if (!outcome.ok) {
    if (isRefusal(outcome)) {
      throw new AppError(outcome.refusal.code, {
        details: { providerId: args.providerId, capability: outcome.refusal.capability },
      });
    }
    throw new AppError(outcome.failure.code, {
      details: { providerId: args.providerId },
      internalNote: outcome.failure.internalNote,
    });
  }

  return outcome.value;
}

/**
 * Builds a search term from identifiers. Returns null when the product has
 * none — in which case no cross-source search is attempted at all, because
 * anything it returned could not be established as the same product.
 */
function buildIdentitySearchTerm(product: NormalizedProduct): string | null {
  const parts: string[] = [];
  const brand = exactValue(product.brand);
  if (brand) parts.push(brand);
  if (product.identifiers.model) parts.push(product.identifiers.model);
  else if (product.identifiers.mpn) parts.push(product.identifiers.mpn);

  if (parts.length === 0) return null;
  // A GTIN alone is rarely searchable on these marketplaces, so brand+model
  // is the usable term even when a GTIN exists for matching.
  return parts.join(' ');
}

async function findMatchesAcrossProviders(
  ctx: AppContext,
  args: {
    readonly anchor: NormalizedProduct;
    readonly excludeProviderId: string;
    readonly searchTerm: string;
    readonly countryCode: string;
    readonly currency: string;
    readonly locale: string;
    readonly requestId: string;
  },
): Promise<ReadonlyArray<{ product: NormalizedProduct; offer: NormalizedOffer }>> {
  const providerIds = (await ctx.policies.searchableProviderIds()).filter(
    (id) => id !== args.excludeProviderId,
  );
  if (providerIds.length === 0) return [];

  const result = await aggregateSearch(ctx.aggregatorDeps, {
    request: {
      query: args.searchTerm,
      mode: 'all',
      filters: {},
      sort: 'BEST_MATCH',
      page: 1,
      pageSize: 20,
      countryCode: args.countryCode,
      currency: args.currency,
      locale: args.locale,
    },
    requestId: args.requestId,
    signal: AbortSignal.timeout(ctx.config.search.totalTimeoutMs),
    providerIds,
  });

  const out: Array<{ product: NormalizedProduct; offer: NormalizedOffer }> = [];
  for (const item of result.items) {
    for (const offering of item.group.offerings) {
      if (offering.providerId === args.excludeProviderId) continue;
      out.push({ product: offering.product, offer: offering.offer });
    }
  }
  return out;
}

/** Fields this provider is not permitted to supply, for the trust panel. */
function restrictedFieldsOf(
  product: NormalizedProduct,
  offer: NormalizedOffer,
): ReadonlyArray<string> {
  const restricted: string[] = [];
  if (product.rating.state === 'RESTRICTED') restricted.push('rating');
  if (product.reviewCount.state === 'RESTRICTED') restricted.push('reviewCount');
  if (offer.shipping.cost.state === 'RESTRICTED') restricted.push('shipping');
  if (offer.availability.state === 'RESTRICTED') restricted.push('availability');
  if (offer.seller.name.state === 'RESTRICTED') restricted.push('seller');
  if (offer.referencePrice.state === 'RESTRICTED') restricted.push('referencePrice');
  return restricted;
}

function resolveCountry(
  candidate: string | undefined,
  request: { profile: { preferences: { countryCode: string } } | null },
  ctx: AppContext,
): string {
  const value = (candidate ?? request.profile?.preferences.countryCode ?? ctx.defaults.countryCode).toUpperCase();
  if (!isSupportedCountry(value)) {
    throw new AppError('ERROR_UNSUPPORTED_COUNTRY', { details: { countryCode: value } });
  }
  return value;
}

function resolveCurrency(
  candidate: string | undefined,
  request: { profile: { preferences: { currency: string } } | null },
  ctx: AppContext,
): string {
  const value = (candidate ?? request.profile?.preferences.currency ?? ctx.defaults.currency).toUpperCase();
  if (!isSupportedCurrency(value)) {
    throw new AppError('ERROR_UNSUPPORTED_CURRENCY', { details: { currency: value } });
  }
  return value;
}
