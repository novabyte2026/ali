import type { Datum } from '../datum.js';
import type { Money } from '../money.js';
import type { ProviderId } from './provider.js';

/**
 * Coupon verification state.
 *
 * "Active" is a claim about the world, and the only honest basis for it is a
 * check we performed through a channel the provider authorizes. A code scraped
 * from a coupon aggregator is at best POSSIBLY_ACTIVE, and the UI says so.
 * We never print "guaranteed discount".
 */
export const COUPON_STATUSES = [
  /** Confirmed against an authorized source within the freshness window. */
  'VERIFIED',
  /** Confirmed, but the check is older than the freshness window. */
  'RECENTLY_CHECKED',
  /** Reported by an authorized source without a validity confirmation. */
  'POSSIBLY_ACTIVE',
  /** Past its stated expiry. */
  'EXPIRED',
  /** A check determined the code is not accepted. */
  'INVALID',
  /** We hold the code but have no basis for any claim about it. */
  'UNKNOWN',
] as const;

export type CouponStatus = (typeof COUPON_STATUSES)[number];

/** Statuses we are willing to surface at all. */
export function couponIsPresentable(status: CouponStatus): boolean {
  return status === 'VERIFIED' || status === 'RECENTLY_CHECKED' || status === 'POSSIBLY_ACTIVE';
}

/** Statuses we may include in a total-cost calculation. */
export function couponCountsTowardTotal(status: CouponStatus): boolean {
  return status === 'VERIFIED';
}

export type DiscountType =
  | 'PERCENTAGE'
  | 'FIXED_AMOUNT'
  | 'FREE_SHIPPING'
  | 'TIERED'
  | 'BUNDLE'
  | 'UNSPECIFIED';

export interface CouponEligibility {
  /** Minimum basket value, when stated. */
  readonly minimumOrder: Datum<Money>;
  /** Provider product ids the code applies to, empty when store-wide. */
  readonly productIds: ReadonlyArray<string>;
  readonly categoryPaths: ReadonlyArray<ReadonlyArray<string>>;
  readonly countries: ReadonlyArray<string>;
  /**
   * Audience restriction. New-customer and app-only codes are the most common
   * reason a headline discount does not materialize, so we carry it explicitly
   * instead of letting it surprise the user at checkout.
   */
  readonly audience: 'ANY' | 'NEW_CUSTOMERS' | 'APP_ONLY' | 'ACCOUNT_SPECIFIC' | 'UNKNOWN';
  /** Whether the provider states this can combine with other promotions. */
  readonly stackable: Datum<boolean>;
}

export interface NormalizedCoupon {
  readonly couponId: string;
  readonly providerId: ProviderId;
  /** Null for automatic promotions that need no code. */
  readonly code: string | null;
  readonly title: string;
  readonly terms: string | null;

  readonly discountType: DiscountType;
  /** Percent for PERCENTAGE, minor-unit Money for FIXED_AMOUNT. */
  readonly discountPercent: Datum<number>;
  readonly discountAmount: Datum<Money>;

  readonly eligibility: CouponEligibility;
  readonly startsAt: string | null;
  readonly expiresAt: Datum<string>;

  readonly status: CouponStatus;
  readonly lastCheckedAt: string | null;
  /** How the status was established, for the trust popover. */
  readonly verificationMethod: 'PROVIDER_API' | 'PROVIDER_FEED' | 'AFFILIATE_TOOL' | 'NONE';
  readonly sourceUrl: string | null;
}

/**
 * A coupon considered against a specific offer. `applicable` is UNKNOWN far
 * more often than it is true — eligibility rules are usually not machine
 * readable — and the pricing engine treats UNKNOWN as "do not deduct".
 */
export interface AppliedCoupon {
  readonly coupon: NormalizedCoupon;
  readonly applicable: Datum<boolean>;
  readonly savings: Datum<Money>;
  /** Translation key explaining why it was or was not applied. */
  readonly reasonKey: string;
}
