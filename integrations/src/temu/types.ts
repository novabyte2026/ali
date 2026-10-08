/**
 * Temu partner response shapes.
 *
 * These are a reasonable, conservative shape for a marketplace partner search
 * response — every field optional, prices as strings — and they exist so the
 * mapper is real code with real tests rather than a stub. The actual field
 * names for a given partner account come from its programme documentation; the
 * `TEMU_FIELD_MAP` below is where they are declared, so adapting to the real
 * contract is a configuration edit rather than a mapper rewrite.
 *
 * Nothing here is presented as confirmed. The capability matrix ships every
 * Temu capability as VERIFICATION_REQUIRED for exactly this reason.
 */

export interface TemuProduct {
  readonly goods_id?: string | number;
  readonly sku_id?: string | number;
  readonly title?: string;
  readonly goods_name?: string;
  readonly thumb_url?: string;
  readonly image_urls?: ReadonlyArray<string>;
  readonly detail_url?: string;
  readonly link_url?: string;
  /** Decimal string in `currency`. */
  readonly price?: string;
  readonly market_price?: string;
  readonly currency?: string;
  readonly rating?: string | number;
  readonly review_count?: string | number;
  readonly sales_volume?: string | number;
  readonly category_name?: string;
  readonly category_path?: ReadonlyArray<string>;
  readonly shop_name?: string;
  readonly in_stock?: boolean;
  readonly shipping_fee?: string;
  readonly shipping_days_min?: number;
  readonly shipping_days_max?: number;
  readonly brand?: string;
  readonly specs?: ReadonlyArray<{ readonly name?: string; readonly value?: string }>;
}

export interface TemuSearchResponse {
  readonly success?: boolean;
  readonly error_code?: string | number;
  readonly error_msg?: string;
  readonly request_id?: string;
  readonly data?: {
    readonly items?: ReadonlyArray<TemuProduct>;
    readonly total?: number;
    readonly page?: number;
  };
}

/**
 * Field mapping. The one place a real programme contract's naming is declared.
 *
 * Each entry lists the response keys we will read for a logical field, in
 * priority order. Adding the documented key to the front of a list is the
 * whole adaptation step.
 */
export const TEMU_FIELD_MAP = {
  productId: ['goods_id'],
  variantId: ['sku_id'],
  title: ['title', 'goods_name'],
  url: ['detail_url', 'link_url'],
  primaryImage: ['thumb_url'],
  images: ['image_urls'],
  price: ['price'],
  referencePrice: ['market_price'],
  currency: ['currency'],
  rating: ['rating'],
  reviewCount: ['review_count'],
  brand: ['brand'],
  categoryName: ['category_name'],
  categoryPath: ['category_path'],
  sellerName: ['shop_name'],
  inStock: ['in_stock'],
  shippingFee: ['shipping_fee'],
} as const satisfies Record<string, ReadonlyArray<keyof TemuProduct>>;

/** Reads the first present key from the mapping for a logical field. */
export function readMapped<T>(
  raw: TemuProduct,
  field: keyof typeof TEMU_FIELD_MAP,
): T | undefined {
  for (const key of TEMU_FIELD_MAP[field]) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') return value as T;
  }
  return undefined;
}

export function classifyTemuError(code: string | number | undefined): {
  readonly kind: 'RATE_LIMIT' | 'AUTH' | 'INVALID_REQUEST' | 'UNKNOWN';
} {
  const text = String(code ?? '').toLowerCase();
  if (text.includes('limit') || text.includes('frequen') || text === '429') {
    return { kind: 'RATE_LIMIT' };
  }
  if (text.includes('sign') || text.includes('auth') || text.includes('token') || text === '401') {
    return { kind: 'AUTH' };
  }
  if (text.includes('param') || text.includes('invalid')) return { kind: 'INVALID_REQUEST' };
  return { kind: 'UNKNOWN' };
}
