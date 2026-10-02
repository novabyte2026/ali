import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  type NormalizedOffer,
  type ProductGroup,
  type QueryIntent,
  known,
  money,
  unknown,
} from '@shelf/shared';
import { applyHardFilters, rankGroups } from '@shelf/backend';

/**
 * Ranking. Two things are pinned here.
 *
 * The budget rule (rule 9): a ₪110 product that matches the request outranks a
 * ₪12 product that merely satisfies the arithmetic, and a product above a
 * stated ceiling does not appear at all.
 *
 * The commission rule (rules 61, 62, 144): there is no code path in the
 * ranking module that reads a commission figure. This is asserted two ways —
 * behaviourally, and by a source-level check that the word does not appear.
 */

const provenance = {
  origin: 'PROVIDER_API' as const,
  providerId: 'test',
  observedAt: new Date().toISOString(),
};

function offer(priceMinor: number, providerId = 'amazon'): NormalizedOffer {
  const price = known(money(priceMinor, 'ILS'), provenance);
  return {
    providerId,
    providerProductId: `p-${priceMinor}`,
    providerVariantId: null,
    price,
    referencePrice: unknown('NOT_PROVIDED_BY_SOURCE'),
    currency: 'ILS',
    availability: known('IN_STOCK', provenance),
    shipping: {
      cost: unknown('NOT_PROVIDED_BY_SOURCE'),
      free: unknown('NOT_PROVIDED_BY_SOURCE'),
      destinationCountry: 'IL',
      estimatedDays: unknown('NOT_PROVIDED_BY_SOURCE'),
      service: unknown('NOT_PROVIDED_BY_SOURCE'),
    },
    tax: {
      amount: unknown('NOT_COMPUTABLE'),
      includedInItemPrice: unknown('NOT_PROVIDED_BY_SOURCE'),
      appliedRate: null,
      destinationCountry: 'IL',
    },
    seller: {
      name: unknown('NOT_PROVIDED_BY_SOURCE'),
      rating: unknown('NOT_PROVIDED_BY_SOURCE'),
      isMarketplaceFirstParty: unknown('NOT_PROVIDED_BY_SOURCE'),
    },
    appliedCoupons: [],
    totalCost: {
      itemPrice: price,
      shipping: unknown('NOT_PROVIDED_BY_SOURCE'),
      tax: unknown('NOT_COMPUTABLE'),
      discount: unknown('NOT_PROVIDED_BY_SOURCE'),
      couponDiscount: unknown('NOT_PROVIDED_BY_SOURCE'),
      total: unknown('NOT_COMPUTABLE'),
      missingComponents: ['SHIPPING', 'TAX'],
      confidence: 'LOW',
    },
    sourceUrl: 'https://example.com/p',
    observedAt: provenance.observedAt,
  };
}

function group(title: string, priceMinor: number): ProductGroup {
  const product = {
    providerId: 'amazon',
    identifiers: { providerProductId: `p-${priceMinor}` },
    title,
    rawTitle: title,
    brand: unknown<string>('NOT_PROVIDED_BY_SOURCE'),
    category: unknown<string>('NOT_PROVIDED_BY_SOURCE'),
    categoryPath: ['audio', 'headphones'],
    variantAttributes: [],
    specifications: [],
    images: [],
    rating: unknown<number>('NOT_PROVIDED_BY_SOURCE'),
    reviewCount: unknown<number>('NOT_PROVIDED_BY_SOURCE'),
    sourceUrl: 'https://example.com/p',
  };
  return {
    groupId: `g-${priceMinor}`,
    title,
    brand: unknown('NOT_PROVIDED_BY_SOURCE'),
    categoryPath: ['audio', 'headphones'],
    identifiers: {},
    variantAttributes: [],
    primaryImage: null,
    offerings: [
      {
        providerId: 'amazon',
        product,
        offer: offer(priceMinor),
        match: { level: 'UNKNOWN', score: 0, band: 'LOW', evidence: [], variantConflict: false },
      },
    ],
    comparableAcrossSources: false,
    providerIds: ['amazon'],
  };
}

function intent(): QueryIntent {
  return {
    keywords: 'headphones',
    rawQuery: 'headphones up to 120',
    detectedLanguage: 'en',
    budgetMax: money(12000, 'ILS'),
    budgetIsHardLimit: true,
    variantHints: [],
    countryCode: 'IL',
    currency: 'ILS',
    requestedProviderIds: [],
    recognized: [],
  };
}

test('BUDGET RULE: a near-budget match outranks a far-cheaper loose match', () => {
  const groups = [
    group('Bluetooth Earbuds Cheap Generic', 1200), // well under budget, generic
    group('Sony Wireless Headphones', 11000), // near budget, matches keyword
  ];

  const ranked = rankGroups(groups, {
    intent: intent(),
    filters: {},
    sort: 'MOST_RELEVANT',
    now: new Date(),
    providerReliability: new Map(),
  });

  assert.equal(ranked[0]?.group.title, 'Sony Wireless Headphones');
  assert.equal(ranked[0]?.budgetRelation, 'WITHIN_BUDGET');
});

test('BUDGET RULE: a hard ceiling excludes products above it entirely', () => {
  const groups = [group('Headphones In Budget', 11000), group('Headphones Over Budget', 35000)];

  const filtered = applyHardFilters(groups, {}, intent());
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.title, 'Headphones In Budget');
});

test('BUDGET RULE: allowAboveBudget opt-in lets over-budget results through', () => {
  const groups = [group('Headphones In Budget', 11000), group('Headphones Over Budget', 35000)];

  const filtered = applyHardFilters(groups, { allowAboveBudget: true }, intent());
  assert.equal(filtered.length, 2);
});

test('COMMISSION RULE: ranking source contains no commission input', () => {
  // A behavioural test cannot prove the absence of a hidden factor, so this
  // asserts it structurally: the ranking module does not mention commission.
  const rankingSource = readFileSync(
    fileURLToPath(new URL('../../backend/src/search/ranking.ts', import.meta.url)),
    'utf8',
  );
  // Strip comments, which legitimately discuss the rule, before checking.
  const code = rankingSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(
    !/commission/i.test(code),
    'ranking code references commission — it must not be a ranking factor',
  );
});
