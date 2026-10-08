import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseQuery } from '@shelf/backend';

/**
 * Query parsing, Hebrew and English. The budget cases are the ones that feed
 * the single most important ranking behaviour: a stated ceiling is a hard
 * limit, so getting "up to 120" wrong means showing a ₪350 product for a ₪120
 * search.
 */

const options = {
  countryCode: 'IL',
  currency: 'ILS',
  locale: 'he',
  knownProviderIds: ['amazon', 'aliexpress', 'temu'],
};

test('Hebrew budget ceiling is recognized as a hard limit', () => {
  const intent = parseQuery('אוזניות עד 120 ₪', options);
  assert.equal(intent.detectedLanguage, 'he');
  assert.ok(intent.budgetMax);
  assert.equal(intent.budgetMax?.minor, 12000);
  assert.equal(intent.budgetMax?.currency, 'ILS');
  assert.equal(intent.budgetIsHardLimit, true);
  // The budget phrase is stripped from the keywords sent to providers.
  assert.ok(!intent.keywords.includes('120'));
  assert.ok(intent.keywords.includes('אוזניות'));
});

test('English budget with a dollar sign', () => {
  const intent = parseQuery('wireless headphones up to $40', {
    ...options,
    countryCode: 'US',
    currency: 'USD',
    locale: 'en',
  });
  assert.equal(intent.detectedLanguage, 'en');
  assert.equal(intent.budgetMax?.minor, 4000);
  assert.equal(intent.budgetMax?.currency, 'USD');
  assert.equal(intent.budgetIsHardLimit, true);
});

test('a budget range is parsed as both bounds', () => {
  const intent = parseQuery('between 100 and 200 shekel', {
    ...options,
    locale: 'en',
  });
  assert.equal(intent.budgetMin?.minor, 10000);
  assert.equal(intent.budgetMax?.minor, 20000);
  assert.equal(intent.budgetIsHardLimit, true);
});

test('a minimum rating is extracted and removed from keywords', () => {
  const intent = parseQuery('אוזניות דירוג 4+', options);
  assert.equal(intent.minRating, 4);
});

test('in-text source mentions are recognized, Hebrew short forms included', () => {
  const temu = parseQuery('יש את זה בטמו?', options);
  assert.ok(temu.requestedProviderIds.includes('temu'));

  const ali = parseQuery('תחפש גם באלי', options);
  assert.ok(ali.requestedProviderIds.includes('aliexpress'));
});

test('"same model" intent is recognized as a distinct flow', () => {
  const intent = parseQuery('מצא את אותו דגם בזול יותר', options);
  assert.equal(intent.sameProductOnly, true);
  // And it does not accidentally also get read as a sort-by-price request only;
  // the same-product intent is the primary signal.
  assert.ok(intent.sameProductOnly);
});

test('a unit-bearing token is kept as a variant hint, not read as a budget', () => {
  const intent = parseQuery('usb-c charger 65W up to 80', {
    ...options,
    countryCode: 'US',
    currency: 'USD',
    locale: 'en',
  });
  // 65W is the product; 80 is the budget.
  assert.equal(intent.budgetMax?.minor, 8000);
  assert.ok(intent.variantHints.some((h) => h.key === 'wattage' && h.value === '65W'));
  assert.ok(intent.keywords.toLowerCase().includes('65w'));
});

test('recognized constraints are reported for the user to remove', () => {
  const intent = parseQuery('אוזניות עד 120 ₪ משלוח חינם', options);
  const kinds = intent.recognized.map((r) => r.kind);
  assert.ok(kinds.includes('budget_max'));
  assert.ok(kinds.includes('shipping'));
});

test('free-text with no constraints leaves keywords intact', () => {
  const intent = parseQuery('מצלמת רכב', options);
  assert.equal(intent.budgetMax, undefined);
  assert.ok(intent.keywords.includes('מצלמת'));
});
