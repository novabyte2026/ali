import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  type NormalizedProduct,
  type ProductIdentifiers,
  type VariantAttribute,
  known,
  unknown,
} from '@shelf/shared';
import { matchProducts, satisfiesSameProductRequest } from '@shelf/backend';

/**
 * The matching invariants. These are the tests that matter most, because a
 * wrong match tells someone a counterfeit is the product they searched for.
 *
 * The central claim being pinned: heuristic evidence alone can never assert
 * identity. No combination of title, category and spec similarity may reach a
 * level the UI renders as "same product".
 */

const provenance = {
  origin: 'PROVIDER_API' as const,
  providerId: 'test',
  observedAt: new Date().toISOString(),
};

function product(overrides: {
  providerId?: string;
  identifiers: ProductIdentifiers;
  title: string;
  brand?: string;
  categoryPath?: ReadonlyArray<string>;
  variants?: ReadonlyArray<VariantAttribute>;
}): NormalizedProduct {
  return {
    providerId: overrides.providerId ?? 'amazon',
    identifiers: overrides.identifiers,
    title: overrides.title,
    rawTitle: overrides.title,
    brand: overrides.brand ? known(overrides.brand, provenance) : unknown('NOT_PROVIDED_BY_SOURCE'),
    category: overrides.categoryPath
      ? known(overrides.categoryPath.at(-1) ?? '', provenance)
      : unknown('NOT_PROVIDED_BY_SOURCE'),
    categoryPath: overrides.categoryPath ?? [],
    variantAttributes: overrides.variants ?? [],
    specifications: [],
    images: [],
    rating: unknown('NOT_PROVIDED_BY_SOURCE'),
    reviewCount: unknown('NOT_PROVIDED_BY_SOURCE'),
    sourceUrl: 'https://example.com/p',
  };
}

test('matching GTINs produce an exact match', () => {
  const a = product({
    identifiers: { providerProductId: 'A1', gtin: '00194644042974' },
    title: 'Soundcore Life Q30 Headphones',
    brand: 'Soundcore',
  });
  const b = product({
    providerId: 'aliexpress',
    identifiers: { providerProductId: 'B1', gtin: '00194644042974' },
    title: 'Soundcore Life Q30 Wireless Headset Original',
    brand: 'Soundcore',
  });

  const result = matchProducts(a, b);
  assert.equal(result.level, 'EXACT_MATCH');
  assert.ok(result.evidence.some((e) => e.signal === 'GTIN_AGREEMENT'));
});

test('different valid GTINs are decisively not the same product', () => {
  const a = product({
    identifiers: { providerProductId: 'A1', gtin: '00194644042974' },
    title: 'Soundcore Life Q30 Headphones',
    brand: 'Soundcore',
    categoryPath: ['audio', 'headphones'],
  });
  const b = product({
    providerId: 'aliexpress',
    identifiers: { providerProductId: 'B1', gtin: '00027242925557' },
    // Deliberately a near-identical title, to prove title similarity cannot
    // override a GTIN conflict.
    title: 'Soundcore Life Q30 Headphones',
    brand: 'Soundcore',
    categoryPath: ['audio', 'headphones'],
  });

  const result = matchProducts(a, b);
  assert.ok(!['EXACT_MATCH', 'LIKELY_SAME_MODEL'].includes(result.level));
});

test('INVARIANT: heuristic evidence alone never asserts identity', () => {
  // Two listings with identical titles, brands and categories but NO
  // identifiers. The strongest honest answer is "similar", never "same".
  const a = product({
    identifiers: { providerProductId: 'A1' },
    title: 'Generic Wireless Earbuds Bluetooth 5.3 Sport',
    categoryPath: ['electronics', 'audio', 'earbuds'],
  });
  const b = product({
    providerId: 'temu',
    identifiers: { providerProductId: 'B1' },
    title: 'Generic Wireless Earbuds Bluetooth 5.3 Sport',
    categoryPath: ['electronics', 'audio', 'earbuds'],
  });

  const result = matchProducts(a, b);
  assert.ok(
    !['EXACT_MATCH', 'LIKELY_SAME_MODEL'].includes(result.level),
    `heuristics reached ${result.level}, which asserts identity`,
  );
  assert.ok(result.score < 0.6, `score ${result.score} crossed the identity threshold`);
});

test('a variant conflict demotes an otherwise identical match', () => {
  const a = product({
    identifiers: { providerProductId: 'A1', gtin: '00619659200510', mpn: 'SDSQUAB064G' },
    title: 'SanDisk Ultra microSD',
    brand: 'SanDisk',
    variants: [{ key: 'capacity', normalized: '64GB', raw: '64GB' }],
  });
  const b = product({
    providerId: 'aliexpress',
    identifiers: { providerProductId: 'B1', gtin: '00619659200510', mpn: 'SDSQUAB064G' },
    title: 'SanDisk Ultra microSD',
    brand: 'SanDisk',
    variants: [{ key: 'capacity', normalized: '128GB', raw: '128GB' }],
  });

  const result = matchProducts(a, b);
  assert.equal(result.variantConflict, true);
  assert.equal(result.level, 'VARIANT_MATCH');
  assert.notEqual(result.level, 'EXACT_MATCH');
});

test('a missing variant attribute is not a conflict', () => {
  // One side states capacity, the other does not. That is an absence, not a
  // disagreement, and must not reject a correct match.
  const a = product({
    identifiers: { providerProductId: 'A1', gtin: '00619659200510' },
    title: 'SanDisk Ultra microSD 128GB',
    brand: 'SanDisk',
    variants: [{ key: 'capacity', normalized: '128GB', raw: '128GB' }],
  });
  const b = product({
    providerId: 'aliexpress',
    identifiers: { providerProductId: 'B1', gtin: '00619659200510' },
    title: 'SanDisk Ultra microSD',
    brand: 'SanDisk',
    variants: [],
  });

  const result = matchProducts(a, b);
  assert.equal(result.variantConflict, false);
  assert.equal(result.level, 'EXACT_MATCH');
});

test('different brands make an alternative, not a match', () => {
  const a = product({
    identifiers: { providerProductId: 'A1' },
    title: 'Wireless Noise Cancelling Headphones',
    brand: 'Sony',
    categoryPath: ['audio', 'headphones'],
  });
  const b = product({
    providerId: 'aliexpress',
    identifiers: { providerProductId: 'B1' },
    title: 'Wireless Noise Cancelling Headphones',
    brand: 'Anker',
    categoryPath: ['audio', 'headphones'],
  });

  const result = matchProducts(a, b);
  assert.ok(!['EXACT_MATCH', 'LIKELY_SAME_MODEL'].includes(result.level));
});

test('satisfiesSameProductRequest rejects a conflicting variant even on a model match', () => {
  const candidate = product({
    identifiers: { providerProductId: 'C1', model: 'WHCH720N' },
    title: 'Sony WH-CH720N',
    brand: 'Sony',
    variants: [{ key: 'colour', normalized: 'BLUE', raw: 'Blue' }],
  });

  const verdict = satisfiesSameProductRequest(candidate, {
    model: 'WHCH720N',
    brand: 'Sony',
    variantHints: [{ key: 'colour', value: 'BLACK' }],
  });

  assert.equal(verdict.satisfies, false);
  assert.equal(verdict.reasonKey, 'match.reject.variantMismatch');
});
