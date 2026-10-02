import {
  type AvailabilityState,
  type Money,
  type NormalizedOffer,
  type NormalizedProduct,
  type ProductIdentifiers,
  type SpecificationEntry,
  type VariantAttribute,
  type VariantAttributeKey,
  cleanTitle,
  extractModelCandidates,
  normalizeCapacity,
  normalizeColour,
  normalizeGtin,
  normalizeMpn,
  normalizeSize,
  unknown,
} from '@shelf/shared';
import {
  type MappingContext,
  mapBoolean,
  mapField,
  mapImages,
  mapInteger,
  mapMoney,
  mapNumber,
  mapString,
  validateSourceUrl,
} from '../common/mapping.js';
import { buildTotalCost } from '../common/totals.js';
import type { PaapiItem, PaapiListing } from './types.js';

const PROVIDER_ID = 'amazon';

/**
 * Maps a PA-API item to our normalized model.
 *
 * Two things this mapper deliberately does not do:
 *
 *   - It does not synthesize a rating or review count. PA-API 5.0 does not
 *     return numeric ratings, and the `ratings` capability is accordingly not
 *     available, so these come back RESTRICTED. The product page then shows
 *     that this source does not provide ratings through our integration,
 *     rather than borrowing another source's number or showing an empty star
 *     row that reads as zero.
 *
 *   - It does not infer a shipping cost from free-shipping eligibility.
 *     "Eligible for free shipping" is a statement about a threshold, not about
 *     this order, so the cost stays UNKNOWN and the total is an estimate.
 */
export function mapAmazonItem(
  item: PaapiItem,
  ctx: MappingContext,
  options: { readonly countryCode: string; readonly currency: string },
): { product: NormalizedProduct; offer: NormalizedOffer } | null {
  const asin = item.ASIN?.trim();
  if (!asin) return null;

  const rawTitle = item.ItemInfo?.Title?.DisplayValue?.trim();
  if (!rawTitle) return null;

  const sourceUrl = validateSourceUrl(ctx, item.DetailPageURL);
  if (!sourceUrl) return null;

  const identifiers = mapIdentifiers(item, asin);
  const variantAttributes = mapVariantAttributes(item);
  const categoryPath = mapCategoryPath(item);

  const product: NormalizedProduct = {
    providerId: PROVIDER_ID,
    identifiers,
    title: cleanTitle(rawTitle),
    rawTitle,
    brand: mapString(ctx, 'productContent', brandOf(item), { maxLength: 120 }),
    category: mapString(ctx, 'productContent', categoryPath.at(-1) ?? null),
    categoryPath,
    variantAttributes,
    specifications: mapSpecifications(item, ctx),
    images: mapImages(ctx, collectImages(item)),
    // PA-API 5.0 exposes no numeric rating; the capability reflects that and
    // these resolve to RESTRICTED rather than a fabricated value.
    rating: mapNumber(ctx, 'ratings', null, { min: 0, max: 5 }),
    reviewCount: mapInteger(ctx, 'reviewCounts', null, { min: 0 }),
    sourceUrl,
  };

  const listing = pickListing(item.Offers?.Listings);
  const offer = mapOffer(listing, {
    ctx,
    asin,
    sourceUrl,
    countryCode: options.countryCode,
    currency: options.currency,
  });

  return { product, offer };
}

/** Prefers the buy-box listing, which is the price a shopper actually sees. */
function pickListing(
  listings: ReadonlyArray<PaapiListing> | undefined,
): PaapiListing | undefined {
  if (!listings || listings.length === 0) return undefined;
  return listings.find((listing) => listing.IsBuyBoxWinner) ?? listings[0];
}

function mapOffer(
  listing: PaapiListing | undefined,
  args: {
    ctx: MappingContext;
    asin: string;
    sourceUrl: string;
    countryCode: string;
    currency: string;
  },
): NormalizedOffer {
  const { ctx, countryCode } = args;
  const price = mapMoney(
    ctx,
    'currentPrice',
    listing?.Price?.Amount ?? null,
    listing?.Price?.Currency ?? null,
  );
  const referencePrice = mapMoney(
    ctx,
    'referencePrice',
    listing?.SavingBasis?.Amount ?? null,
    listing?.SavingBasis?.Currency ?? null,
  );

  const freeShippingEligible = mapBoolean(
    ctx,
    'shipping',
    listing?.DeliveryInfo?.IsFreeShippingEligible ?? null,
  );

  const shipping = {
    // Eligibility is not a quote. A destination shipping cost is not available
    // from this API, so it stays unknown and the total becomes an estimate.
    cost: unknown<Money>('NOT_PROVIDED_BY_SOURCE', PROVIDER_ID),
    free: freeShippingEligible,
    destinationCountry: countryCode,
    estimatedDays: unknown<{ low: number; high: number }>('NOT_PROVIDED_BY_SOURCE', PROVIDER_ID),
    service: mapString(ctx, 'shipping', null),
  } satisfies NormalizedOffer['shipping'];

  const tax = {
    // Destination VAT and import duty are applied by the pricing engine where
    // a configured rate makes a labelled estimate possible. The adapter does
    // not guess, because the API has no basis for one.
    amount: unknown<Money>('NOT_COMPUTABLE', PROVIDER_ID),
    includedInItemPrice: mapBoolean(ctx, 'currentPrice', null),
    appliedRate: null,
    destinationCountry: countryCode,
  } satisfies NormalizedOffer['tax'];

  const seller = {
    name: mapString(ctx, 'sellerInfo', listing?.MerchantInfo?.Name ?? null, { maxLength: 120 }),
    rating: mapNumber(ctx, 'sellerInfo', null, { min: 0, max: 5 }),
    isMarketplaceFirstParty: mapBoolean(
      ctx,
      'sellerInfo',
      listing?.DeliveryInfo?.IsAmazonFulfilled ?? null,
    ),
  } satisfies NormalizedOffer['seller'];

  const availability = mapAvailability(listing, ctx);

  const totalCost = buildTotalCost({
    itemPrice: price,
    shippingCost: shipping.cost,
    shippingFree: shipping.free,
    tax: tax.amount,
    referencePrice,
    appliedCoupons: [],
    currency: args.currency,
    providerId: PROVIDER_ID,
    observedAt: ctx.observedAt,
  });

  return {
    providerId: PROVIDER_ID,
    providerProductId: args.asin,
    providerVariantId: null,
    price,
    referencePrice,
    currency: args.currency,
    availability,
    shipping,
    tax,
    seller,
    appliedCoupons: [],
    totalCost,
    sourceUrl: args.sourceUrl,
    observedAt: ctx.observedAt,
  };
}

/**
 * Availability comes from a free-text message plus a type token. We map only
 * what the type token states clearly, and leave anything else UNKNOWN rather
 * than pattern-matching English prose into a stock claim.
 */
function mapAvailability(
  listing: PaapiListing | undefined,
  ctx: MappingContext,
): NormalizedOffer['availability'] {
  // Only the structured type token is trusted. The `Message` field is free
  // English prose, and pattern-matching it into a stock claim would produce
  // confident nonsense on anything unexpected.
  return mapField<string, AvailabilityState>(ctx, 'availability', listing?.Availability?.Type, (type) => {
    switch (type) {
      case 'Now':
        return 'IN_STOCK';
      case 'Preorder':
        return 'PREORDER';
      case 'Backorder':
        return 'LIMITED_STOCK';
      default:
        return null;
    }
  });
}

function brandOf(item: PaapiItem): string | null {
  return (
    item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue ??
    item.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue ??
    null
  );
}

function mapIdentifiers(item: PaapiItem, asin: string): ProductIdentifiers {
  const external = item.ItemInfo?.ExternalIds;
  const gtinCandidates = [
    ...(external?.EANs?.DisplayValues ?? []),
    ...(external?.UPCs?.DisplayValues ?? []),
    ...(external?.ISBNs?.DisplayValues ?? []),
  ];

  let gtin: string | undefined;
  for (const candidate of gtinCandidates) {
    const normalized = normalizeGtin(candidate);
    if (normalized) {
      gtin = normalized;
      break;
    }
  }

  const partNumber = normalizeMpn(item.ItemInfo?.ManufactureInfo?.ItemPartNumber?.DisplayValue);
  const declaredModel = item.ItemInfo?.ManufactureInfo?.Model?.DisplayValue;
  const model =
    normalizeMpn(declaredModel) ??
    extractModelCandidates(item.ItemInfo?.Title?.DisplayValue ?? '')[0];

  return {
    providerProductId: asin,
    ...(gtin ? { gtin } : {}),
    ...(partNumber ? { mpn: partNumber } : {}),
    ...(model ? { model } : {}),
  };
}

function mapVariantAttributes(item: PaapiItem): VariantAttribute[] {
  const out: VariantAttribute[] = [];
  const productInfo = item.ItemInfo?.ProductInfo;

  const rawColour = productInfo?.Color?.DisplayValue;
  const colour = normalizeColour(rawColour);
  if (rawColour && colour) {
    out.push({ key: 'colour', normalized: colour, raw: rawColour });
  }

  const rawSize = productInfo?.Size?.DisplayValue;
  if (rawSize) {
    // A "size" field on Amazon frequently carries a storage capacity for
    // electronics, which matters far more for matching than clothing size.
    const capacity = normalizeCapacity(rawSize);
    if (capacity) {
      out.push({ key: 'capacity', normalized: capacity, raw: rawSize });
    } else {
      const size = normalizeSize(rawSize);
      if (size) out.push({ key: 'size', normalized: size, raw: rawSize });
    }
  }

  const unitCount = productInfo?.UnitCount?.DisplayValue;
  if (typeof unitCount === 'number' && unitCount > 1) {
    out.push({ key: 'count', normalized: String(unitCount), raw: String(unitCount) });
  }

  // Capacity stated in the title but not in a structured field.
  if (!out.some((attribute) => attribute.key === 'capacity')) {
    const fromTitle = normalizeCapacity(item.ItemInfo?.Title?.DisplayValue ?? '');
    if (fromTitle) {
      out.push({ key: 'capacity', normalized: fromTitle, raw: fromTitle });
    }
  }

  return dedupeAttributes(out);
}

function dedupeAttributes(attributes: ReadonlyArray<VariantAttribute>): VariantAttribute[] {
  const seen = new Set<VariantAttributeKey>();
  const out: VariantAttribute[] = [];
  for (const attribute of attributes) {
    if (seen.has(attribute.key)) continue;
    seen.add(attribute.key);
    out.push(attribute);
  }
  return out;
}

function mapSpecifications(item: PaapiItem, ctx: MappingContext): SpecificationEntry[] {
  if (!ctx.guard.check('productContent').allowed) return [];

  const out: SpecificationEntry[] = [];
  const features = item.ItemInfo?.Features?.DisplayValues ?? [];
  for (const [index, feature] of features.entries()) {
    const text = feature.trim();
    if (!text) continue;
    out.push({
      key: `feature_${index + 1}`,
      label: 'Feature',
      value: text.slice(0, 500),
      unit: null,
    });
    if (out.length >= 10) break;
  }

  const dimensions = item.ItemInfo?.ProductInfo?.ItemDimensions;
  for (const [key, entry] of Object.entries(dimensions ?? {})) {
    const value = (entry as { DisplayValue?: number; Unit?: string } | undefined)?.DisplayValue;
    const unit = (entry as { Unit?: string } | undefined)?.Unit ?? null;
    if (typeof value !== 'number') continue;
    out.push({ key: key.toLowerCase(), label: key, value: String(value), unit });
  }

  return out;
}

function mapCategoryPath(item: PaapiItem): string[] {
  const nodes = item.BrowseNodeInfo?.BrowseNodes ?? [];
  const names = nodes
    .map((node) => node.ContextFreeName ?? node.DisplayName)
    .filter((name): name is string => Boolean(name))
    .map((name) => name.toLowerCase().replace(/\s+/g, '-'));
  return [...new Set(names)].slice(0, 4);
}

function collectImages(
  item: PaapiItem,
): Array<{ url?: string | null; width?: number | null; height?: number | null }> {
  const out: Array<{ url?: string | null; width?: number | null; height?: number | null }> = [];
  const primary = item.Images?.Primary?.Large ?? item.Images?.Primary?.Medium;
  if (primary?.URL) {
    out.push({ url: primary.URL, width: primary.Width ?? null, height: primary.Height ?? null });
  }
  for (const variant of item.Images?.Variants ?? []) {
    const image = variant.Large ?? variant.Medium;
    if (image?.URL) {
      out.push({ url: image.URL, width: image.Width ?? null, height: image.Height ?? null });
    }
    if (out.length >= 6) break;
  }
  return out;
}
