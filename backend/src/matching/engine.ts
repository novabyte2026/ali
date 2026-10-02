import {
  type MatchEvidence,
  type MatchLevel,
  type MatchResult,
  type MatchSignal,
  type NormalizedProduct,
  type VariantAttribute,
  bandForScore,
  exactValue,
  normalizeText,
  tokenSimilarity,
  variantKey,
} from '@shelf/shared';

/**
 * Product identity matching.
 *
 * The decision this makes is the one with the worst consequences if it is
 * wrong: telling someone a $68 listing is the $80 product they searched for.
 * They find out when it arrives, and it is a counterfeit or a different model.
 *
 * So the engine is built around one invariant, enforced structurally below and
 * covered by a unit test:
 *
 *   Heuristic evidence alone can never assert identity.
 *
 * Title similarity, category agreement and (when it exists) image similarity
 * are capped so that no combination of them reaches EXACT_MATCH or
 * LIKELY_SAME_MODEL. Only an identifier — a checksum-valid GTIN, a
 * manufacturer part number, or an exact brand+model agreement — can do that.
 * Everything else tops out at STRONG_SIMILARITY, which the UI renders as
 * "similar product" and excludes from single-product price rows.
 *
 * The second invariant: a variant conflict we can read is decisive. 64GB and
 * 128GB are the same model and not the same product, and they must never share
 * a price row.
 */

export const ENGINE_VERSION = 'match-1.0.0';

/** Weights. Identifier signals dominate; heuristics are supporting evidence. */
const WEIGHTS: Record<MatchSignal, number> = {
  GTIN_AGREEMENT: 1.0,
  MPN_AGREEMENT: 0.85,
  PROVIDER_ID_AGREEMENT: 1.0,
  BRAND_AND_MODEL_AGREEMENT: 0.72,
  MODEL_NUMBER_AGREEMENT: 0.45,
  SPEC_AGREEMENT: 0.12,
  VARIANT_ATTRIBUTE_AGREEMENT: 0.15,
  VARIANT_ATTRIBUTE_CONFLICT: -0.5,
  TITLE_SIMILARITY: 0.3,
  CATEGORY_AGREEMENT: 0.1,
  IMAGE_SIMILARITY: 0.15,
  BRAND_CONFLICT: -0.9,
  CATEGORY_CONFLICT: -0.4,
  SPEC_CONFLICT: -0.25,
};

/**
 * Signals that can establish identity. Anything not in this set is supporting
 * evidence only, and the cap below is what makes that structural rather than a
 * matter of weight tuning.
 */
const IDENTITY_SIGNALS = new Set<MatchSignal>([
  'GTIN_AGREEMENT',
  'MPN_AGREEMENT',
  'PROVIDER_ID_AGREEMENT',
  'BRAND_AND_MODEL_AGREEMENT',
]);

/**
 * Ceiling on a score built only from heuristics. Sits below the 0.6 threshold
 * for LIKELY_SAME_MODEL, so no amount of title overlap can claim identity.
 */
const HEURISTIC_ONLY_CEILING = 0.55;

export function matchProducts(a: NormalizedProduct, b: NormalizedProduct): MatchResult {
  const evidence: MatchEvidence[] = [];

  // --- Same listing on the same provider ---------------------------------
  if (
    a.providerId === b.providerId &&
    a.identifiers.providerProductId === b.identifiers.providerProductId
  ) {
    const sameVariant =
      (a.identifiers.providerVariantId ?? '') === (b.identifiers.providerVariantId ?? '');
    if (sameVariant) {
      evidence.push(signal('PROVIDER_ID_AGREEMENT', 'providerProductId'));
      return finalize(evidence, { variantConflict: false });
    }
  }

  // --- Identifiers -------------------------------------------------------
  const gtinA = a.identifiers.gtin;
  const gtinB = b.identifiers.gtin;
  if (gtinA && gtinB) {
    if (gtinA === gtinB) {
      evidence.push(signal('GTIN_AGREEMENT', 'gtin'));
    } else {
      // Two valid, different GTINs is a positive statement that these are
      // different products. No amount of title similarity overrides it.
      return {
        level: 'WEAK_SIMILARITY',
        score: 0,
        band: 'LOW',
        evidence: [
          {
            signal: 'SPEC_CONFLICT',
            field: 'gtin',
            weight: WEIGHTS.SPEC_CONFLICT,
            messageKey: 'match.evidence.gtinConflict',
          },
        ],
        variantConflict: false,
      };
    }
  }

  const mpnA = a.identifiers.mpn;
  const mpnB = b.identifiers.mpn;
  if (mpnA && mpnB && mpnA === mpnB) {
    evidence.push(signal('MPN_AGREEMENT', 'mpn'));
  }

  // --- Brand and model ---------------------------------------------------
  const brandA = normalizeBrand(exactValue(a.brand));
  const brandB = normalizeBrand(exactValue(b.brand));
  const modelA = a.identifiers.model;
  const modelB = b.identifiers.model;

  if (brandA && brandB && brandA !== brandB) {
    // Different stated brands, same category: an alternative, not a match.
    evidence.push(signal('BRAND_CONFLICT', 'brand'));
  } else if (brandA && brandB && modelA && modelB && modelA === modelB) {
    evidence.push(signal('BRAND_AND_MODEL_AGREEMENT', 'brand+model'));
  } else if (modelA && modelB && modelA === modelB) {
    // Matching model tokens without confirmed brands. Suggestive, not
    // decisive: model strings collide across manufacturers more than you would
    // hope ("A3028" is not unique to one brand).
    evidence.push(signal('MODEL_NUMBER_AGREEMENT', 'model'));
  }

  // --- Category ----------------------------------------------------------
  const categoryOverlap = pathOverlap(a.categoryPath, b.categoryPath);
  if (categoryOverlap > 0) {
    evidence.push(signal('CATEGORY_AGREEMENT', 'categoryPath', WEIGHTS.CATEGORY_AGREEMENT * categoryOverlap));
  } else if (a.categoryPath.length > 0 && b.categoryPath.length > 0) {
    // Different taxonomies between providers mean a non-overlap is weak
    // evidence, so this is a small penalty rather than a disqualification.
    evidence.push(signal('CATEGORY_CONFLICT', 'categoryPath'));
  }

  // --- Title -------------------------------------------------------------
  const titleScore = tokenSimilarity(a.title, b.title);
  if (titleScore > 0.2) {
    evidence.push(signal('TITLE_SIMILARITY', 'title', WEIGHTS.TITLE_SIMILARITY * titleScore));
  }

  // --- Variants ----------------------------------------------------------
  const variants = compareVariants(a.variantAttributes, b.variantAttributes);
  for (const conflict of variants.conflicts) {
    evidence.push(signal('VARIANT_ATTRIBUTE_CONFLICT', conflict));
  }
  for (const agreement of variants.agreements) {
    evidence.push(signal('VARIANT_ATTRIBUTE_AGREEMENT', agreement));
  }

  // --- Specifications ----------------------------------------------------
  const specs = compareSpecifications(a, b);
  if (specs.agreements > 0) {
    evidence.push(
      signal('SPEC_AGREEMENT', 'specifications', WEIGHTS.SPEC_AGREEMENT * Math.min(specs.agreements, 3)),
    );
  }
  if (specs.conflicts > 0) {
    evidence.push(
      signal('SPEC_CONFLICT', 'specifications', WEIGHTS.SPEC_CONFLICT * Math.min(specs.conflicts, 2)),
    );
  }

  return finalize(evidence, { variantConflict: variants.conflicts.length > 0 });
}

function finalize(
  evidence: ReadonlyArray<MatchEvidence>,
  context: { readonly variantConflict: boolean },
): MatchResult {
  const rawScore = evidence.reduce((total, entry) => total + entry.weight, 0);
  const hasIdentityEvidence = evidence.some((entry) => IDENTITY_SIGNALS.has(entry.signal));

  // The structural cap. Without identifier evidence, the score cannot reach
  // the identity thresholds no matter how much heuristic evidence piles up.
  const capped = hasIdentityEvidence ? rawScore : Math.min(rawScore, HEURISTIC_ONLY_CEILING);
  const score = clamp01(capped);

  const level = levelFor({ score, hasIdentityEvidence, variantConflict: context.variantConflict, evidence });

  return {
    level,
    score,
    band: bandForScore(score),
    evidence,
    variantConflict: context.variantConflict,
  };
}

function levelFor(args: {
  readonly score: number;
  readonly hasIdentityEvidence: boolean;
  readonly variantConflict: boolean;
  readonly evidence: ReadonlyArray<MatchEvidence>;
}): MatchLevel {
  const brandConflict = args.evidence.some((entry) => entry.signal === 'BRAND_CONFLICT');

  // A readable variant difference on an otherwise identical model is its own
  // answer: same model, different product. It must never be EXACT_MATCH.
  if (args.variantConflict && args.hasIdentityEvidence) return 'VARIANT_MATCH';

  if (brandConflict) {
    // Different manufacturers. At best a reasonable alternative.
    return args.score >= 0.3 ? 'ALTERNATIVE' : 'WEAK_SIMILARITY';
  }

  if (args.hasIdentityEvidence) {
    if (args.score >= 0.85) return 'EXACT_MATCH';
    if (args.score >= 0.6) return 'LIKELY_SAME_MODEL';
    return 'STRONG_SIMILARITY';
  }

  if (args.score >= 0.45) return 'STRONG_SIMILARITY';
  if (args.score >= 0.25) return 'ALTERNATIVE';
  if (args.score > 0) return 'WEAK_SIMILARITY';
  return 'UNKNOWN';
}

function signal(kind: MatchSignal, field: string | null, weight?: number): MatchEvidence {
  return {
    signal: kind,
    field,
    weight: weight ?? WEIGHTS[kind],
    messageKey: `match.evidence.${kind}`,
  };
}

/**
 * Compares variant attributes.
 *
 * Only attributes *both* products state are compared. A missing capacity on
 * one side is not a conflict — it is an absence, and treating it as a conflict
 * would reject correct matches wherever one provider has sparser data, which
 * is most of the time.
 */
export function compareVariants(
  a: ReadonlyArray<VariantAttribute>,
  b: ReadonlyArray<VariantAttribute>,
): { readonly conflicts: ReadonlyArray<string>; readonly agreements: ReadonlyArray<string> } {
  const left = new Map(a.map((attribute) => [attribute.key, attribute.normalized] as const));
  const right = new Map(b.map((attribute) => [attribute.key, attribute.normalized] as const));

  const conflicts: string[] = [];
  const agreements: string[] = [];

  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined) continue;
    if (other === value) agreements.push(key);
    else conflicts.push(key);
  }

  return { conflicts, agreements };
}

function compareSpecifications(
  a: NormalizedProduct,
  b: NormalizedProduct,
): { readonly agreements: number; readonly conflicts: number } {
  const left = new Map(
    a.specifications.map((entry) => [entry.key, normalizeText(entry.value)] as const),
  );
  let agreements = 0;
  let conflicts = 0;

  for (const entry of b.specifications) {
    const other = left.get(entry.key);
    if (other === undefined) continue;
    const value = normalizeText(entry.value);
    // Free-text feature bullets are not comparable as specifications; only
    // structured keys are, so numeric/short values are compared and prose is
    // skipped rather than producing noise.
    if (value.length > 60 || other.length > 60) continue;
    if (value === other) agreements += 1;
    else conflicts += 1;
  }

  return { agreements, conflicts };
}

function pathOverlap(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a.map(normalizeText));
  let shared = 0;
  for (const entry of b) if (left.has(normalizeText(entry))) shared += 1;
  return shared / Math.max(a.length, b.length);
}

function normalizeBrand(brand: string | undefined): string | null {
  if (!brand) return null;
  const normalized = normalizeText(brand).replace(/[^\p{L}\p{N}]/gu, '');
  return normalized.length > 0 ? normalized : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Whether a candidate may be presented as the same product the user asked for,
 * given the query's own stated model and variant hints.
 *
 * Used by the "find this cheaper" flow, which must only ever show the same
 * product. A variant hint from the query ("128GB") that conflicts with a
 * candidate disqualifies it outright, even on a GTIN match — because the user
 * told us which variant they wanted.
 */
export function satisfiesSameProductRequest(
  candidate: NormalizedProduct,
  request: {
    readonly model?: string;
    readonly brand?: string;
    readonly variantHints: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  },
): { readonly satisfies: boolean; readonly reasonKey: string | null } {
  if (request.model) {
    const candidateModel = candidate.identifiers.model;
    if (!candidateModel) {
      return { satisfies: false, reasonKey: 'match.reject.noModelOnCandidate' };
    }
    if (candidateModel !== request.model) {
      return { satisfies: false, reasonKey: 'match.reject.modelMismatch' };
    }
  }

  if (request.brand) {
    const candidateBrand = normalizeBrand(exactValue(candidate.brand));
    if (candidateBrand && candidateBrand !== normalizeBrand(request.brand)) {
      return { satisfies: false, reasonKey: 'match.reject.brandMismatch' };
    }
  }

  for (const hint of request.variantHints) {
    const attribute = candidate.variantAttributes.find((entry) => entry.key === hint.key);
    if (attribute && attribute.normalized !== hint.value) {
      return { satisfies: false, reasonKey: 'match.reject.variantMismatch' };
    }
  }

  return { satisfies: true, reasonKey: null };
}

/**
 * Stable grouping key for a product identity, including its variant. Two
 * listings sharing this key are the same thing in the same configuration.
 */
export function identityKey(product: NormalizedProduct): string {
  const variant = variantKey(product.variantAttributes);
  if (product.identifiers.gtin) {
    return variant ? `gtin:${product.identifiers.gtin}#${variant}` : `gtin:${product.identifiers.gtin}`;
  }
  if (product.identifiers.mpn) {
    return variant ? `mpn:${product.identifiers.mpn}#${variant}` : `mpn:${product.identifiers.mpn}`;
  }
  const brand = normalizeBrand(exactValue(product.brand));
  if (brand && product.identifiers.model) {
    const base = `bm:${brand}|${product.identifiers.model}`;
    return variant ? `${base}#${variant}` : base;
  }
  // No identifiers: the listing is its own identity. It will not be merged
  // with anything, which is the correct outcome for an unidentifiable product.
  return `src:${product.providerId}|${product.identifiers.providerProductId}`;
}

/** Human-readable explanation of why a match was or was not asserted. */
export function explainMatch(result: MatchResult): ReadonlyArray<string> {
  const keys: string[] = [`match.level.${result.level}`];
  for (const entry of result.evidence) {
    if (entry.weight > 0.1 || entry.weight < -0.1) keys.push(entry.messageKey);
  }
  return [...new Set(keys)];
}
