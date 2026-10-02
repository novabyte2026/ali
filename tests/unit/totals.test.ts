import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { type Datum, type Money, known, money, unknown } from '@shelf/shared';
import { buildTotalCost } from '@shelf/integrations';

/**
 * The total-cost model. This is where "do not fabricate a number" is enforced,
 * so these are the tests that keep the product honest about the figure people
 * actually decide on.
 */

const provenance = {
  origin: 'PROVIDER_API' as const,
  providerId: 'test',
  observedAt: new Date().toISOString(),
};

const absent = <T>(): Datum<T> => unknown<T>('NOT_PROVIDED_BY_SOURCE', 'test');

function baseInput(overrides: Partial<Parameters<typeof buildTotalCost>[0]> = {}) {
  return {
    itemPrice: known(money(10000, 'USD'), provenance),
    shippingCost: absent<Money>(),
    shippingFree: absent<boolean>(),
    tax: absent<Money>(),
    referencePrice: absent<Money>(),
    appliedCoupons: [],
    currency: 'USD',
    providerId: 'test',
    observedAt: provenance.observedAt,
    ...overrides,
  };
}

test('total is KNOWN only when every component is known', () => {
  const total = buildTotalCost(
    baseInput({
      shippingCost: known(money(500, 'USD'), provenance),
      tax: known(money(0, 'USD'), provenance),
    }),
  );
  assert.equal(total.total.state, 'KNOWN');
  if (total.total.state === 'KNOWN') {
    assert.equal(total.total.value.minor, 10500);
  }
});

test('an explicit free-shipping statement counts as a known zero', () => {
  const total = buildTotalCost(
    baseInput({
      shippingFree: known(true, provenance),
      tax: known(money(0, 'USD'), provenance),
    }),
  );
  assert.equal(total.total.state, 'KNOWN');
  if (total.total.state === 'KNOWN') assert.equal(total.total.value.minor, 10000);
});

test('absent shipping is NOT treated as free', () => {
  // The core misreading this model prevents: no shipping figure must never
  // become a total that equals the item price.
  const total = buildTotalCost(baseInput());
  assert.notEqual(total.total.state, 'KNOWN');
  assert.ok(total.missingComponents.includes('SHIPPING'));
});

test('an unknown material component makes the total unavailable, never zero-filled', () => {
  const total = buildTotalCost(baseInput());
  // With shipping and tax both unknown, there is no honest ceiling, so the
  // total is UNKNOWN rather than an open-topped range.
  assert.equal(total.total.state, 'UNKNOWN');
});

test('an estimated component produces a range, never a point', () => {
  const total = buildTotalCost(
    baseInput({
      shippingCost: known(money(500, 'USD'), provenance),
      tax: {
        state: 'ESTIMATED',
        estimate: {
          low: money(0, 'USD'),
          high: money(1800, 'USD'),
          basis: 'DESTINATION_VAT_RATE_ESTIMATE',
          confidence: 'LOW',
        },
        provenance,
      },
    }),
  );
  assert.equal(total.total.state, 'ESTIMATED');
  if (total.total.state === 'ESTIMATED') {
    assert.ok(total.total.estimate.high.minor > total.total.estimate.low.minor);
  }
});

test('an unknown item price yields no total — a price of zero is never invented', () => {
  const total = buildTotalCost(
    baseInput({
      itemPrice: absent<Money>(),
      shippingCost: known(money(500, 'USD'), provenance),
      tax: known(money(0, 'USD'), provenance),
    }),
  );
  assert.equal(total.total.state, 'UNKNOWN');
});

test('a reference price at or below the current price is not a discount', () => {
  const total = buildTotalCost(
    baseInput({
      shippingCost: known(money(0, 'USD'), provenance),
      tax: known(money(0, 'USD'), provenance),
      // Reference equal to current — some sellers do this.
      referencePrice: known(money(10000, 'USD'), provenance),
    }),
  );
  assert.ok(!['KNOWN', 'ESTIMATED'].includes(total.discount.state));
});

test('a genuine reference price produces a stated discount', () => {
  const total = buildTotalCost(
    baseInput({
      shippingCost: known(money(0, 'USD'), provenance),
      tax: known(money(0, 'USD'), provenance),
      referencePrice: known(money(13000, 'USD'), provenance),
    }),
  );
  assert.equal(total.discount.state, 'KNOWN');
  if (total.discount.state === 'KNOWN') assert.equal(total.discount.value.minor, 3000);
});
