import {
  type AppliedCoupon,
  type CouponStatus,
  type Datum,
  type Money,
  type NormalizedCoupon,
  type NormalizedOffer,
  couponCountsTowardTotal,
  couponIsPresentable,
  exactValue,
  isKnown,
  unknown,
} from '@shelf/shared';
import { couponSavingsFor } from '@shelf/integrations';

/**
 * Coupon engine.
 *
 * The product pressure here is obvious: a big "25% OFF" badge gets clicks. The
 * constraint is that a coupon is a claim about what will happen at someone
 * else's checkout, and we are usually not in a position to make it.
 *
 * Rules enforced below:
 *   - We never generate a code. Codes come from authorized sources only.
 *   - "Verified" means a check through an authorized channel happened inside
 *     the freshness window. Nothing else earns the word.
 *   - Only VERIFIED codes whose applicability to this specific offer is KNOWN
 *     are deducted from a total. Everything else is shown as available but
 *     unconfirmed, and the total does not move.
 *   - Audience restrictions (new customers, app-only) are surfaced rather than
 *     ignored, because they are the most common reason a headline discount
 *     does not materialize.
 *   - Coupons are not summed unless the provider states they stack.
 */

/** A verification older than this decays from VERIFIED to RECENTLY_CHECKED. */
const VERIFIED_FRESHNESS_MS = 6 * 60 * 60 * 1000;
/** Beyond this, a past check no longer supports any claim. */
const CHECK_USEFUL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Recomputes a coupon's status from its stored evidence.
 *
 * Status is derived at read time, not trusted from storage, so a coupon that
 * was verified last week cannot keep displaying as verified just because a row
 * says so.
 */
export function resolveStatus(
  coupon: NormalizedCoupon,
  now: Date = new Date(),
): CouponStatus {
  const expiresAt = exactValue(coupon.expiresAt);
  if (expiresAt && Date.parse(expiresAt) < now.getTime()) return 'EXPIRED';
  if (coupon.status === 'INVALID') return 'INVALID';

  if (coupon.startsAt && Date.parse(coupon.startsAt) > now.getTime()) {
    // Not yet started: we hold it but may not present it as usable.
    return 'UNKNOWN';
  }

  if (coupon.verificationMethod === 'NONE' || !coupon.lastCheckedAt) {
    // No authorized check ever happened. The strongest honest claim is that
    // an authorized source reported it exists.
    return coupon.status === 'POSSIBLY_ACTIVE' ? 'POSSIBLY_ACTIVE' : 'UNKNOWN';
  }

  const age = now.getTime() - Date.parse(coupon.lastCheckedAt);
  if (!Number.isFinite(age) || age < 0) return 'UNKNOWN';
  if (age > CHECK_USEFUL_MS) return 'POSSIBLY_ACTIVE';
  if (age > VERIFIED_FRESHNESS_MS) return 'RECENTLY_CHECKED';
  return coupon.status === 'VERIFIED' ? 'VERIFIED' : 'RECENTLY_CHECKED';
}

export function withResolvedStatus(
  coupon: NormalizedCoupon,
  now: Date = new Date(),
): NormalizedCoupon {
  return { ...coupon, status: resolveStatus(coupon, now) };
}

/**
 * Decides whether a coupon applies to one offer, and what it saves.
 *
 * `applicable` is UNKNOWN far more often than it is true, and that is the
 * correct output: marketplace eligibility rules are mostly not machine
 * readable. The pricing engine treats UNKNOWN as "do not deduct", so an
 * unconfirmed coupon never inflates a saving.
 */
export function applyCouponToOffer(
  coupon: NormalizedCoupon,
  offer: NormalizedOffer,
  context: { readonly countryCode: string; readonly now?: Date },
): AppliedCoupon {
  const now = context.now ?? new Date();
  const resolved = withResolvedStatus(coupon, now);

  if (!couponIsPresentable(resolved.status)) {
    return {
      coupon: resolved,
      applicable: { state: 'KNOWN', value: false, provenance: derivedProvenance() },
      savings: unknown<Money>('NOT_COMPUTABLE'),
      reasonKey: `coupon.notApplicable.${resolved.status}`,
    };
  }

  if (resolved.providerId !== offer.providerId) {
    return {
      coupon: resolved,
      applicable: { state: 'KNOWN', value: false, provenance: derivedProvenance() },
      savings: unknown<Money>('NOT_COMPUTABLE'),
      reasonKey: 'coupon.notApplicable.differentProvider',
    };
  }

  // --- Hard disqualifications we can actually read ------------------------
  const countries = resolved.eligibility.countries;
  if (countries.length > 0 && !countries.includes(context.countryCode.toUpperCase())) {
    return {
      coupon: resolved,
      applicable: { state: 'KNOWN', value: false, provenance: derivedProvenance() },
      savings: unknown<Money>('NOT_COMPUTABLE'),
      reasonKey: 'coupon.notApplicable.country',
    };
  }

  const productIds = resolved.eligibility.productIds;
  if (productIds.length > 0 && !productIds.includes(offer.providerProductId)) {
    return {
      coupon: resolved,
      applicable: { state: 'KNOWN', value: false, provenance: derivedProvenance() },
      savings: unknown<Money>('NOT_COMPUTABLE'),
      reasonKey: 'coupon.notApplicable.product',
    };
  }

  const savings = couponSavingsFor(
    {
      discountType: resolved.discountType,
      discountPercent: resolved.discountPercent,
      discountAmount: resolved.discountAmount,
    },
    offer.price,
    offer.currency,
  );

  // --- Minimum order ------------------------------------------------------
  const minimum = exactValue(resolved.eligibility.minimumOrder);
  const price = exactValue(offer.price);
  if (minimum && price && minimum.currency === price.currency && price.minor < minimum.minor) {
    return {
      coupon: resolved,
      applicable: { state: 'KNOWN', value: false, provenance: derivedProvenance() },
      savings: unknown<Money>('NOT_COMPUTABLE'),
      reasonKey: 'coupon.notApplicable.minimumOrder',
    };
  }

  // --- Audience restrictions ---------------------------------------------
  // We cannot know whether this shopper is a new customer or using the app,
  // so eligibility is genuinely unknown and the saving is not deducted. The
  // UI shows the code with its condition instead of a discounted total.
  if (
    resolved.eligibility.audience === 'NEW_CUSTOMERS' ||
    resolved.eligibility.audience === 'APP_ONLY' ||
    resolved.eligibility.audience === 'ACCOUNT_SPECIFIC'
  ) {
    return {
      coupon: resolved,
      applicable: unknown<boolean>('REQUIRES_USER_CONTEXT'),
      savings,
      reasonKey: `coupon.conditional.${resolved.eligibility.audience}`,
    };
  }

  // --- Verified and unconditional ----------------------------------------
  if (couponCountsTowardTotal(resolved.status) && resolved.eligibility.audience === 'ANY') {
    return {
      coupon: resolved,
      applicable: { state: 'KNOWN', value: true, provenance: derivedProvenance() },
      savings,
      reasonKey: 'coupon.applicable.verified',
    };
  }

  // Presentable but not verified: shown, not counted.
  return {
    coupon: resolved,
    applicable: unknown<boolean>('NOT_PROVIDED_BY_SOURCE'),
    savings,
    reasonKey: `coupon.unconfirmed.${resolved.status}`,
  };
}

/**
 * Picks the coupons to show on an offer. Sorted so the most trustworthy comes
 * first — not the largest discount, which would promote unverified codes above
 * verified ones.
 */
export function selectCouponsForOffer(
  coupons: ReadonlyArray<NormalizedCoupon>,
  offer: NormalizedOffer,
  context: { readonly countryCode: string; readonly limit?: number; readonly now?: Date },
): ReadonlyArray<AppliedCoupon> {
  const applied = coupons
    .map((coupon) => applyCouponToOffer(coupon, offer, context))
    .filter((entry) => couponIsPresentable(entry.coupon.status));

  const ranked = applied.sort((a, b) => {
    const trust = statusRank(a.coupon.status) - statusRank(b.coupon.status);
    if (trust !== 0) return trust;

    const certaintyA = isKnown(a.applicable) && a.applicable.value ? 0 : 1;
    const certaintyB = isKnown(b.applicable) && b.applicable.value ? 0 : 1;
    if (certaintyA !== certaintyB) return certaintyA - certaintyB;

    const savingsA = exactValue(a.savings)?.minor ?? 0;
    const savingsB = exactValue(b.savings)?.minor ?? 0;
    return savingsB - savingsA;
  });

  return ranked.slice(0, context.limit ?? 3);
}

function statusRank(status: CouponStatus): number {
  switch (status) {
    case 'VERIFIED':
      return 0;
    case 'RECENTLY_CHECKED':
      return 1;
    case 'POSSIBLY_ACTIVE':
      return 2;
    default:
      return 3;
  }
}

function derivedProvenance() {
  return {
    origin: 'DERIVED' as const,
    providerId: null,
    observedAt: new Date().toISOString(),
    policyRef: 'derived/coupon-eligibility',
  };
}

/**
 * Trust summary for the coupon card's popover: what we checked, when, and how.
 * Returns translation keys rather than prose so it localizes.
 */
export function couponTrustSummary(coupon: NormalizedCoupon): {
  readonly statusKey: string;
  readonly methodKey: string;
  readonly checkedAt: string | null;
  readonly conditionKeys: ReadonlyArray<string>;
} {
  const conditions: string[] = [];
  if (coupon.eligibility.audience !== 'ANY' && coupon.eligibility.audience !== 'UNKNOWN') {
    conditions.push(`coupon.condition.${coupon.eligibility.audience}`);
  }
  if (hasValueDatum(coupon.eligibility.minimumOrder)) {
    conditions.push('coupon.condition.minimumOrder');
  }
  if (coupon.eligibility.productIds.length > 0) {
    conditions.push('coupon.condition.specificProducts');
  }
  if (!isKnown(coupon.eligibility.stackable)) {
    conditions.push('coupon.condition.stackingUnknown');
  }

  return {
    statusKey: `coupon.status.${coupon.status}`,
    methodKey: `coupon.method.${coupon.verificationMethod}`,
    checkedAt: coupon.lastCheckedAt,
    conditionKeys: conditions,
  };
}

function hasValueDatum<T>(datum: Datum<T>): boolean {
  return datum.state === 'KNOWN' || datum.state === 'ESTIMATED';
}
