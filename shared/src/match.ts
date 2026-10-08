/**
 * Product identity. The hardest and most consequential problem in the product:
 * deciding whether an offer on one marketplace is *the same thing* as an offer
 * on another.
 *
 * The rule the whole system obeys: we assert "same model" only on the strength
 * of identifiers or an exact brand+model agreement. Similar titles and similar
 * images are evidence of similarity, never of identity. Being wrong here means
 * telling someone a ₪72 listing is the ₪110 product they searched for, and
 * they find out after it arrives.
 */

export const MATCH_LEVELS = [
  /** Same manufacturer product, same variant. Identifier-backed. */
  'EXACT_MATCH',
  /** Same model, variant not fully determined (e.g. colour unconfirmed). */
  'LIKELY_SAME_MODEL',
  /** Same model, explicitly different variant (64GB vs 128GB). */
  'VARIANT_MATCH',
  /** Same category and close specification, different product. */
  'STRONG_SIMILARITY',
  /** A reasonable alternative for the stated need, not the same product. */
  'ALTERNATIVE',
  /** Same category only. */
  'WEAK_SIMILARITY',
  /** Not enough information to place it. */
  'UNKNOWN',
] as const;

export type MatchLevel = (typeof MATCH_LEVELS)[number];

/** Levels at which it is honest to say "the same product". */
const SAME_PRODUCT_LEVELS = new Set<MatchLevel>(['EXACT_MATCH', 'LIKELY_SAME_MODEL']);

export function assertsSameProduct(level: MatchLevel): boolean {
  return SAME_PRODUCT_LEVELS.has(level);
}

/** Levels eligible for a cross-source price comparison of one product. */
export function eligibleForPriceComparison(level: MatchLevel): boolean {
  return level === 'EXACT_MATCH' || level === 'LIKELY_SAME_MODEL';
}

/** Levels eligible for the "find this cheaper" flow. Variants excluded. */
export function eligibleForCheaperSameProduct(level: MatchLevel): boolean {
  return level === 'EXACT_MATCH' || level === 'LIKELY_SAME_MODEL';
}

/**
 * Evidence kinds, ordered by how much weight they carry. Identifier agreement
 * is decisive; visual similarity is not, and on its own can never lift a match
 * above STRONG_SIMILARITY (see matching/engine.ts for the enforcement).
 */
export const MATCH_SIGNALS = [
  'GTIN_AGREEMENT',
  'MPN_AGREEMENT',
  'PROVIDER_ID_AGREEMENT',
  'BRAND_AND_MODEL_AGREEMENT',
  'MODEL_NUMBER_AGREEMENT',
  'SPEC_AGREEMENT',
  'VARIANT_ATTRIBUTE_AGREEMENT',
  'VARIANT_ATTRIBUTE_CONFLICT',
  'TITLE_SIMILARITY',
  'CATEGORY_AGREEMENT',
  'IMAGE_SIMILARITY',
  'BRAND_CONFLICT',
  'CATEGORY_CONFLICT',
  'SPEC_CONFLICT',
] as const;

export type MatchSignal = (typeof MATCH_SIGNALS)[number];

export interface MatchEvidence {
  readonly signal: MatchSignal;
  /** Which field agreed or conflicted, e.g. 'capacity'. Not user-facing raw. */
  readonly field: string | null;
  /** Signed contribution to the score. Negative for conflicts. */
  readonly weight: number;
  /** Translation key for the one-line user explanation. */
  readonly messageKey: string;
}

export interface MatchResult {
  readonly level: MatchLevel;
  /** 0..1 internal score. Shown to users as a band, never as a number. */
  readonly score: number;
  readonly band: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly evidence: ReadonlyArray<MatchEvidence>;
  /**
   * True when the two offers differ on a variant attribute we could read. The
   * comparison UI must not put them on the same price row.
   */
  readonly variantConflict: boolean;
}

export function bandForScore(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score >= 0.85) return 'HIGH';
  if (score >= 0.6) return 'MEDIUM';
  return 'LOW';
}

/** Translation key for the user-facing name of a match level. */
export function matchLevelKey(level: MatchLevel): string {
  return `match.level.${level}`;
}
