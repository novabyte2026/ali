import {
  type AvailabilityState,
  type Money,
  type NormalizedOffer,
  type NormalizedProduct,
  type ProductIdentifiers,
  type SpecificationEntry,
  type VariantAttribute,
  cleanTitle,
  extractModelCandidates,
  normalizeCapacity,
  normalizeColour,
  normalizeMilliampHours,
  normalizeMpn,
  normalizeWattage,
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
import { type AliExpressProduct, unwrapList } from './types.js';

const PROVIDER_ID = 'aliexpress';

/**
 * Maps an AliExpress affiliate product to our normalized model.
 *
 * The hard part of this source is identity. Listings almost never carry a
 * GTIN or a manufacturer part number, and titles are long seller-written
 * strings stuffed with keywords. So:
 *
 *   - Identifiers get the provider product id, and a model candidate only
 *     when the title contains something with the shape of a part number.
 *     We do not promote a keyword to "model" to make matching look better.
 *   - `evaluate_rate` arrives as a percentage string like "93.4%", which is a
 *     satisfaction rate, not a five-star rating. Converting it to a 0–5 value
 *     is a real conversion with a defensible basis, so it is mapped with
 *     MEDIUM confidence rather than presented as a star rating the seller gave.
 *   - Shipping is not available through the product API, so it is UNKNOWN and
 *     the total cost becomes an estimate — which is honest for a cross-border
 *     order where shipping is often a third of the price.
 */
export function mapAliExpressProduct(
  raw: AliExpressProduct,
  ctx: MappingContext,
  options: { readonly countryCode: string; readonly currency: string },
): { product: NormalizedProduct; offer: NormalizedOffer } | null {
  const productId = raw.product_id === undefined ? null : String(raw.product_id).trim();
  if (!productId) return null;

  const rawTitle = raw.product_title?.trim();
  if (!rawTitle) return null;

  const sourceUrl = validateSourceUrl(ctx, raw.product_detail_url);
  if (!sourceUrl) return null;

  const categoryPath = buildCategoryPath(raw);
  const variantAttributes = extractVariantAttributes(rawTitle);

  const product: NormalizedProduct = {
    providerId: PROVIDER_ID,
    identifiers: buildIdentifiers(raw, productId, rawTitle),
    title: cleanTitle(rawTitle),
    rawTitle,
    // No structured brand field exists on this endpoint. Rather than take the
    // first word of the title and call it a brand, this is left unknown; the
    // matching engine then declines to assert brand agreement, which is the
    // correct outcome.
    brand: mapString(ctx, 'productContent', null),
    category: mapString(ctx, 'productContent', raw.second_level_category_name ?? raw.first_level_category_name ?? null),
    categoryPath,
    variantAttributes,
    specifications: buildSpecifications(raw, ctx),
    images: mapImages(ctx, collectImages(raw)),
    rating: mapSatisfactionRate(raw.evaluate_rate, ctx),
    // `lastest_volume` is recent order count, not a review count. Mapping it
    // to reviewCount would misrepresent it, so reviews stay unknown.
    reviewCount: mapInteger(ctx, 'reviewCounts', null, { min: 0 }),
    sourceUrl,
  };

  const offer = buildOffer(raw, {
    ctx,
    productId,
    sourceUrl,
    countryCode: options.countryCode,
    currency: options.currency,
  });

  return { product, offer };
}

function buildOffer(
  raw: AliExpressProduct,
  args: {
    ctx: MappingContext;
    productId: string;
    sourceUrl: string;
    countryCode: string;
    currency: string;
  },
): NormalizedOffer {
  const { ctx } = args;

  // `target_*` fields are already in the currency we requested; the plain
  // fields are in the seller's currency. Prefer the targeted pair, and keep
  // the currency that actually accompanies the number we used.
  const saleAmount = raw.target_sale_price ?? raw.sale_price ?? null;
  const saleCurrency =
    raw.target_sale_price !== undefined
      ? (raw.target_sale_price_currency ?? args.currency)
      : (raw.sale_price_currency ?? args.currency);

  const originalAmount = raw.target_original_price ?? raw.original_price ?? null;
  const originalCurrency =
    raw.target_original_price !== undefined
      ? (raw.target_original_price_currency ?? args.currency)
      : (raw.original_price_currency ?? args.currency);

  const price = mapMoney(ctx, 'currentPrice', saleAmount, saleCurrency);
  const referencePrice = mapMoney(ctx, 'referencePrice', originalAmount, originalCurrency);

  const shipping = {
    // The freight API is a separate, per-account surface. Until it is wired up
    // the cost is genuinely unknown and is reported as such.
    cost: unknown<Money>('NOT_PROVIDED_BY_SOURCE', PROVIDER_ID),
    free: mapBoolean(ctx, 'shipping', null),
    destinationCountry: args.countryCode,
    estimatedDays: mapShipToDays(raw.ship_to_days, ctx),
    service: mapString(ctx, 'shipping', null),
  } satisfies NormalizedOffer['shipping'];

  const tax = {
    amount: unknown<Money>('NOT_COMPUTABLE', PROVIDER_ID),
    includedInItemPrice: mapBoolean(ctx, 'currentPrice', null),
    appliedRate: null,
    destinationCountry: args.countryCode,
  } satisfies NormalizedOffer['tax'];

  const seller = {
    name: mapString(ctx, 'sellerInfo', raw.shop_name ?? null, { maxLength: 120 }),
    rating: mapNumber(ctx, 'sellerInfo', null, { min: 0, max: 5 }),
    isMarketplaceFirstParty: mapBoolean(ctx, 'sellerInfo', null),
  } satisfies NormalizedOffer['seller'];

  const currency = resolveCurrency(saleCurrency, args.currency);

  return {
    providerId: PROVIDER_ID,
    providerProductId: args.productId,
    providerVariantId: raw.sku_id ? String(raw.sku_id) : null,
    price,
    referencePrice,
    currency,
    availability: unknown<AvailabilityState>('NOT_PROVIDED_BY_SOURCE', PROVIDER_ID),
    shipping,
    tax,
    seller,
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
    sourceUrl: args.sourceUrl,
    observedAt: ctx.observedAt,
  };
}

function buildIdentifiers(
  raw: AliExpressProduct,
  productId: string,
  title: string,
): ProductIdentifiers {
  // Only a token that genuinely looks like a part number is accepted as a
  // model. A false model is worse than no model: it creates confident matches
  // between unrelated products.
  const model = extractModelCandidates(title)[0];
  const sku = raw.sku_id ? String(raw.sku_id) : undefined;
  return {
    providerProductId: productId,
    ...(sku ? { providerVariantId: sku } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * `evaluate_rate` is a positive-feedback percentage ("93.4%"), not a star
 * rating. Converting a percentage to a five-point scale is defensible but is
 * a derivation, so it carries MEDIUM confidence and the UI labels the source.
 */
function mapSatisfactionRate(
  raw: string | undefined,
  ctx: MappingContext,
): NormalizedProduct['rating'] {
  return mapField<string, number>(
    ctx,
    'ratings',
    raw,
    (value) => {
      const match = value.match(/([\d.]+)\s*%?/);
      const percent = Number.parseFloat(match?.[1] ?? '');
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
      return Math.round((percent / 20) * 10) / 10;
    },
    { confidence: 'MEDIUM' },
  );
}

/** "3;5" or "7" days-to-ship hints map to a range, never a single promise. */
function mapShipToDays(
  raw: string | undefined,
  ctx: MappingContext,
): NormalizedOffer['shipping']['estimatedDays'] {
  return mapField<string, { low: number; high: number }>(ctx, 'shipping', raw, (value) => {
    const numbers = value
      .split(/[^0-9]+/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part) && part > 0 && part < 365);
    if (numbers.length === 0) return null;
    const low = Math.min(...numbers);
    const high = Math.max(...numbers);
    return { low, high };
  });
}

/**
 * Variant attributes are extracted from the title because this endpoint has no
 * structured variant fields. Only unambiguous, unit-bearing tokens are taken —
 * a capacity, a wattage, a battery rating, a colour word. Anything inferred
 * more loosely would create variant conflicts out of noise.
 */
function extractVariantAttributes(title: string): VariantAttribute[] {
  const out: VariantAttribute[] = [];

  const capacity = normalizeCapacity(title);
  if (capacity) out.push({ key: 'capacity', normalized: capacity, raw: capacity });

  const mah = normalizeMilliampHours(title);
  if (mah) out.push({ key: 'count', normalized: mah, raw: mah });

  const wattage = normalizeWattage(title);
  if (wattage) out.push({ key: 'wattage', normalized: wattage, raw: wattage });

  const colour = normalizeColour(title);
  if (colour) out.push({ key: 'colour', normalized: colour, raw: colour });

  return out;
}

function buildCategoryPath(raw: AliExpressProduct): string[] {
  return [raw.first_level_category_name, raw.second_level_category_name]
    .filter((name): name is string => Boolean(name))
    .map((name) => name.toLowerCase().replace(/\s+/g, '-'));
}

function buildSpecifications(raw: AliExpressProduct, ctx: MappingContext): SpecificationEntry[] {
  if (!ctx.guard.check('productContent').allowed) return [];
  const out: SpecificationEntry[] = [];
  if (raw.platform_product_type) {
    out.push({
      key: 'platform_product_type',
      label: 'Product type',
      value: raw.platform_product_type,
      unit: null,
    });
  }
  // `lastest_volume` is kept as an explicitly-labelled recent order count. It
  // is useful signal and it is not a review count, so it is named accurately.
  if (typeof raw.lastest_volume === 'number' && raw.lastest_volume > 0) {
    out.push({
      key: 'recent_orders',
      label: 'Recent orders',
      value: String(raw.lastest_volume),
      unit: null,
    });
  }
  return out;
}

function collectImages(
  raw: AliExpressProduct,
): Array<{ url?: string | null; width?: number | null; height?: number | null }> {
  const out: Array<{ url?: string | null; width?: number | null; height?: number | null }> = [];
  if (raw.product_main_image_url) {
    out.push({ url: raw.product_main_image_url, width: null, height: null });
  }
  for (const url of unwrapList<string>(raw.product_small_image_urls, 'string')) {
    out.push({ url, width: null, height: null });
    if (out.length >= 6) break;
  }
  return out;
}

function resolveCurrency(candidate: string | undefined, fallback: string): string {
  const upper = candidate?.toUpperCase();
  return upper && /^[A-Z]{3}$/.test(upper) ? upper : fallback.toUpperCase();
}
