import {
  type BudgetRelation,
  type ProductGroup,
  type QueryIntent,
  type RelevanceExplanation,
  type SearchFilters,
  type SearchResultItem,
  type SortOption,
  assertsSameProduct,
  comparableValue,
  exactValue,
  freshness,
  hasValue,
  isKnown,
  tokenSimilarity,
} from '@shelf/shared';
import { budgetRelation } from '../pricing/engine.js';
import { groupMatchLevel, pickPrimaryProvider } from '../products/grouping.js';

/**
 * Ranking.
 *
 * Two things govern this file.
 *
 * The first is rule 9, which is the single most important behaviour in the
 * product. Someone who types "headphones up to ₪120" does not want a wall of
 * ₪12 earbuds that happen to be under the ceiling. A stated budget is a
 * *target*, not just a cap, so proximity to it is scored and being wildly
 * under it earns nothing. A ₪110 pair that matches the request outranks a ₪12
 * pair that merely satisfies the arithmetic.
 *
 * The second is rule 61/62/144: commission is not an input. There is no
 * parameter, field or lookup in this module that reads a commission rate, and
 * none of the data structures it receives carries one. That is deliberate and
 * is asserted by a unit test, because the cheapest way to destroy a comparison
 * product's value is to quietly sell the top slot.
 */

export interface RankingContext {
  readonly intent: QueryIntent;
  readonly filters: SearchFilters;
  readonly sort: SortOption;
  readonly now: Date;
  /** Reliability weight per provider, from observed success rate, 0..1. */
  readonly providerReliability: ReadonlyMap<string, number>;
}

/** Score component weights. They sum to 1 for a readable total. */
const WEIGHTS = {
  intentMatch: 0.3,
  budgetFit: 0.22,
  productIdentity: 0.18,
  quality: 0.12,
  dataCompleteness: 0.1,
  freshness: 0.05,
  sourceReliability: 0.03,
} as const;

export function rankGroups(
  groups: ReadonlyArray<ProductGroup>,
  ctx: RankingContext,
): ReadonlyArray<SearchResultItem> {
  const items = groups.map((group) => scoreGroup(group, ctx));
  return sortItems(items, ctx.sort);
}

function scoreGroup(group: ProductGroup, ctx: RankingContext): SearchResultItem {
  const primaryProviderId = pickPrimaryProvider(group);
  const primary =
    group.offerings.find((offering) => offering.providerId === primaryProviderId) ??
    group.offerings[0];

  const explanations: RelevanceExplanation[] = [];
  const matchLevel = groupMatchLevel(group);

  // --- Intent match -------------------------------------------------------
  const intentScore = scoreIntentMatch(group, ctx.intent, explanations);

  // --- Budget fit ---------------------------------------------------------
  const price = primary?.offer.price;
  const relation: BudgetRelation = price
    ? budgetRelation(price, ctx.intent.budgetMax, ctx.intent.budgetMin)
    : 'PRICE_UNKNOWN';
  const budgetScore = scoreBudgetFit(group, ctx.intent, relation, explanations);

  // --- Product identity ---------------------------------------------------
  let identityScore = 0;
  if (assertsSameProduct(matchLevel)) {
    identityScore = 1;
    if (group.providerIds.length > 1 && group.comparableAcrossSources) {
      explanations.push({ key: 'relevance.comparableAcrossSources' });
    }
  } else if (matchLevel === 'VARIANT_MATCH') {
    identityScore = 0.6;
    explanations.push({ key: 'relevance.variantDiffers' });
  } else if (matchLevel === 'STRONG_SIMILARITY') {
    identityScore = 0.45;
  } else if (matchLevel === 'ALTERNATIVE') {
    identityScore = 0.25;
  }
  // An identifier-backed listing is more trustworthy than an anonymous one,
  // independent of how it matched.
  if (group.identifiers.gtin) identityScore = Math.min(1, identityScore + 0.15);

  // --- Quality ------------------------------------------------------------
  const qualityScore = scoreQuality(group, explanations);

  // --- Data completeness --------------------------------------------------
  // A listing whose total cost we can actually state is more useful than one
  // we can only partially describe. This rewards complete data rather than
  // rewarding any particular source.
  const completenessScore = scoreCompleteness(group);

  // --- Freshness ----------------------------------------------------------
  const freshnessScore = scoreFreshness(group, ctx.now);

  // --- Source reliability -------------------------------------------------
  const reliabilityScore =
    ctx.providerReliability.get(primaryProviderId) ?? 0.8;

  const relevanceScore = clamp01(
    intentScore * WEIGHTS.intentMatch +
      budgetScore * WEIGHTS.budgetFit +
      identityScore * WEIGHTS.productIdentity +
      qualityScore * WEIGHTS.quality +
      completenessScore * WEIGHTS.dataCompleteness +
      freshnessScore * WEIGHTS.freshness +
      reliabilityScore * WEIGHTS.sourceReliability,
  );

  if (ctx.intent.requestedProviderIds.includes(primaryProviderId)) {
    explanations.push({ key: 'relevance.sourceYouAskedFor', detail: primaryProviderId });
  }

  return {
    group,
    primaryProviderId,
    matchLevel,
    budgetRelation: relation,
    relevanceScore,
    explanations: dedupeExplanations(explanations),
    containsDemoData: groupContainsDemoData(group),
  };
}

function scoreIntentMatch(
  group: ProductGroup,
  intent: QueryIntent,
  explanations: RelevanceExplanation[],
): number {
  let score = tokenSimilarity(intent.keywords, group.title);

  if (intent.brand) {
    const brand = exactValue(group.brand)?.toLowerCase();
    if (brand && brand === intent.brand.toLowerCase()) {
      score = Math.min(1, score + 0.35);
      explanations.push({ key: 'relevance.brandMatch', detail: intent.brand });
    }
  }

  if (intent.model && group.identifiers.model === intent.model) {
    score = Math.min(1, score + 0.4);
    explanations.push({ key: 'relevance.modelMatch', detail: intent.model });
  }

  // A variant the user named explicitly is a strong signal in both directions:
  // matching it helps, contradicting it hurts substantially, because they told
  // us which configuration they wanted.
  for (const hint of intent.variantHints) {
    const attribute = group.variantAttributes.find((entry) => entry.key === hint.key);
    if (!attribute) continue;
    if (attribute.normalized === hint.value) {
      score = Math.min(1, score + 0.2);
      explanations.push({ key: 'relevance.variantMatch', detail: attribute.normalized });
    } else {
      score = Math.max(0, score - 0.3);
    }
  }

  if (intent.categoryPath && intent.categoryPath.length > 0) {
    const overlap = intent.categoryPath.filter((entry) => group.categoryPath.includes(entry));
    if (overlap.length > 0) score = Math.min(1, score + 0.1);
  }

  return clamp01(score);
}

/**
 * Budget fit.
 *
 * The shape of this function is the answer to rule 9. Within budget, score
 * rises as the price approaches the ceiling, because that is where the product
 * the user described actually lives. Far below the ceiling, score falls away —
 * not to zero, since genuine bargains exist, but far enough that cheap
 * unrelated goods cannot win on price alone.
 */
function scoreBudgetFit(
  group: ProductGroup,
  intent: QueryIntent,
  relation: BudgetRelation,
  explanations: RelevanceExplanation[],
): number {
  if (!intent.budgetMax && !intent.budgetMin) return 0.5;

  const offering = group.offerings[0];
  const price = offering ? exactValue(offering.offer.price) : undefined;

  if (!price) return 0.3;

  if (relation === 'ABOVE_BUDGET') {
    explanations.push({ key: 'relevance.aboveBudget' });
    return 0.05;
  }

  if (intent.budgetMax && price.currency === intent.budgetMax.currency) {
    const ratio = price.minor / intent.budgetMax.minor;

    if (ratio >= 0.6) {
      // The sweet spot: at or near the stated budget.
      explanations.push({ key: 'relevance.withinBudget' });
      return 1;
    }
    if (ratio >= 0.45) {
      explanations.push({ key: 'relevance.withinBudget' });
      return 0.8;
    }
    if (ratio >= 0.25) {
      explanations.push({ key: 'relevance.cheaperThanBudget' });
      return 0.45;
    }
    // Far below a stated budget. Usually a different class of product
    // entirely, so it is surfaced but not promoted.
    explanations.push({ key: 'relevance.farBelowBudget' });
    return 0.2;
  }

  if (relation === 'CHEAPER_THAN_BUDGET') {
    explanations.push({ key: 'relevance.cheaperThanBudget' });
    return 0.4;
  }

  explanations.push({ key: 'relevance.withinBudget' });
  return 0.7;
}

function scoreQuality(group: ProductGroup, explanations: RelevanceExplanation[]): number {
  let best = 0;
  let sawRating = false;

  for (const offering of group.offerings) {
    const rating = exactValue(offering.product.rating);
    const reviews = exactValue(offering.product.reviewCount) ?? 0;
    if (rating === undefined) continue;
    sawRating = true;

    // A 4.9 from eleven reviews is weaker evidence than a 4.5 from four
    // thousand, so the rating is damped by review volume rather than taken at
    // face value.
    const confidence = Math.min(1, Math.log10(reviews + 1) / 3);
    const normalized = (rating / 5) * (0.4 + 0.6 * confidence);
    best = Math.max(best, normalized);
  }

  // No rating is not a penalty. Amazon does not expose numeric ratings through
  // our integration at all, and punishing that would systematically demote one
  // source for a data-availability reason rather than a quality one.
  if (!sawRating) return 0.5;

  if (best > 0.7) explanations.push({ key: 'relevance.wellRated' });
  return best;
}

function scoreCompleteness(group: ProductGroup): number {
  let best = 0;
  for (const offering of group.offerings) {
    const cost = offering.offer.totalCost;
    let score = 0;
    if (isKnown(cost.total)) score = 1;
    else if (hasValue(cost.total)) score = 0.7;
    else if (hasValue(cost.itemPrice)) score = 0.4;

    if (hasValue(offering.offer.shipping.cost) || isKnown(offering.offer.shipping.free)) {
      score = Math.min(1, score + 0.1);
    }
    if (hasValue(offering.offer.availability)) score = Math.min(1, score + 0.05);
    best = Math.max(best, score);
  }
  return best;
}

function scoreFreshness(group: ProductGroup, now: Date): number {
  let best = 0;
  for (const offering of group.offerings) {
    const verdict = freshness(offering.offer.price, 3600, now);
    if (verdict.ageSeconds === null) continue;
    // Full marks under five minutes, decaying to zero at six hours.
    const score =
      verdict.ageSeconds <= 300
        ? 1
        : Math.max(0, 1 - (verdict.ageSeconds - 300) / (6 * 3600 - 300));
    best = Math.max(best, score);
  }
  return best;
}

function groupContainsDemoData(group: ProductGroup): boolean {
  return group.offerings.some((offering) => {
    const price = offering.offer.price;
    const provenance =
      price.state === 'KNOWN' || price.state === 'ESTIMATED' ? price.provenance : undefined;
    return provenance?.origin === 'DEMO_FIXTURE';
  });
}

function sortItems(
  items: ReadonlyArray<SearchResultItem>,
  sort: SortOption,
): ReadonlyArray<SearchResultItem> {
  const copy = [...items];

  switch (sort) {
    case 'MOST_RELEVANT':
      return copy.sort((a, b) => b.relevanceScore - a.relevanceScore);

    case 'BEST_MATCH':
      return copy.sort((a, b) => {
        const left = matchRank(a.matchLevel);
        const right = matchRank(b.matchLevel);
        return left !== right ? left - right : b.relevanceScore - a.relevanceScore;
      });

    case 'CLOSEST_TO_BUDGET':
      // Within budget first, nearest to the ceiling leading. A result above
      // budget never outranks one inside it.
      return copy.sort((a, b) => {
        const left = budgetRank(a.budgetRelation);
        const right = budgetRank(b.budgetRelation);
        if (left !== right) return left - right;
        return (priceOf(b) ?? 0) - (priceOf(a) ?? 0);
      });

    case 'LOWEST_OBSERVED_PRICE':
      // Items with no price sort last rather than sorting as zero.
      return copy.sort((a, b) => compareNullableAsc(priceOf(a), priceOf(b)));

    case 'LOWEST_ESTIMATED_TOTAL':
      return copy.sort((a, b) => compareNullableAsc(totalOf(a), totalOf(b)));

    case 'HIGHEST_RATED':
      return copy.sort((a, b) => {
        const left = ratingOf(a);
        const right = ratingOf(b);
        if (left === right) return b.relevanceScore - a.relevanceScore;
        if (left === null) return 1;
        if (right === null) return -1;
        return right - left;
      });

    case 'NEWEST_DEALS':
      return copy.sort((a, b) => observedAtOf(b) - observedAtOf(a));

    default:
      return copy.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }
}

function matchRank(level: SearchResultItem['matchLevel']): number {
  const order: ReadonlyArray<SearchResultItem['matchLevel']> = [
    'EXACT_MATCH',
    'LIKELY_SAME_MODEL',
    'VARIANT_MATCH',
    'STRONG_SIMILARITY',
    'ALTERNATIVE',
    'WEAK_SIMILARITY',
    'UNKNOWN',
  ];
  const index = order.indexOf(level);
  return index === -1 ? order.length : index;
}

function budgetRank(relation: BudgetRelation): number {
  switch (relation) {
    case 'WITHIN_BUDGET':
      return 0;
    case 'CHEAPER_THAN_BUDGET':
      return 1;
    case 'BUDGET_NOT_STATED':
      return 2;
    case 'PRICE_UNKNOWN':
      return 3;
    case 'ABOVE_BUDGET':
      return 4;
  }
}

function priceOf(item: SearchResultItem): number | null {
  const offering = item.group.offerings.find(
    (entry) => entry.providerId === item.primaryProviderId,
  );
  return exactValue(offering?.offer.price)?.minor ?? null;
}

function totalOf(item: SearchResultItem): number | null {
  const offering = item.group.offerings.find(
    (entry) => entry.providerId === item.primaryProviderId,
  );
  const total = offering?.offer.totalCost.total;
  if (!total) return null;
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
    }) ?? null;
  }
  return null;
}

function ratingOf(item: SearchResultItem): number | null {
  let best: number | null = null;
  for (const offering of item.group.offerings) {
    const rating = exactValue(offering.product.rating);
    if (rating === undefined) continue;
    best = best === null ? rating : Math.max(best, rating);
  }
  return best;
}

function observedAtOf(item: SearchResultItem): number {
  let newest = 0;
  for (const offering of item.group.offerings) {
    const at = Date.parse(offering.offer.observedAt);
    if (Number.isFinite(at)) newest = Math.max(newest, at);
  }
  return newest;
}

/** Ascending, with nulls last — an absent figure is not a low figure. */
function compareNullableAsc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function dedupeExplanations(
  explanations: ReadonlyArray<RelevanceExplanation>,
): ReadonlyArray<RelevanceExplanation> {
  const seen = new Set<string>();
  const out: RelevanceExplanation[] = [];
  for (const entry of explanations) {
    const key = `${entry.key}|${entry.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    // The popover is a short answer to "why is this here?", not a report.
    if (out.length >= 4) break;
  }
  return out;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Hard filters, applied before ranking.
 *
 * A stated budget ceiling is enforced here and not merely weighted: a ₪350
 * product does not appear for "up to ₪120" unless the user explicitly opted
 * into seeing results above budget (rules 230, 231).
 */
export function applyHardFilters(
  groups: ReadonlyArray<ProductGroup>,
  filters: SearchFilters,
  intent: QueryIntent,
): ReadonlyArray<ProductGroup> {
  const ceiling = filters.allowAboveBudget ? undefined : (filters.priceMax ?? intent.budgetMax);

  return groups.filter((group) => {
    // A group survives if any of its offerings passes, since the offerings are
    // alternative sources for the same product.
    return group.offerings.some((offering) => {
      const price = exactValue(offering.offer.price);

      if (ceiling) {
        if (!price) return false;
        if (price.currency === ceiling.currency && price.minor > ceiling.minor) return false;
      }

      const floor = filters.priceMin ?? intent.budgetMin;
      if (floor && price && price.currency === floor.currency && price.minor < floor.minor) {
        return false;
      }

      if (filters.providerIds && !filters.providerIds.includes(offering.providerId)) return false;

      if (filters.brands && filters.brands.length > 0) {
        const brand = exactValue(offering.product.brand)?.toLowerCase();
        if (!brand || !filters.brands.some((entry) => entry.toLowerCase() === brand)) return false;
      }

      if (filters.minRating !== undefined) {
        const rating = exactValue(offering.product.rating);
        // A source that does not expose ratings cannot satisfy a rating
        // filter. Excluding it is correct: the user asked for 4+ and we
        // cannot show that this meets it.
        if (rating === undefined || rating < filters.minRating) return false;
      }

      if (filters.minReviewCount !== undefined) {
        const reviews = exactValue(offering.product.reviewCount);
        if (reviews === undefined || reviews < filters.minReviewCount) return false;
      }

      if (filters.freeShippingOnly) {
        const free = offering.offer.shipping.free;
        // Only an explicit free-shipping statement passes. Unknown shipping
        // does not qualify, because we would be asserting it is free.
        if (!isKnown(free) || free.value !== true) return false;
      }

      if (filters.maxDeliveryDays !== undefined) {
        const days = exactValue(offering.offer.shipping.estimatedDays);
        if (!days || days.high > filters.maxDeliveryDays) return false;
      }

      if (filters.availability && filters.availability.length > 0) {
        const availability = exactValue(offering.offer.availability);
        if (!availability || !filters.availability.includes(availability)) return false;
      }

      if (filters.withCouponOnly && offering.offer.appliedCoupons.length === 0) return false;

      if (filters.exactMatchOnly && !assertsSameProduct(offering.match.level)) return false;

      if (filters.minMatchLevel) {
        if (matchRank(offering.match.level) > matchRank(filters.minMatchLevel)) return false;
      }

      if (filters.categoryPath && filters.categoryPath.length > 0) {
        const overlap = filters.categoryPath.some((entry) =>
          offering.product.categoryPath.includes(entry),
        );
        if (!overlap) return false;
      }

      return true;
    });
  });
}
