import {
  type MatchResult,
  type NormalizedOffer,
  type NormalizedProduct,
  type ProductGroup,
  type ProductGroupOffering,
  type ProductImage,
  assertsSameProduct,
  eligibleForPriceComparison,
  exactValue,
  productGroupId,
  variantKey,
} from '@shelf/shared';
import { ENGINE_VERSION, identityKey, matchProducts } from '../matching/engine.js';

/**
 * Turns three independent result lists into one comparison surface.
 *
 * This is what makes the product a comparison engine rather than three search
 * engines side by side (rule 92). Listings that are the same thing are merged
 * into one card with the sources as rows underneath; listings that are merely
 * similar stay separate.
 *
 * Two safeguards:
 *
 *   - Merging is identity-keyed, not similarity-keyed. A group forms around a
 *     GTIN, an MPN, or a brand+model pair — and the variant is part of the key,
 *     so a 64GB card never joins a 128GB card's group.
 *   - `comparableAcrossSources` is only true when every member's match to the
 *     group is identifier-backed. The UI reads that flag to decide whether it
 *     may present the members as price rows for a single product, so a group
 *     that merged on weaker evidence cannot be rendered as "same product,
 *     three prices".
 *
 * A listing with no identifiers at all becomes its own group. It will never be
 * compared against anything, which is the right answer for an unidentifiable
 * product and the reason the AliExpress and Temu result sets contain many
 * single-source cards.
 */

export interface GroupingInput {
  readonly product: NormalizedProduct;
  readonly offer: NormalizedOffer;
}

export interface GroupingOptions {
  /**
   * Providers whose policy permits their offers to appear alongside another
   * provider's. A provider without that permission is kept in its own group
   * even when identity matches, so a policy restriction is honoured at the
   * presentation boundary rather than relied on in the UI.
   */
  readonly crossProviderAllowed: ReadonlySet<string>;
}

export function groupListings(
  inputs: ReadonlyArray<GroupingInput>,
  options: GroupingOptions,
): ReadonlyArray<ProductGroup> {
  const buckets = new Map<string, GroupingInput[]>();

  for (const input of inputs) {
    const key = bucketKeyFor(input, options);
    const existing = buckets.get(key);
    if (existing) existing.push(input);
    else buckets.set(key, [input]);
  }

  const groups: ProductGroup[] = [];
  for (const [key, members] of buckets) {
    const group = buildGroup(key, members);
    if (group) groups.push(group);
  }
  return groups;
}

/**
 * Bucket key. A provider that may not be displayed alongside others gets a
 * provider-scoped key, which keeps it out of shared groups entirely.
 */
function bucketKeyFor(input: GroupingInput, options: GroupingOptions): string {
  const identity = identityKey(input.product);
  if (!options.crossProviderAllowed.has(input.product.providerId)) {
    return `isolated:${input.product.providerId}:${identity}`;
  }
  return identity;
}

function buildGroup(key: string, members: ReadonlyArray<GroupingInput>): ProductGroup | null {
  const first = members[0];
  if (!first) return null;

  // De-duplicate within a provider: the same listing can arrive twice from
  // paging or from a search plus a detail lookup (rule 90).
  const seen = new Set<string>();
  const unique: GroupingInput[] = [];
  for (const member of members) {
    const dedupeKey = `${member.product.providerId}|${member.offer.providerProductId}|${member.offer.providerVariantId ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(member);
  }

  // The representative is the member with the strongest identifiers, so the
  // group's title and brand come from the best-described listing rather than
  // from whichever provider answered first.
  const representative = [...unique].sort(
    (a, b) => identifierStrength(b.product) - identifierStrength(a.product),
  )[0] as GroupingInput;

  const offerings: ProductGroupOffering[] = unique.map((member) => ({
    providerId: member.product.providerId,
    product: member.product,
    offer: member.offer,
    match:
      member === representative
        ? anchorMatch(representative.product)
        : matchProducts(representative.product, member.product),
  }));

  // Only identifier-backed matches may be shown as rows of one product. A
  // single weak member demotes the whole group rather than being hidden,
  // because dropping it would silently remove a source from the comparison.
  const comparableAcrossSources =
    offerings.length > 1 &&
    offerings.every((offering) => eligibleForPriceComparison(offering.match.level)) &&
    new Set(offerings.map((offering) => offering.providerId)).size > 1;

  const variant = variantKey(representative.product.variantAttributes);

  return {
    groupId: productGroupId({
      ...(representative.product.identifiers.gtin
        ? { gtin: representative.product.identifiers.gtin }
        : {}),
      ...(representative.product.identifiers.mpn
        ? { mpn: representative.product.identifiers.mpn }
        : {}),
      ...(exactValue(representative.product.brand)
        ? { brand: exactValue(representative.product.brand) as string }
        : {}),
      ...(representative.product.identifiers.model
        ? { model: representative.product.identifiers.model }
        : {}),
      providerId: representative.product.providerId,
      providerProductId: representative.product.identifiers.providerProductId,
      ...(variant ? { variantKey: variant } : {}),
    }),
    title: representative.product.title,
    brand: representative.product.brand,
    categoryPath: representative.product.categoryPath,
    identifiers: {
      ...(representative.product.identifiers.gtin
        ? { gtin: representative.product.identifiers.gtin }
        : {}),
      ...(representative.product.identifiers.mpn
        ? { mpn: representative.product.identifiers.mpn }
        : {}),
      ...(representative.product.identifiers.model
        ? { model: representative.product.identifiers.model }
        : {}),
    },
    variantAttributes: representative.product.variantAttributes,
    primaryImage: pickPrimaryImage(unique),
    offerings,
    comparableAcrossSources,
    providerIds: [...new Set(offerings.map((offering) => offering.providerId))],
  };
}

/**
 * Prefers the largest displayable image across the group's members, so a
 * source with poor imagery does not determine the card's appearance.
 */
function pickPrimaryImage(members: ReadonlyArray<GroupingInput>): ProductImage | null {
  let best: ProductImage | null = null;
  for (const member of members) {
    for (const image of member.product.images) {
      if (!image.displayPermitted) continue;
      const area = (image.width ?? 0) * (image.height ?? 0);
      const bestArea = (best?.width ?? 0) * (best?.height ?? 0);
      if (!best || area > bestArea) best = image;
    }
  }
  return best;
}

/**
 * The representative listing's own identity statement.
 *
 * Comparing a listing to itself is not evidence, so this does not run the
 * matcher. It reports EXACT_MATCH only when a checksum-valid GTIN or a
 * manufacturer part number establishes what the product actually is, and
 * UNKNOWN otherwise. That distinction is what makes the "same model only"
 * filter meaningful: it keeps listings we cannot identify out of a result set
 * the user asked to restrict to a specific product.
 */
function anchorMatch(product: NormalizedProduct): MatchResult {
  const identifier = product.identifiers.gtin
    ? 'gtin'
    : product.identifiers.mpn
      ? 'mpn'
      : null;

  if (!identifier) {
    return {
      level: 'UNKNOWN',
      score: 0,
      band: 'LOW',
      evidence: [],
      variantConflict: false,
    };
  }

  return {
    level: 'EXACT_MATCH',
    score: 1,
    band: 'HIGH',
    evidence: [
      {
        signal: identifier === 'gtin' ? 'GTIN_AGREEMENT' : 'MPN_AGREEMENT',
        field: identifier,
        weight: 1,
        messageKey: `match.evidence.${identifier === 'gtin' ? 'GTIN_AGREEMENT' : 'MPN_AGREEMENT'}`,
      },
    ],
    variantConflict: false,
  };
}

function identifierStrength(product: NormalizedProduct): number {
  let score = 0;
  if (product.identifiers.gtin) score += 8;
  if (product.identifiers.mpn) score += 5;
  if (product.identifiers.model) score += 3;
  if (exactValue(product.brand)) score += 2;
  score += Math.min(product.variantAttributes.length, 3);
  score += product.specifications.length > 0 ? 1 : 0;
  return score;
}

/**
 * Chooses which provider headlines a group's card.
 *
 * Not simply the cheapest: a source whose total cost is unknown is a poor
 * headline even when its item price is lowest, because the card would show a
 * number that is not the cost. Preference order is a known total, then an
 * estimated total, then an item price alone.
 */
export function pickPrimaryProvider(group: ProductGroup): string {
  const scored = group.offerings.map((offering) => {
    const total = offering.offer.totalCost.total;
    const tier = total.state === 'KNOWN' ? 0 : total.state === 'ESTIMATED' ? 1 : 2;
    const amount =
      total.state === 'KNOWN'
        ? total.value.minor
        : total.state === 'ESTIMATED'
          ? Math.round((total.estimate.low.minor + total.estimate.high.minor) / 2)
          : (exactValue(offering.offer.price)?.minor ?? Number.MAX_SAFE_INTEGER);
    return { providerId: offering.providerId, tier, amount };
  });

  scored.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.amount - b.amount));
  return scored[0]?.providerId ?? (group.providerIds[0] as string);
}

/**
 * Identity claim for the group, used for the card badge.
 *
 * A single-source group gets whatever its own identifiers support and nothing
 * more: there is no second listing to have matched it against, so claiming
 * EXACT_MATCH would be asserting agreement with something that does not
 * exist. An anonymous marketplace listing therefore reports UNKNOWN and the
 * UI shows no match badge at all — which is the honest state for the large
 * number of listings that carry no identifiers.
 */
export function groupMatchLevel(group: ProductGroup) {
  if (group.offerings.length <= 1) {
    return group.offerings[0]?.match.level ?? 'UNKNOWN';
  }
  // The weakest member determines what we may claim about the group: a group
  // is only "the same product" if all of its members are.
  const levels = group.offerings.map((offering) => offering.match.level);
  if (levels.every(assertsSameProduct)) return 'EXACT_MATCH';
  if (levels.some((level) => level === 'VARIANT_MATCH')) return 'VARIANT_MATCH';
  return levels.includes('STRONG_SIMILARITY') ? 'STRONG_SIMILARITY' : (levels[0] ?? 'UNKNOWN');
}

export { ENGINE_VERSION };
