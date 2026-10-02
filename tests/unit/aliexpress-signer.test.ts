import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canonicalString, cleanParams, signTopRequest, topTimestamp } from '@shelf/integrations';

/**
 * AliExpress TOP signing. Two details cause silent 100%-failure if wrong and
 * are therefore pinned here: parameters are sorted by raw key, and empty
 * values are excluded from the signature.
 */

test('topTimestamp uses the gateway format in UTC', () => {
  assert.equal(topTimestamp(new Date('2026-01-15T10:30:45.000Z')), '2026-01-15 10:30:45');
});

test('cleanParams drops empty and nullish values', () => {
  const cleaned = cleanParams({ a: '1', b: '', c: undefined, d: null, e: 0, f: 'x' });
  assert.deepEqual(cleaned, { a: '1', e: '0', f: 'x' });
});

test('canonicalString sorts by key and concatenates key+value', () => {
  assert.equal(canonicalString({ b: '2', a: '1', c: '3' }), 'a1b2c3');
});

test('an empty value would change the digest if included — so it is excluded', () => {
  const withEmpty = signTopRequest({
    appSecret: 'secret',
    params: { a: '1', b: '' },
  });
  const without = signTopRequest({
    appSecret: 'secret',
    params: { a: '1' },
  });
  // Because b='' is excluded, both sign the same canonical string.
  assert.equal(withEmpty.sign, without.sign);
});

test('signTopRequest is deterministic and uppercase hex', () => {
  const a = signTopRequest({ appSecret: 'secret', params: { method: 'x', app_key: 'k' } });
  const b = signTopRequest({ appSecret: 'secret', params: { method: 'x', app_key: 'k' } });
  assert.equal(a.sign, b.sign);
  assert.match(a.sign, /^[0-9A-F]+$/);
});

test('a changed secret changes the signature', () => {
  const a = signTopRequest({ appSecret: 'secret1', params: { method: 'x' } });
  const b = signTopRequest({ appSecret: 'secret2', params: { method: 'x' } });
  assert.notEqual(a.sign, b.sign);
});
