/**
 * AliExpress affiliate API response shapes.
 *
 * The gateway wraps every response twice: an outer envelope keyed by the
 * method name, then a `resp_result` with a code and a `result`. With
 * `simplify=true` the envelope is flattened somewhat, but not consistently
 * across methods, so `unwrap` below handles both shapes rather than assuming.
 *
 * Field names are the API's own (snake_case strings, prices as decimal
 * strings). They are mapped through the Datum helpers exactly once, in
 * mapper.ts.
 */

export interface AliExpressResponseResult<T> {
  readonly resp_code?: number;
  readonly resp_msg?: string;
  readonly result?: T;
}

export interface AliExpressErrorResponse {
  readonly error_response?: {
    readonly code?: number | string;
    readonly msg?: string;
    readonly sub_code?: string;
    readonly sub_msg?: string;
    readonly request_id?: string;
  };
}

export interface AliExpressProduct {
  readonly product_id?: number | string;
  readonly product_title?: string;
  readonly product_main_image_url?: string;
  readonly product_small_image_urls?: { readonly string?: ReadonlyArray<string> } | ReadonlyArray<string>;
  readonly product_video_url?: string;
  readonly product_detail_url?: string;
  /** Current sale price, as a decimal string in `target_sale_price_currency`. */
  readonly target_sale_price?: string;
  readonly target_sale_price_currency?: string;
  /** Seller's stated reference price. */
  readonly target_original_price?: string;
  readonly target_original_price_currency?: string;
  readonly sale_price?: string;
  readonly sale_price_currency?: string;
  readonly original_price?: string;
  readonly original_price_currency?: string;
  readonly discount?: string;
  readonly evaluate_rate?: string;
  readonly lastest_volume?: number;
  readonly first_level_category_id?: number;
  readonly first_level_category_name?: string;
  readonly second_level_category_id?: number;
  readonly second_level_category_name?: string;
  readonly shop_id?: number | string;
  readonly shop_url?: string;
  readonly shop_name?: string;
  readonly promotion_link?: string;
  readonly ship_to_days?: string;
  readonly platform_product_type?: string;
  readonly commission_rate?: string;
  readonly sku_id?: string;
}

export interface AliExpressProductQueryResult {
  readonly current_page_no?: number;
  readonly current_record_count?: number;
  readonly total_record_count?: number;
  readonly products?:
    | { readonly product?: ReadonlyArray<AliExpressProduct> }
    | ReadonlyArray<AliExpressProduct>;
}

export interface AliExpressLinkResult {
  readonly total_result_count?: number;
  readonly promotion_links?:
    | {
        readonly promotion_link?: ReadonlyArray<{
          readonly source_value?: string;
          readonly promotion_link?: string;
        }>;
      }
    | ReadonlyArray<{ readonly source_value?: string; readonly promotion_link?: string }>;
}

/**
 * Normalizes the gateway's inconsistent list wrapping.
 *
 * The API returns a collection either as a bare array or as `{ item: [...] }`
 * depending on method and `simplify` setting. Handling both here keeps the
 * mapper free of defensive shape checks.
 */
export function unwrapList<T>(
  value: { readonly [key: string]: unknown } | ReadonlyArray<T> | undefined,
  innerKey: string,
): ReadonlyArray<T> {
  if (!value) return [];
  if (Array.isArray(value)) return value as ReadonlyArray<T>;
  const inner = (value as Record<string, unknown>)[innerKey];
  if (Array.isArray(inner)) return inner as ReadonlyArray<T>;
  return [];
}

/**
 * Finds the payload inside the gateway envelope. Tries the method-named key,
 * then a generic `resp_result`, then the object itself.
 */
export function unwrapEnvelope<T>(
  body: Record<string, unknown>,
  methodKey: string,
): AliExpressResponseResult<T> | null {
  const direct = body[methodKey];
  if (direct && typeof direct === 'object') {
    const candidate = direct as Record<string, unknown>;
    if (candidate.resp_result && typeof candidate.resp_result === 'object') {
      return candidate.resp_result as AliExpressResponseResult<T>;
    }
    return candidate as AliExpressResponseResult<T>;
  }
  if (body.resp_result && typeof body.resp_result === 'object') {
    return body.resp_result as AliExpressResponseResult<T>;
  }
  if (body.result && typeof body.result === 'object') {
    return { resp_code: 200, result: body.result as T };
  }
  return null;
}

/**
 * Gateway error classification.
 *
 * `isp.*` and `isv.*` prefixes separate platform faults from our own bad
 * request — worth distinguishing because the first is retryable and the second
 * must not be retried.
 */
export function classifyAliExpressError(code: string | number | undefined, subCode?: string): {
  readonly kind: 'RATE_LIMIT' | 'AUTH' | 'INVALID_REQUEST' | 'PLATFORM' | 'UNKNOWN';
} {
  const text = `${code ?? ''}:${subCode ?? ''}`.toLowerCase();

  if (text.includes('traffic') || text.includes('limit') || code === 7 || code === '7') {
    return { kind: 'RATE_LIMIT' };
  }
  if (
    text.includes('invalid-signature') ||
    text.includes('invalid-appkey') ||
    text.includes('permission') ||
    text.includes('unauthorized') ||
    code === 15 ||
    code === 25
  ) {
    return { kind: 'AUTH' };
  }
  if (text.startsWith('isp.') || text.includes('isp.')) return { kind: 'PLATFORM' };
  if (text.startsWith('isv.') || text.includes('isv.')) return { kind: 'INVALID_REQUEST' };
  return { kind: 'UNKNOWN' };
}

export const METHOD_PRODUCT_QUERY = 'aliexpress.affiliate.product.query';
export const METHOD_PRODUCT_DETAIL = 'aliexpress.affiliate.productdetail.get';
export const METHOD_HOT_PRODUCT_QUERY = 'aliexpress.affiliate.hotproduct.query';
export const METHOD_LINK_GENERATE = 'aliexpress.affiliate.link.generate';

/** Response envelope key for a method, e.g. `aliexpress_affiliate_link_generate_response`. */
export function responseKeyFor(method: string): string {
  return `${method.replace(/\./g, '_')}_response`;
}
