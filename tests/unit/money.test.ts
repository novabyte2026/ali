import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CurrencyMismatchError,
  add,
  formatMoney,
  minorUnitExponent,
  money,
  moneyFromDecimal,
  percentOff,
  scale,
  subtract,
  toDecimalString,
} from '@shelf/shared';

/**
 * Money is integer minor units, and these tests pin the arithmetic that a
 * wrong total would come from. The decimal-parsing cases in particular guard
 * the binary-representation trap (1.005 * 100 is not 100.5 in IEEE 754) that
 * would otherwise round a price wrong one time in a hundred.
 */

test('moneyFromDecimal parses strings and numbers to the same integer', () => {
  assert.deepEqual(moneyFromDecimal('119.90', 'ILS'), money(11990, 'ILS'));
  assert.deepEqual(moneyFromDecimal(119.9, 'ILS'), money(11990, 'ILS'));
  assert.deepEqual(moneyFromDecimal('0.01', 'USD'), money(1, 'USD'));
});

test('moneyFromDecimal rounds half-up at the minor unit without float error', () => {
  // The classic trap: 1.005 in IEEE 754 is slightly below 1.005.
  assert.deepEqual(moneyFromDecimal('1.005', 'USD'), money(101, 'USD'));
  assert.deepEqual(moneyFromDecimal('2.675', 'USD'), money(268, 'USD'));
});

test('moneyFromDecimal respects minor-unit exponent per currency', () => {
  // JPY has no minor unit; KWD has three.
  assert.equal(minorUnitExponent('JPY'), 0);
  assert.deepEqual(moneyFromDecimal('1200', 'JPY'), money(1200, 'JPY'));
  assert.equal(minorUnitExponent('KWD'), 3);
  assert.deepEqual(moneyFromDecimal('1.234', 'KWD'), money(1234, 'KWD'));
});

test('moneyFromDecimal returns null for unparseable or absent input', () => {
  assert.equal(moneyFromDecimal(null, 'USD'), null);
  assert.equal(moneyFromDecimal('abc', 'USD'), null);
  assert.equal(moneyFromDecimal('12.00', null), null);
  assert.equal(moneyFromDecimal(Number.NaN, 'USD'), null);
  assert.equal(moneyFromDecimal(Infinity, 'USD'), null);
});

test('add and subtract refuse to combine different currencies', () => {
  assert.throws(() => add(money(100, 'USD'), money(100, 'ILS')), CurrencyMismatchError);
  assert.throws(() => subtract(money(100, 'USD'), money(100, 'EUR')), CurrencyMismatchError);
  assert.deepEqual(add(money(100, 'USD'), money(50, 'USD')), money(150, 'USD'));
});

test('scale and percentOff round half-up and stay integer', () => {
  // 17% VAT on 99.90.
  assert.deepEqual(scale(money(9990, 'ILS'), 0.17), money(1698, 'ILS'));
  assert.deepEqual(percentOff(money(10000, 'ILS'), 15), money(1500, 'ILS'));
  // A rounding boundary.
  assert.deepEqual(scale(money(101, 'USD'), 0.5), money(51, 'USD'));
});

test('toDecimalString renders canonical precision, never truncating', () => {
  assert.equal(toDecimalString(money(11990, 'ILS')), '119.90');
  assert.equal(toDecimalString(money(1200, 'JPY')), '1200');
  assert.equal(toDecimalString(money(5, 'USD')), '0.05');
  assert.equal(toDecimalString(money(-250, 'USD')), '-2.50');
});

test('formatMoney does not round a price to whole units', () => {
  // The small dishonesty rule 205 prohibits: 119.90 must not show as 120.
  const formatted = formatMoney(money(11990, 'ILS'), 'he-IL');
  assert.match(formatted, /119[.,]90/);
});
