import {
  type AvailabilityState,
  type Money,
  type NormalizedOffer,
  type NormalizedProduct,
  type SpecificationEntry,
  type VariantAttribute,
  cleanTitle,
  extractModelCandidates,
  normalizeCapacity,
  normalizeColour,
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
import { type TemuProduct, readMapped } from './types.js';

const PROVIDER_ID = 'temu';

/**
 * Maps a Temu partner product to our normalized model.
 *
 * Real mapper, driven entirely by TEMU_FIELD_MAP so that adapting to the
 * documented field names of a specific programme contract is a configuration
 * change. It is exercised by unit tests against fixture payloads, which is why
 * it exists in full rather than as a placeholder.
 *
 * Like the other marketplaces in this set, listings carry no GTIN and no
 * manufacturer part number, so identity rests on the provider's own goods id
 * and on a model token only when the title actually contains one.
 */
export function mapTemuProduct(
  raw: TemuProduct,
  ctx: MappingContext,
  options: { readonly countryCode: string; readonly currency: string },
): { product: NormalizedProduct; offer: NormalizedOffer } | null {
  const goodsId = readMapped<string | number>(raw, 'productId');
  const productId = goodsId === undefined ? null : String(goodsId).trim();
  if (!productId) return null;

  const rawTitle = readMapped<string>(raw, 'title')?.trim();
  if (!rawTitle) return null;

  const sourceUrl = validateSourceUrl(ctx, readMapped<string>(raw, 'url'));
  if (!sourceUrl) return null;

  const variantId = readMapped<string | number>(raw, 'variantId');
  const currency = resolveCurrency(readMapped<string>(raw, 'currency'), options.currency);

  const product: NormalizedProduct = {
    providerId: PROVIDER_ID,
    identifiers: {
      providerProductId: productId,
      ...(variantId === undefined ? {} : { providerVariantId: String(variantId) }),
      ...(extractModelCandidates(rawTitle)[0]
        ? { model: extractModelCandidates(rawTitle)[0] as string }
        : {}),
    },
    title: cleanTitle(rawTitle),
    rawTitle,
    brand: mapString(ctx, 'productContent', readMapped<string>(raw, 'brand') ?? null, {
      maxLength: 120,
    }),
    category: mapString(ctx, 'productContent', readMapped<string>(raw, 'categoryName') ?? null),
    categoryPath: buildCategoryPath(raw),
    variantAttributes: extractVariantAttributes(rawTitle, raw),
    specifications: buildSpecifications(raw, ctx),
    images: mapImages(ctx, collectImages(raw)),
    rating: mapNumber(ctx, 'ratings', readMapped<string | number>(raw, 'rating') ?? null, {
      min: 0,
      max: 5,
    }),
    reviewCount: mapInteger(ctx, 'reviewCounts', readMapped<string | number>(raw, 'reviewCount') ?? null, {
      min: 0,
    }),
    sourceUrl,
  };

  const price = mapMoney(ctx, 'currentPrice', readMapped<string>(raw, 'price') ?? null, currency);
  const referencePrice = mapMoney(
    ctx,
    'referencePrice',
    readMapped<string>(raw, 'referencePrice') ?? null,
    currency,
  );

  const shippingFee = readMapped<string>(raw, 'shippingFee');
  const shipping = {
    cost: mapMoney(ctx, 'shipping', shippingFee ?? null, currency),
    // Only an explicit zero fee is free shipping. An absent fee is unknown.
    free: mapBoolean(ctx, 'shipping', shippingFee === undefined ? null : parseFloat(shippingFee) === 0),
    destinationCountry: options.countryCode,
    estimatedDays: mapShippingDays(raw, ctx),
    service: mapString(ctx, 'shipping', null),
  } satisfies NormalizedOffer['shipping'];

  const tax = {
    amount: unknown<Money>('NOT_COMPUTABLE', PROVIDER_ID),
    includedInItemPrice: mapBoolean(ctx, 'currentPrice', null),
    appliedRate: null,
    destinationCountry: options.countryCode,
  } satisfies NormalizedOffer['tax'];

  const offer: NormalizedOffer = {
    providerId: PROVIDER_ID,
    providerProductId: productId,
    providerVariantId: variantId === undefined ? null : String(variantId),
    price,
    referencePrice,
    currency,
    availability: mapAvailability(raw, ctx),
    shipping,
    tax,
    seller: {
      name: mapString(ctx, 'sellerInfo', readMapped<string>(raw, 'sellerName') ?? null, {
        maxLength: 120,
      }),
      rating: mapNumber(ctx, 'sellerInfo', null, { min: 0, max: 5 }),
      isMarketplaceFirstParty: mapBoolean(ctx, 'sellerInfo', null),
    },
    appliedCoupons: [],
    totalCost: buildTotalCost({
      itemPrice: price,
      shippingCost: shipping.cost,
      shippingFree: shipping.free,
      tax: tax.amount,
      referencePrice,
      appliedCoupons: [],
      currency,
      providerId: PROVIDER_ID,
      observedAt: ctx.observedAt,
    }),
    sourceUrl,
    observedAt: ctx.observedAt,
  };

  return { product, offer };
}

function mapAvailability(
  raw: TemuProduct,
  ctx: MappingContext,
): NormalizedOffer['availability'] {
  const inStock = readMapped<boolean>(raw, 'inStock');
  return mapField<boolean, AvailabilityState>(ctx, 'availability', inStock, (value) =>
    value ? 'IN_STOCK' : 'OUT_OF_STOCK',
  );
}

function mapShippingDays(
  raw: TemuProduct,
  ctx: MappingContext,
): NormalizedOffer['shipping']['estimatedDays'] {
  const low = raw.shipping_days_min;
  const high = raw.shipping_days_max;
  if (typeof low !== 'number' && typeof high !== 'number') {
    return unknown<{ low: number; high: number }>('NOT_PROVIDED_BY_SOURCE', PROVIDER_ID);
  }
  return mapField<{ low: number; high: number }, { low: number; high: number }>(
    ctx,
    'shipping',
    { low: low ?? high ?? 0, high: high ?? low ?? 0 },
    (value) => {
      if (value.low <= 0 || value.high <= 0 || value.high > 365) return null;
      return { low: Math.min(value.low, value.high), high: Math.max(value.low, value.high) };
    },
  );
}

function extractVariantAttributes(title: string, raw: TemuProduct): VariantAttribute[] {
  const out: VariantAttribute[] = [];

  for (const spec of raw.specs ?? []) {
    const name = spec.name?.toLowerCase() ?? '';
    const value = spec.value;
    if (!value) continue;
    if (name.includes('color') || name.includes('colour')) {
      const colour = normalizeColour(value);
      if (colour) out.push({ key: 'colour', normalized: colour, raw: value });
    } else if (name.includes('size')) {
      const size = normalizeSize(value);
      if (size) out.push({ key: 'size', normalized: size, raw: value });
    } else if (name.includes('capacity') || name.includes('storage') || name.includes('memory')) {
      const capacity = normalizeCapacity(value);
      if (capacity) out.push({ key: 'capacity', normalized: capacity, raw: value });
    }
  }

  if (!out.some((attribute) => attribute.key === 'capacity')) {
    const capacity = normalizeCapacity(title);
    if (capacity) out.push({ key: 'capacity', normalized: capacity, raw: capacity });
  }
  if (!out.some((attribute) => attribute.key === 'colour')) {
    const colour = normalizeColour(title);
    if (colour) out.push({ key: 'colour', normalized: colour, raw: colour });
  }

  return out;
}

function buildCategoryPath(raw: TemuProduct): string[] {
  const path = readMapped<ReadonlyArray<string>>(raw, 'categoryPath');
  if (Array.isArray(path) && path.length > 0) {
    return path
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.toLowerCase().replace(/\s+/g, '-'))
      .slice(0, 4);
  }
  const name = readMapped<string>(raw, 'categoryName');
  return name ? [name.toLowerCase().replace(/\s+/g, '-')] : [];
}

function buildSpecifications(raw: TemuProduct, ctx: MappingContext): SpecificationEntry[] {
  if (!ctx.guard.check('productContent').allowed) return [];
  const out: SpecificationEntry[] = [];
  for (const spec of raw.specs ?? []) {
    if (!spec.name || !spec.value) continue;
    out.push({
      key: spec.name.toLowerCase().replace(/\s+/g, '_'),
      label: spec.name,
      value: spec.value.slice(0, 300),
      unit: null,
    });
    if (out.length >= 12) break;
  }
  return out;
}

function collectImages(
  raw: TemuProduct,
): Array<{ url?: string | null; width?: number | null; height?: number | null }> {
  const out: Array<{ url?: string | null; width?: number | null; height?: number | null }> = [];
  const primary = readMapped<string>(raw, 'primaryImage');
  if (primary) out.push({ url: primary, width: null, height: null });
  const images = readMapped<ReadonlyArray<string>>(raw, 'images');
  if (Array.isArray(images)) {
    for (const url of images) {
      if (typeof url === 'string') out.push({ url, width: null, height: null });
      if (out.length >= 6) break;
    }
  }
  return out;
}

function resolveCurrency(candidate: string | undefined, fallback: string): string {
  const upper = candidate?.toUpperCase();
  return upper && /^[A-Z]{3}$/.test(upper) ? upper : fallback.toUpperCase();
}
