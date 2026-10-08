import type { ConfidenceBand, Datum } from '../datum.js';
import type { Money } from '../money.js';
import type { ProviderId } from './provider.js';
import type { AppliedCoupon } from './coupon.js';

export type AvailabilityState =
  | 'IN_STOCK'
  | 'LIMITED_STOCK'
  | 'OUT_OF_STOCK'
  | 'PREORDER'
  | 'UNKNOWN';

export interface ShippingQuote {
  /** Cost to the user's destination. UNKNOWN when the source does not say. */
  readonly cost: Datum<Money>;
  /** True only when the provider explicitly states free shipping. */
  readonly free: Datum<boolean>;
  readonly destinationCountry: string;
  /** Business days to delivery, as a range. */
  readonly estimatedDays: Datum<{ readonly low: number; readonly high: number }>;
  /** Carrier/service name when supplied. */
  readonly service: Datum<string>;
}

export interface TaxQuote {
  /**
   * Import duty and VAT the user will owe. Almost never knowable from a
   * marketplace API for a cross-border order, so this is usually UNKNOWN or an
   * ESTIMATED range derived from a configured rate — and labelled as such.
   */
  readonly amount: Datum<Money>;
  /** Whether tax is already included in the displayed item price. */
  readonly includedInItemPrice: Datum<boolean>;
  /** Rate used when the amount is an estimate, e.g. 0.17. */
  readonly appliedRate: number | null;
  readonly destinationCountry: string;
}

export interface SellerInfo {
  readonly name: Datum<string>;
  readonly rating: Datum<number>;
  readonly isMarketplaceFirstParty: Datum<boolean>;
}

/**
 * The total cost model. This is the figure users actually make decisions on,
 * and the single most tempting place to fabricate a number.
 *
 * Rules enforced in pricing/engine.ts:
 *   - `total` is KNOWN only when item price, shipping and tax are all KNOWN.
 *   - If any component is an estimate, `total` is an ESTIMATED range.
 *   - If any component is UNKNOWN and material, `total` is UNKNOWN and the UI
 *     says the final cost is not available from the source rather than quietly
 *     showing the item price as if it were the total.
 */
export interface TotalCostBreakdown {
  readonly itemPrice: Datum<Money>;
  readonly shipping: Datum<Money>;
  readonly tax: Datum<Money>;
  readonly discount: Datum<Money>;
  readonly couponDiscount: Datum<Money>;
  readonly total: Datum<Money>;
  /** Components that could not be determined, for the "what's missing" note. */
  readonly missingComponents: ReadonlyArray<
    'SHIPPING' | 'TAX' | 'DUTIES' | 'COUPON_ELIGIBILITY'
  >;
  readonly confidence: ConfidenceBand;
}

/**
 * One purchasable proposition from one provider.
 *
 * `referencePrice` is only ever populated from a provider-supplied list price
 * where the `referencePrice` capability is AVAILABLE. We do not reconstruct a
 * "was" price from our own observation history and present it as the retailer's
 * list price, and we do not compute a discount percentage without one.
 */
export interface NormalizedOffer {
  readonly providerId: ProviderId;
  readonly providerProductId: string;
  readonly providerVariantId: string | null;

  readonly price: Datum<Money>;
  readonly referencePrice: Datum<Money>;
  readonly currency: string;

  readonly availability: Datum<AvailabilityState>;
  readonly shipping: ShippingQuote;
  readonly tax: TaxQuote;
  readonly seller: SellerInfo;

  readonly appliedCoupons: ReadonlyArray<AppliedCoupon>;
  readonly totalCost: TotalCostBreakdown;

  /** Provider URL for the offer, pre-affiliate. */
  readonly sourceUrl: string;
  /** When this offer's price was observed. Drives "checked N minutes ago". */
  readonly observedAt: string;
}

export function availabilityKey(state: AvailabilityState): string {
  return `availability.${state}`;
}

/**
 * Whether two offers may sit on the same comparison row. Different currencies
 * are fine (we convert, with a dated rate); different variants are not.
 */
export function offersComparable(a: NormalizedOffer, b: NormalizedOffer): boolean {
  if (a.providerVariantId && b.providerVariantId) {
    return a.providerVariantId !== b.providerVariantId || a.providerId !== b.providerId;
  }
  return true;
}
