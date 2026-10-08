import {
  type Deal,
  type DealEvidence,
  type DealKind,
  type Money,
  type NormalizedCoupon,
  type NormalizedOffer,
  type PriceStatistics,
  type ProductGroup,
  couponCountsTowardTotal,
  exactValue,
  isKnown,
  money,
  newId,
  subtract,
  unknown,
} from '@shelf/shared';

/**
 * Deal Hunter.
 *
 * Finds buying opportunities and — more importantly — declines to invent them.
 * Every deal carries the evidence that makes it one, and each evidence kind
 * names what it rests on, so the card can say "price dropped 18% since we
 * started watching" rather than a generic "HOT DEAL".
 *
 * What is deliberately absent:
 *
 *   - No urgency we cannot substantiate. `endsAt` is populated only from a
 *     provider-stated end time; there is no synthetic countdown and no
 *     "only 2 left" (rules 96, 97).
 *   - No discount computed against a price we invented. A stated discount
 *     needs the provider's own reference price; a historical comparison needs
 *     retained observations, which only exist where that provider's policy
 *     permits retention. So the feed is genuinely thinner for sources where we
 *     may not keep a price history, and that is the correct behaviour rather
 *     than a gap to fill with estimates.
 */

export interface HuntInput {
  readonly group: ProductGroup;
  readonly countryCode: string;
  /** Retained statistics, when this provider permits a price history. */
  readonly statistics?: ReadonlyMap<string, PriceStatistics>;
  readonly coupons?: ReadonlyMap<string, ReadonlyArray<NormalizedCoupon>>;
}

/** Minimum saving that counts as a deal rather than noise, in minor units. */
const MATERIAL_SAVING_MINOR = 300;
/** Minimum proportional saving for a cross-source gap to be worth surfacing. */
const MATERIAL_GAP_RATIO = 0.12;

export function huntDeals(input: HuntInput): Deal | null {
  const evidence: DealEvidence[] = [];
  let endsAt: Deal['endsAt'] = unknown<string>('NOT_PROVIDED_BY_SOURCE');
  let bestCoupon: NormalizedCoupon | null = null;
  let providerId = input.group.providerIds[0] ?? '';

  for (const offering of input.group.offerings) {
    const offer = offering.offer;

    // --- Provider-stated discount ----------------------------------------
    const stated = statedDiscount(offer);
    if (stated) {
      evidence.push(stated);
      providerId = offering.providerId;
    }

    // --- History-based evidence ------------------------------------------
    const statistics = input.statistics?.get(statisticsKey(offer));
    if (statistics && statistics.sampleCount >= 5) {
      const drop = priceDrop(offer, statistics);
      if (drop) {
        evidence.push(drop);
        providerId = offering.providerId;
      }
      const low = relativeLow(offer, statistics);
      if (low) {
        evidence.push(low);
        providerId = offering.providerId;
      }
    }

    // --- Coupons ----------------------------------------------------------
    const coupons = input.coupons?.get(offering.providerId) ?? [];
    for (const coupon of coupons) {
      if (!couponCountsTowardTotal(coupon.status)) continue;
      const applied = offer.appliedCoupons.find(
        (entry) => entry.coupon.couponId === coupon.couponId,
      );
      const savings = applied?.savings;
      if (!savings || !isKnown(savings)) continue;
      if (savings.value.minor < MATERIAL_SAVING_MINOR) continue;

      bestCoupon = coupon;
      providerId = offering.providerId;

      evidence.push({
        kind: stated ? 'COUPON_PLUS_DISCOUNT' : 'VERIFIED_COUPON_AVAILABLE',
        messageKey: stated ? 'deal.kind.COUPON_PLUS_DISCOUNT' : 'deal.kind.VERIFIED_COUPON_AVAILABLE',
        savings,
        basis: coupon.code,
      });

      // Only a provider-stated expiry becomes an end time.
      if (coupon.expiresAt.state === 'KNOWN') endsAt = coupon.expiresAt;
    }
  }

  // --- Cross-source gap ---------------------------------------------------
  // Only for groups where identity is identifier-backed; a price gap between
  // two merely-similar products is not a deal, it is two products.
  if (input.group.comparableAcrossSources) {
    const gap = crossSourceGap(input.group);
    if (gap) {
      evidence.push(gap.evidence);
      providerId = gap.cheapestProviderId;
    }
  }

  if (evidence.length === 0) return null;

  const strength = computeStrength(evidence, input.group);

  return {
    dealId: newId('deal'),
    providerId,
    productGroupId: input.group.groupId,
    group: input.group,
    evidence,
    strength,
    band: strength >= 0.7 ? 'HIGH' : strength >= 0.45 ? 'MEDIUM' : 'LOW',
    coupon: bestCoupon,
    endsAt,
    firstSeenAt: new Date().toISOString(),
    lastConfirmedAt: new Date().toISOString(),
    containsDemoData: groupContainsDemoData(input.group),
  };
}

/**
 * A discount the provider itself states, computed from its own reference
 * price. Never reconstructed from our observations and presented as the
 * retailer's list price (rules 154, 155).
 */
function statedDiscount(offer: NormalizedOffer): DealEvidence | null {
  const discount = offer.totalCost.discount;
  if (!isKnown(discount)) return null;
  if (discount.value.minor < MATERIAL_SAVING_MINOR) return null;

  const price = exactValue(offer.price);
  if (!price) return null;

  const reference = price.minor + discount.value.minor;
  const ratio = discount.value.minor / reference;
  // A marketplace "discount" against an inflated reference price is common,
  // so a stated discount above 80% is treated as not credible evidence rather
  // than as the best deal on the site.
  if (ratio > 0.8) return null;

  return {
    kind: 'PROVIDER_STATED_DISCOUNT',
    messageKey: 'deal.kind.PROVIDER_STATED_DISCOUNT',
    savings: discount,
    basis: 'provider_reference_price',
  };
}

function priceDrop(offer: NormalizedOffer, statistics: PriceStatistics): DealEvidence | null {
  const current = exactValue(offer.price);
  const median = statistics.median;
  if (!current || !median || median.currency !== current.currency) return null;
  if (current.minor >= median.minor) return null;

  const savings = subtract(median, current);
  if (savings.minor < MATERIAL_SAVING_MINOR) return null;

  return {
    kind: 'PRICE_DROP_OBSERVED',
    messageKey: 'deal.kind.PRICE_DROP_OBSERVED',
    savings: {
      state: 'KNOWN',
      value: savings,
      provenance: {
        origin: 'DERIVED',
        providerId: offer.providerId,
        observedAt: offer.observedAt,
        policyRef: 'derived/price-drop',
      },
    },
    basis: `median_of_${statistics.sampleCount}_observations`,
  };
}

function relativeLow(offer: NormalizedOffer, statistics: PriceStatistics): DealEvidence | null {
  if (statistics.currentPercentile === null) return null;
  // Bottom decile of the retained window.
  if (statistics.currentPercentile > 10) return null;

  const current = exactValue(offer.price);
  const highest = statistics.highest;
  if (!current || !highest || highest.currency !== current.currency) return null;

  return {
    kind: 'LOW_RELATIVE_TO_HISTORY',
    messageKey: 'deal.kind.LOW_RELATIVE_TO_HISTORY',
    savings: {
      state: 'KNOWN',
      value: subtract(highest, current),
      provenance: {
        origin: 'DERIVED',
        providerId: offer.providerId,
        observedAt: offer.observedAt,
        policyRef: 'derived/relative-low',
      },
    },
    basis: `percentile_${statistics.currentPercentile}`,
  };
}

/**
 * A material price gap for the same identifier-backed product across sources.
 *
 * Compares total cost where both are known, and falls back to item price only
 * when neither total is available — flagging that in the basis, so the card
 * can say the comparison excludes shipping.
 */
function crossSourceGap(
  group: ProductGroup,
): { readonly evidence: DealEvidence; readonly cheapestProviderId: string } | null {
  const comparable = group.offerings
    .map((offering) => {
      const total = offering.offer.totalCost.total;
      const totalMinor = isKnown(total) ? total.value.minor : null;
      const itemMinor = exactValue(offering.offer.price)?.minor ?? null;
      const currency =
        (isKnown(total) ? total.value.currency : undefined) ??
        exactValue(offering.offer.price)?.currency;
      return { providerId: offering.providerId, totalMinor, itemMinor, currency };
    })
    .filter((entry) => entry.currency !== undefined);

  if (comparable.length < 2) return null;

  const currency = comparable[0]?.currency;
  if (!currency || comparable.some((entry) => entry.currency !== currency)) return null;

  const useTotals = comparable.every((entry) => entry.totalMinor !== null);
  const values = comparable
    .map((entry) => ({
      providerId: entry.providerId,
      minor: useTotals ? (entry.totalMinor as number) : entry.itemMinor,
    }))
    .filter((entry): entry is { providerId: string; minor: number } => entry.minor !== null);

  if (values.length < 2) return null;

  const sorted = [...values].sort((a, b) => a.minor - b.minor);
  const cheapest = sorted[0];
  const dearest = sorted[sorted.length - 1];
  if (!cheapest || !dearest || dearest.minor <= 0) return null;

  const gap = dearest.minor - cheapest.minor;
  if (gap < MATERIAL_SAVING_MINOR) return null;
  if (gap / dearest.minor < MATERIAL_GAP_RATIO) return null;

  return {
    cheapestProviderId: cheapest.providerId,
    evidence: {
      kind: 'CROSS_SOURCE_GAP',
      messageKey: 'deal.kind.CROSS_SOURCE_GAP',
      savings: {
        state: 'KNOWN',
        value: money(gap, currency),
        provenance: {
          origin: 'DERIVED',
          providerId: null,
          observedAt: new Date().toISOString(),
          policyRef: 'derived/cross-source-gap',
        },
      },
      // Named so the UI can say whether shipping is included in the gap.
      basis: useTotals ? 'estimated_total_comparison' : 'item_price_comparison_excluding_shipping',
    },
  };
}

/**
 * Deal strength.
 *
 * Weighted by how well-founded the evidence is, not by how large the number
 * looks. A verified coupon and an observed price drop outrank a seller's own
 * claimed discount, because the first two rest on something we checked.
 */
function computeStrength(
  evidence: ReadonlyArray<DealEvidence>,
  group: ProductGroup,
): number {
  const weights: Record<DealKind, number> = {
    VERIFIED_COUPON_AVAILABLE: 0.3,
    COUPON_PLUS_DISCOUNT: 0.35,
    PRICE_DROP_OBSERVED: 0.3,
    LOW_RELATIVE_TO_HISTORY: 0.25,
    CROSS_SOURCE_GAP: 0.25,
    PROVIDER_STATED_DISCOUNT: 0.12,
    TIME_LIMITED_PROMOTION: 0.08,
  };

  let score = 0;
  const seen = new Set<DealKind>();
  for (const entry of evidence) {
    if (seen.has(entry.kind)) continue;
    seen.add(entry.kind);
    score += weights[entry.kind];
  }

  // An identifier-backed product is a more trustworthy deal than an anonymous
  // listing, because we can say what it actually is.
  if (group.identifiers.gtin) score += 0.1;
  if (group.comparableAcrossSources) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

function statisticsKey(offer: NormalizedOffer): string {
  return `${offer.providerId}|${offer.providerProductId}|${offer.providerVariantId ?? ''}`;
}

function groupContainsDemoData(group: ProductGroup): boolean {
  return group.offerings.some((offering) => {
    const price = offering.offer.price;
    const provenance =
      price.state === 'KNOWN' || price.state === 'ESTIMATED' ? price.provenance : undefined;
    return provenance?.origin === 'DEMO_FIXTURE';
  });
}

/** Total quantified saving across a deal's evidence, for sorting a feed. */
export function totalSaving(deal: Deal): Money | null {
  let total: Money | null = null;
  for (const entry of deal.evidence) {
    if (!isKnown(entry.savings)) continue;
    if (!total) {
      total = entry.savings.value;
      continue;
    }
    if (total.currency !== entry.savings.value.currency) continue;
    // Max rather than sum: two evidence kinds often describe the same saving
    // from different angles, and adding them would double-count it.
    total = entry.savings.value.minor > total.minor ? entry.savings.value : total;
  }
  return total;
}
