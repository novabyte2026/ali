import {
  type AppliedCoupon,
  type Datum,
  type Money,
  type NormalizedOffer,
  type TotalCostBreakdown,
  countryConfig,
  estimated,
  exactValue,
  hasValue,
  isKnown,
  minorUnitFactor,
  money,
  scale,
  unknown,
} from '@shelf/shared';
import { buildTotalCost } from '@shelf/integrations';
import type { CurrencyConverter } from './currency.js';
import type { ProviderGuard } from '../compliance/guard.js';

/**
 * Price intelligence.
 *
 * Takes an offer as the adapter mapped it and produces the figures a user
 * actually decides on, in the currency they asked for, with every derivation
 * labelled. The engine's only real job is to resist the pressure to turn an
 * unknown into a number.
 *
 * What it adds on top of the adapter's own total:
 *   - conversion to the requested currency, via a dated rate;
 *   - a destination VAT estimate where a configured rate makes one defensible,
 *     always as a range and never as the final cost;
 *   - coupon application, counting only verified codes;
 *   - an explicit list of what is missing, so the UI can say so.
 */

export interface PriceContext {
  readonly targetCurrency: string;
  readonly countryCode: string;
  readonly guard: ProviderGuard;
  readonly converter: CurrencyConverter;
  /** Coupons already matched to this offer by the coupon engine. */
  readonly appliedCoupons: ReadonlyArray<AppliedCoupon>;
}

export async function priceOffer(
  offer: NormalizedOffer,
  ctx: PriceContext,
): Promise<NormalizedOffer> {
  const currency = ctx.targetCurrency.toUpperCase();

  const price = await ctx.converter.convert(offer.price, currency);
  const referencePrice = await ctx.converter.convert(offer.referencePrice, currency);
  const shippingCost = await ctx.converter.convert(offer.shipping.cost, currency);

  const taxable = firstFigure(price);
  const tax = estimateTax({
    itemPrice: price,
    shipping: shippingCost,
    countryCode: ctx.countryCode,
    currency,
    providerId: offer.providerId,
    taxIncluded: offer.tax.includedInItemPrice,
    taxableMinor: taxable,
  });

  const coupons = await Promise.all(
    ctx.appliedCoupons.map(async (applied) => ({
      ...applied,
      savings: await ctx.converter.convert(applied.savings, currency),
    })),
  );

  const totalCost: TotalCostBreakdown = buildTotalCost({
    itemPrice: price,
    shippingCost,
    shippingFree: offer.shipping.free,
    tax: tax.amount,
    referencePrice,
    appliedCoupons: coupons,
    currency,
    providerId: offer.providerId,
    observedAt: offer.observedAt,
  });

  return {
    ...offer,
    price,
    referencePrice,
    currency,
    shipping: { ...offer.shipping, cost: shippingCost },
    tax,
    appliedCoupons: coupons,
    totalCost,
  };
}

/**
 * Destination tax.
 *
 * This is where most comparison tools quietly mislead people on a
 * cross-border order. The honest position:
 *
 *   - If the provider says tax is included in the price, there is nothing to
 *     add and we say so.
 *   - If the destination has a configured consumption-tax rate and the order
 *     value is above the local de-minimis threshold, we produce an ESTIMATED
 *     range from that rate and label it as an estimate from the destination
 *     rate. It is a defensible approximation of VAT.
 *   - We never estimate import duty, carrier handling fees or customs
 *     brokerage. Those depend on commodity code, origin and carrier, and a
 *     guess would be worse than silence. They are reported as not computable,
 *     and the UI lists duties among the missing components.
 */
export function estimateTax(args: {
  readonly itemPrice: Datum<Money>;
  readonly shipping: Datum<Money>;
  readonly countryCode: string;
  readonly currency: string;
  readonly providerId: string;
  readonly taxIncluded: Datum<boolean>;
  readonly taxableMinor: number | null;
}): NormalizedOffer['tax'] {
  const destination = args.countryCode.toUpperCase();
  const base = {
    includedInItemPrice: args.taxIncluded,
    destinationCountry: destination,
  };

  if (isKnown(args.taxIncluded) && args.taxIncluded.value) {
    return {
      ...base,
      amount: {
        state: 'KNOWN',
        value: money(0, args.currency),
        provenance: args.taxIncluded.provenance,
      },
      appliedRate: 0,
    };
  }

  const country = countryConfig(destination);
  const rate = country?.vatRate ?? null;

  if (rate === null || args.taxableMinor === null) {
    return {
      ...base,
      amount: unknown<Money>('NOT_COMPUTABLE', args.providerId),
      appliedRate: null,
    };
  }

  // Below the local de-minimis import threshold, consumption tax is typically
  // not collected. We state that as zero only where the threshold is defined;
  // otherwise it stays an estimate.
  const threshold = country?.importVatThresholdMinor ?? null;
  if (threshold !== null && threshold > 0 && args.taxableMinor < threshold) {
    return {
      ...base,
      amount: estimated<Money>(
        {
          low: money(0, args.currency),
          high: money(0, args.currency),
          basis: 'BELOW_DESTINATION_IMPORT_THRESHOLD',
          confidence: 'MEDIUM',
        },
        {
          origin: 'DERIVED',
          providerId: null,
          observedAt: new Date().toISOString(),
          policyRef: 'derived/tax-threshold',
        },
      ),
      appliedRate: 0,
    };
  }

  const shippingMinor = firstFigure(args.shipping) ?? 0;
  const taxableTotal = args.taxableMinor + shippingMinor;
  const estimate = Math.round(taxableTotal * rate);

  // A range rather than a point: whether shipping is taxable, and how the
  // carrier assesses it, varies. The spread is deliberately visible.
  return {
    ...base,
    amount: estimated<Money>(
      {
        low: money(Math.round(args.taxableMinor * rate), args.currency),
        high: money(estimate, args.currency),
        basis: 'DESTINATION_VAT_RATE_ESTIMATE',
        confidence: 'LOW',
      },
      {
        origin: 'DERIVED',
        providerId: null,
        observedAt: new Date().toISOString(),
        policyRef: 'derived/tax-estimate',
      },
    ),
    appliedRate: rate,
  };
}

function firstFigure(datum: Datum<Money>): number | null {
  if (datum.state === 'KNOWN') return datum.value.minor;
  if (datum.state === 'ESTIMATED') return datum.estimate.low.minor;
  return null;
}

/**
 * Comparison across providers for one product identity.
 *
 * The important behaviour is what it refuses to say. Given:
 *   Amazon      $110.00  shipping stated free
 *   Temu         $80.00  shipping $45.00
 *   AliExpress   $72.00  shipping unknown, duties unknown
 *
 * it does not declare AliExpress cheapest. It reports that AliExpress has the
 * lowest *item* price, that Amazon has the lowest known *total*, and that
 * AliExpress's total cannot be determined — which is the information someone
 * needs to actually decide (rule 28).
 */
export interface ComparisonVerdict {
  readonly lowestItemPriceProviderId: string | null;
  /** Lowest total among offers whose total is known or estimated. */
  readonly lowestComparableTotalProviderId: string | null;
  /** Providers whose total cannot be determined at all. */
  readonly incomparableProviderIds: ReadonlyArray<string>;
  /**
   * True only when every offer has a KNOWN total in the same currency. Only
   * then may the UI call one of them cheapest without qualification.
   */
  readonly totalsFullyComparable: boolean;
  readonly currency: string;
  /** Savings between the best and worst comparable total, when meaningful. */
  readonly spread: Datum<Money>;
}

export function compareOffers(
  offers: ReadonlyArray<NormalizedOffer>,
  currency: string,
): ComparisonVerdict {
  const target = currency.toUpperCase();

  let lowestItem: { providerId: string; minor: number } | null = null;
  let lowestTotal: { providerId: string; minor: number } | null = null;
  let highestTotal: { providerId: string; minor: number } | null = null;
  const incomparable: string[] = [];
  let allTotalsKnown = offers.length > 0;

  for (const offer of offers) {
    const itemMinor = firstFigure(offer.price);
    if (itemMinor !== null && offer.currency.toUpperCase() === target) {
      if (!lowestItem || itemMinor < lowestItem.minor) {
        lowestItem = { providerId: offer.providerId, minor: itemMinor };
      }
    }

    const total = offer.totalCost.total;
    if (!hasValue(total)) {
      incomparable.push(offer.providerId);
      allTotalsKnown = false;
      continue;
    }
    if (!isKnown(total)) allTotalsKnown = false;

    // Rank an estimate on its midpoint, but never display that midpoint.
    const totalMinor =
      total.state === 'KNOWN'
        ? total.value.minor
        : total.state === 'ESTIMATED'
          ? Math.round((total.estimate.low.minor + total.estimate.high.minor) / 2)
          : null;
    if (totalMinor === null) continue;

    if (!lowestTotal || totalMinor < lowestTotal.minor) {
      lowestTotal = { providerId: offer.providerId, minor: totalMinor };
    }
    if (!highestTotal || totalMinor > highestTotal.minor) {
      highestTotal = { providerId: offer.providerId, minor: totalMinor };
    }
  }

  const spread: Datum<Money> =
    allTotalsKnown && lowestTotal && highestTotal && highestTotal.minor > lowestTotal.minor
      ? {
          state: 'KNOWN',
          value: money(highestTotal.minor - lowestTotal.minor, target),
          provenance: {
            origin: 'DERIVED',
            providerId: null,
            observedAt: new Date().toISOString(),
            policyRef: 'derived/comparison-spread',
          },
        }
      : unknown<Money>(incomparable.length > 0 ? 'NOT_COMPUTABLE' : 'NOT_PROVIDED_BY_SOURCE');

  return {
    lowestItemPriceProviderId: lowestItem?.providerId ?? null,
    lowestComparableTotalProviderId: lowestTotal?.providerId ?? null,
    incomparableProviderIds: incomparable,
    totalsFullyComparable: allTotalsKnown && incomparable.length === 0,
    currency: target,
    spread,
  };
}

/**
 * Relation of a price to the user's stated budget.
 *
 * `CHEAPER_THAN_BUDGET` is a distinct answer from `WITHIN_BUDGET` because the
 * ranking layer treats them differently: being far under a stated budget is
 * not a merit on its own, and a ₪12 item is not a better answer to
 * "headphones up to ₪120" than a ₪110 one (rule 9).
 */
export function budgetRelation(
  price: Datum<Money>,
  budgetMax: Money | undefined,
  budgetMin: Money | undefined,
): 'WITHIN_BUDGET' | 'CHEAPER_THAN_BUDGET' | 'ABOVE_BUDGET' | 'BUDGET_NOT_STATED' | 'PRICE_UNKNOWN' {
  if (!budgetMax && !budgetMin) return 'BUDGET_NOT_STATED';

  const minor = firstFigure(price);
  if (minor === null) return 'PRICE_UNKNOWN';

  const currency = exactValue(price)?.currency ?? budgetMax?.currency ?? budgetMin?.currency;
  if (budgetMax && currency === budgetMax.currency && minor > budgetMax.minor) {
    return 'ABOVE_BUDGET';
  }
  if (budgetMin && currency === budgetMin.currency && minor < budgetMin.minor) {
    return 'CHEAPER_THAN_BUDGET';
  }

  // Materially below a stated ceiling. The 45% line is a judgement call: it is
  // low enough that a genuine bargain still reads as in-budget, and high
  // enough that a $4 result for a $120 search is flagged as a different class
  // of product rather than a great deal.
  if (budgetMax && currency === budgetMax.currency && minor < budgetMax.minor * 0.45) {
    return 'CHEAPER_THAN_BUDGET';
  }

  return 'WITHIN_BUDGET';
}

/** Applies a percentage to a money value for a labelled estimate. */
export function applyRateToMoney(value: Money, rate: number): Money {
  return scale(value, rate);
}

/** Decimal amount of a Money, for a chart axis or an export. */
export function toDecimalAmount(value: Money): number {
  return value.minor / minorUnitFactor(value.currency);
}
