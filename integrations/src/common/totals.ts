import {
  type AppliedCoupon,
  type ConfidenceBand,
  type Datum,
  type Money,
  type TotalCostBreakdown,
  add,
  clampAtZero,
  comparableValue,
  confidenceOf,
  couponCountsTowardTotal,
  estimated,
  exactValue,
  hasValue,
  isKnown,
  money,
  subtract,
  unknown,
  weakestConfidence,
  zero,
} from '@shelf/shared';

/**
 * The total cost model.
 *
 * This is the function that decides whether the product is honest, because the
 * estimated total is the number people actually compare. Marketplace APIs give
 * you an item price and almost never give you a reliable destination shipping
 * cost or import tax, so the tempting move is to show the item price as the
 * total and let the user discover the rest at checkout.
 *
 * Instead:
 *   - Every component present and exact        -> KNOWN total.
 *   - Any component estimated, or shipping/tax absent but bounded -> ESTIMATED
 *     range, with the missing components named so the UI can say what is not
 *     included.
 *   - Item price itself unknown                -> UNKNOWN total. There is no
 *     meaningful total without a price, and a zero would render as free.
 *
 * Free shipping is only ever treated as zero when the provider *states* it.
 * An absent shipping field is not free shipping.
 */

export interface TotalCostInput {
  readonly itemPrice: Datum<Money>;
  readonly shippingCost: Datum<Money>;
  readonly shippingFree: Datum<boolean>;
  readonly tax: Datum<Money>;
  readonly referencePrice: Datum<Money>;
  readonly appliedCoupons: ReadonlyArray<AppliedCoupon>;
  readonly currency: string;
  readonly providerId: string;
  readonly observedAt: string;
}

export function buildTotalCost(input: TotalCostInput): TotalCostBreakdown {
  const currency = input.currency.toUpperCase();
  const missing: Array<'SHIPPING' | 'TAX' | 'DUTIES' | 'COUPON_ELIGIBILITY'> = [];

  const itemPrice = input.itemPrice;

  // --- Shipping ----------------------------------------------------------
  // Resolve to a concrete zero only on an explicit free-shipping statement.
  let shipping: Datum<Money> = input.shippingCost;
  if (!hasValue(shipping)) {
    if (isKnown(input.shippingFree) && input.shippingFree.value === true) {
      shipping = {
        state: 'KNOWN',
        value: zero(currency),
        provenance: input.shippingFree.provenance,
      };
    } else {
      missing.push('SHIPPING');
    }
  }

  // --- Tax ---------------------------------------------------------------
  const tax = input.tax;
  if (!hasValue(tax)) {
    missing.push('TAX');
    // Cross-border duty is not derivable from marketplace data; naming it
    // separately lets the UI say so rather than implying tax covers it.
    if (tax.state === 'UNKNOWN' && tax.reason === 'NOT_COMPUTABLE') missing.push('DUTIES');
  }

  // --- Discounts ---------------------------------------------------------
  const discount = computeStatedDiscount(itemPrice, input.referencePrice, currency);
  const couponDiscount = computeCouponDiscount(input.appliedCoupons, currency, input.providerId);
  if (input.appliedCoupons.some((applied) => !isKnown(applied.applicable))) {
    missing.push('COUPON_ELIGIBILITY');
  }

  // --- Total -------------------------------------------------------------
  const total = computeTotal({
    itemPrice,
    shipping,
    tax,
    couponDiscount,
    currency,
    providerId: input.providerId,
    missing,
  });

  const confidence: ConfidenceBand = weakestConfidence([
    confidenceOf(itemPrice),
    confidenceOf(shipping),
    confidenceOf(tax),
    confidenceOf(total),
  ]);

  return {
    itemPrice,
    shipping,
    tax,
    discount,
    couponDiscount,
    total,
    missingComponents: [...new Set(missing)],
    confidence,
  };
}

function computeTotal(args: {
  itemPrice: Datum<Money>;
  shipping: Datum<Money>;
  tax: Datum<Money>;
  couponDiscount: Datum<Money>;
  currency: string;
  providerId: string;
  missing: ReadonlyArray<string>;
}): Datum<Money> {
  const { itemPrice, shipping, tax, couponDiscount, currency, providerId } = args;

  // No price, no total. Returning zero here is how a comparison engine ends up
  // showing a free item.
  if (!hasValue(itemPrice)) {
    return unknown<Money>(
      itemPrice.state === 'RESTRICTED' ? 'NOT_PROVIDED_BY_SOURCE' : 'SOURCE_UNAVAILABLE',
      providerId,
    );
  }

  const itemLow = lowBound(itemPrice, currency);
  const itemHigh = highBound(itemPrice, currency);
  if (!itemLow || !itemHigh) return unknown<Money>('SOURCE_VALUE_INVALID', providerId);

  const shippingLow = hasValue(shipping) ? lowBound(shipping, currency) : zero(currency);
  const shippingHigh = hasValue(shipping) ? highBound(shipping, currency) : null;

  const taxLow = hasValue(tax) ? lowBound(tax, currency) : zero(currency);
  const taxHigh = hasValue(tax) ? highBound(tax, currency) : null;

  const couponLow = hasValue(couponDiscount) ? lowBound(couponDiscount, currency) : zero(currency);

  const allExact =
    isKnown(itemPrice) &&
    isKnown(shipping) &&
    isKnown(tax) &&
    (couponDiscount.state === 'KNOWN' || !hasValue(couponDiscount));

  if (allExact && shippingHigh && taxHigh) {
    const exact = clampAtZero(
      subtract(add(add(itemHigh, shippingHigh), taxHigh), couponLow ?? zero(currency)),
    );
    return {
      state: 'KNOWN',
      value: exact,
      provenance: {
        origin: 'DERIVED',
        providerId: null,
        observedAt: oldestObserved([itemPrice, shipping, tax]) ?? new Date().toISOString(),
        policyRef: 'derived/total-cost',
      },
      confidence: 'HIGH',
    };
  }

  // A range. The low bound assumes the unknown components are zero; the high
  // bound is only meaningful when we have an upper estimate for them, so when
  // shipping or tax is entirely unknown the range is open at the top and we
  // report the total as not available rather than inventing a ceiling.
  if (!shippingHigh || !taxHigh) {
    return unknown<Money>('NOT_COMPUTABLE', providerId);
  }

  const low = clampAtZero(
    subtract(add(add(itemLow, shippingLow ?? zero(currency)), taxLow ?? zero(currency)), couponLow ?? zero(currency)),
  );
  const high = clampAtZero(subtract(add(add(itemHigh, shippingHigh), taxHigh), couponLow ?? zero(currency)));

  return estimated<Money>(
    {
      low,
      high,
      basis: args.missing.includes('SHIPPING')
        ? 'SHIPPING_NOT_PROVIDED_BY_SOURCE'
        : args.missing.includes('TAX')
          ? 'TAX_ESTIMATED_FROM_DESTINATION_RATE'
          : 'COMPONENT_ESTIMATED',
      confidence: args.missing.length > 1 ? 'LOW' : 'MEDIUM',
    },
    {
      origin: 'DERIVED',
      providerId: null,
      observedAt: oldestObserved([itemPrice, shipping, tax]) ?? new Date().toISOString(),
      policyRef: 'derived/total-cost',
    },
  );
}

/**
 * A stated discount, and only a stated one. We compute it from the provider's
 * own reference price where the `referencePrice` capability permits it. We
 * never reconstruct a "was" price from our own observation history and present
 * it as the retailer's list price (rules 154, 155).
 */
function computeStatedDiscount(
  itemPrice: Datum<Money>,
  referencePrice: Datum<Money>,
  currency: string,
): Datum<Money> {
  const current = exactValue(itemPrice);
  const reference = exactValue(referencePrice);
  if (!current || !reference) {
    return unknown<Money>('NOT_PROVIDED_BY_SOURCE');
  }
  if (reference.currency !== current.currency || reference.minor <= current.minor) {
    // A reference price at or below the current price is not a discount. Some
    // sellers set it to the same value; presenting that as "0% off" is noise.
    return unknown<Money>('SOURCE_VALUE_INVALID');
  }
  return {
    state: 'KNOWN',
    value: subtract(reference, current),
    provenance: {
      origin: 'DERIVED',
      providerId: null,
      observedAt: new Date().toISOString(),
      policyRef: 'derived/stated-discount',
    },
  };
}

/**
 * Coupon savings count toward a total only for VERIFIED codes whose
 * applicability to this offer is itself KNOWN. A code that merely might work
 * is displayed as available but never deducted — otherwise the headline total
 * is a discount the shopper may not receive.
 */
function computeCouponDiscount(
  applied: ReadonlyArray<AppliedCoupon>,
  currency: string,
  providerId: string,
): Datum<Money> {
  const countable = applied.filter(
    (entry) =>
      couponCountsTowardTotal(entry.coupon.status) &&
      isKnown(entry.applicable) &&
      entry.applicable.value === true &&
      isKnown(entry.savings),
  );

  if (countable.length === 0) {
    return applied.length === 0
      ? unknown<Money>('NOT_PROVIDED_BY_SOURCE', providerId)
      : unknown<Money>('REQUIRES_USER_CONTEXT', providerId);
  }

  // Without a provider statement that codes stack, only the single best one is
  // counted. Summing unstackable coupons would overstate the saving.
  const stackable = countable.filter(
    (entry) => isKnown(entry.coupon.eligibility.stackable) && entry.coupon.eligibility.stackable.value,
  );

  const chosen =
    stackable.length > 1
      ? stackable
      : [
          countable.reduce((best, entry) => {
            const bestValue = exactValue(best.savings)?.minor ?? 0;
            const entryValue = exactValue(entry.savings)?.minor ?? 0;
            return entryValue > bestValue ? entry : best;
          }),
        ];

  let total = zero(currency);
  for (const entry of chosen) {
    const savings = exactValue(entry.savings);
    if (savings && savings.currency === currency) total = add(total, savings);
  }

  return {
    state: 'KNOWN',
    value: total,
    provenance: {
      origin: 'DERIVED',
      providerId: null,
      observedAt: new Date().toISOString(),
      policyRef: 'derived/coupon-savings',
    },
  };
}

function lowBound(datum: Datum<Money>, currency: string): Money | null {
  if (datum.state === 'KNOWN') return datum.value;
  if (datum.state === 'ESTIMATED') return datum.estimate.low;
  return currency ? zero(currency) : null;
}

function highBound(datum: Datum<Money>, _currency: string): Money | null {
  if (datum.state === 'KNOWN') return datum.value;
  if (datum.state === 'ESTIMATED') return datum.estimate.high;
  return null;
}

function oldestObserved(datums: ReadonlyArray<Datum<unknown>>): string | undefined {
  let oldest: string | undefined;
  for (const datum of datums) {
    const at =
      datum.state === 'KNOWN' || datum.state === 'ESTIMATED'
        ? datum.provenance.observedAt
        : undefined;
    if (at && (oldest === undefined || at < oldest)) oldest = at;
  }
  return oldest;
}

/**
 * Converts a percentage or fixed-amount coupon into a savings figure against a
 * specific item price. Returns UNKNOWN when the price is not known, because a
 * percentage of an unknown number is not a number.
 */
export function couponSavingsFor(
  coupon: {
    readonly discountType: string;
    readonly discountPercent: Datum<number>;
    readonly discountAmount: Datum<Money>;
  },
  itemPrice: Datum<Money>,
  currency: string,
): Datum<Money> {
  const price = exactValue(itemPrice);

  if (coupon.discountType === 'FIXED_AMOUNT') {
    const amount = exactValue(coupon.discountAmount);
    if (!amount) return unknown<Money>('NOT_PROVIDED_BY_SOURCE');
    if (amount.currency !== currency) return unknown<Money>('REQUIRES_USER_CONTEXT');
    // A fixed discount cannot exceed the price.
    const capped = price && amount.minor > price.minor ? price : amount;
    return {
      state: 'KNOWN',
      value: capped,
      provenance: {
        origin: 'DERIVED',
        providerId: null,
        observedAt: new Date().toISOString(),
        policyRef: 'derived/coupon-fixed',
      },
    };
  }

  if (coupon.discountType === 'PERCENTAGE') {
    const percent = exactValue(coupon.discountPercent);
    if (percent === undefined || !price) return unknown<Money>('REQUIRES_USER_CONTEXT');
    if (percent <= 0 || percent > 100) return unknown<Money>('SOURCE_VALUE_INVALID');
    return {
      state: 'KNOWN',
      value: money(Math.round((price.minor * percent) / 100), price.currency),
      provenance: {
        origin: 'DERIVED',
        providerId: null,
        observedAt: new Date().toISOString(),
        policyRef: 'derived/coupon-percentage',
      },
    };
  }

  // FREE_SHIPPING, TIERED and BUNDLE need information the APIs do not give us
  // (the actual shipping quote, the basket contents, the bundle rules), so the
  // saving is reported as requiring context rather than guessed at.
  return unknown<Money>('REQUIRES_USER_CONTEXT');
}

/** Ranking value for a total: midpoint of an estimate, exact when known. */
export function totalForRanking(total: Datum<Money>): number | undefined {
  if (total.state === 'KNOWN') return total.value.minor;
  if (total.state === 'ESTIMATED') {
    return comparableValue({
      state: 'ESTIMATED',
      estimate: {
        low: total.estimate.low.minor,
        high: total.estimate.high.minor,
        basis: total.estimate.basis,
        confidence: total.estimate.confidence,
      },
      provenance: total.provenance,
    });
  }
  return undefined;
}
