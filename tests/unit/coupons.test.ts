import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { type NormalizedCoupon, type NormalizedOffer, known, money, unknown } from '@shelf/shared';
import { applyCouponToOffer, resolveStatus } from '@shelf/backend';

/**
 * Coupon verification. "Verified" is a claim, and these tests pin that it is
 * only ever made on the strength of a recent check — and that an unverified
 * coupon is shown but never deducted from a total.
 */

const provenance = {
  origin: 'PROVIDER_API' as const,
  providerId: 'aliexpress',
  observedAt: new Date().toISOString(),
};

function coupon(overrides: Partial<NormalizedCoupon> = {}): NormalizedCoupon {
  return {
    couponId: 'c1',
    providerId: 'aliexpress',
    code: 'SAVE10',
    title: '10% off',
    terms: null,
    discountType: 'PERCENTAGE',
    discountPercent: known(10, provenance),
    discountAmount: unknown('NOT_PROVIDED_BY_SOURCE'),
    eligibility: {
      minimumOrder: unknown('NOT_PROVIDED_BY_SOURCE'),
      productIds: [],
      categoryPaths: [],
      countries: [],
      audience: 'ANY',
      stackable: unknown('NOT_PROVIDED_BY_SOURCE'),
    },
    startsAt: null,
    expiresAt: unknown('NOT_PROVIDED_BY_SOURCE'),
    status: 'VERIFIED',
    lastCheckedAt: new Date().toISOString(),
    verificationMethod: 'PROVIDER_API',
    sourceUrl: null,
    ...overrides,
  };
}

function offer(): NormalizedOffer {
  const price = known(money(10000, 'USD'), { ...provenance });
  return {
    providerId: 'aliexpress',
    providerProductId: 'p1',
    providerVariantId: null,
    price,
    referencePrice: unknown('NOT_PROVIDED_BY_SOURCE'),
    currency: 'USD',
    availability: known('IN_STOCK', provenance),
    shipping: {
      cost: unknown('NOT_PROVIDED_BY_SOURCE'),
      free: unknown('NOT_PROVIDED_BY_SOURCE'),
      destinationCountry: 'US',
      estimatedDays: unknown('NOT_PROVIDED_BY_SOURCE'),
      service: unknown('NOT_PROVIDED_BY_SOURCE'),
    },
    tax: {
      amount: unknown('NOT_COMPUTABLE'),
      includedInItemPrice: unknown('NOT_PROVIDED_BY_SOURCE'),
      appliedRate: null,
      destinationCountry: 'US',
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
      missingComponents: [],
      confidence: 'LOW',
    },
    sourceUrl: 'https://example.com/p',
    observedAt: provenance.observedAt,
  };
}

test('a fresh verified check resolves to VERIFIED', () => {
  assert.equal(resolveStatus(coupon({ lastCheckedAt: new Date().toISOString() })), 'VERIFIED');
});

test('a verified check older than the freshness window decays', () => {
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  assert.equal(resolveStatus(coupon({ lastCheckedAt: sevenHoursAgo })), 'RECENTLY_CHECKED');

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(resolveStatus(coupon({ lastCheckedAt: eightDaysAgo })), 'POSSIBLY_ACTIVE');
});

test('a coupon never checked by us is never VERIFIED', () => {
  const result = resolveStatus(
    coupon({ status: 'POSSIBLY_ACTIVE', verificationMethod: 'NONE', lastCheckedAt: null }),
  );
  assert.equal(result, 'POSSIBLY_ACTIVE');
});

test('a past-expiry coupon resolves to EXPIRED regardless of its stored status', () => {
  const result = resolveStatus(
    coupon({
      status: 'VERIFIED',
      expiresAt: known(new Date(Date.now() - 1000).toISOString(), provenance),
    }),
  );
  assert.equal(result, 'EXPIRED');
});

test('a verified unconditional coupon is applied and counted', () => {
  const applied = applyCouponToOffer(coupon(), offer(), { countryCode: 'US' });
  assert.equal(applied.applicable.state, 'KNOWN');
  if (applied.applicable.state === 'KNOWN') assert.equal(applied.applicable.value, true);
  // 10% of 100.00.
  assert.equal(applied.savings.state, 'KNOWN');
  if (applied.savings.state === 'KNOWN') assert.equal(applied.savings.value.minor, 1000);
});

test('a possibly-active coupon is shown but not counted toward a total', () => {
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const applied = applyCouponToOffer(
    coupon({ status: 'POSSIBLY_ACTIVE', lastCheckedAt: eightDaysAgo }),
    offer(),
    { countryCode: 'US' },
  );
  // Applicability is unknown, so the pricing engine will not deduct it.
  assert.notEqual(applied.applicable.state, 'KNOWN');
});

test('a new-customer coupon has unknown applicability, never auto-applied', () => {
  const applied = applyCouponToOffer(
    coupon({ eligibility: { ...coupon().eligibility, audience: 'NEW_CUSTOMERS' } }),
    offer(),
    { countryCode: 'US' },
  );
  assert.equal(applied.applicable.state, 'UNKNOWN');
});

test('a country-restricted coupon is rejected for the wrong country', () => {
  const applied = applyCouponToOffer(
    coupon({ eligibility: { ...coupon().eligibility, countries: ['GB'] } }),
    offer(),
    { countryCode: 'US' },
  );
  assert.equal(applied.applicable.state, 'KNOWN');
  if (applied.applicable.state === 'KNOWN') assert.equal(applied.applicable.value, false);
});
