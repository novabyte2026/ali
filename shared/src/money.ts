/**
 * Money is stored and computed in integer minor units (agorot, cents, pence)
 * to keep arithmetic exact. Floating point never touches a price.
 *
 * A Money value is always paired with its currency; two Money values of
 * different currencies cannot be added without an explicit, dated conversion
 * (see pricing/currency.ts). This is why `add` throws on a mismatch rather
 * than silently coercing: a wrong total is worse than an error.
 */

export type CurrencyCode = string;

export interface Money {
  /** Integer amount in the currency's minor unit. */
  readonly minor: number;
  readonly currency: CurrencyCode;
}

/** Minor-unit exponent per currency. Defaults to 2 for anything unlisted. */
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  ILS: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  CZK: 2,
  TRY: 2,
  BRL: 2,
  MXN: 2,
  INR: 2,
  CNY: 2,
  ZAR: 2,
  AED: 2,
  SAR: 2,
  // Zero-decimal currencies.
  JPY: 0,
  KRW: 0,
  CLP: 0,
  ISK: 0,
  VND: 0,
  // Three-decimal currencies.
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

export function minorUnitExponent(currency: CurrencyCode): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

export function minorUnitFactor(currency: CurrencyCode): number {
  return 10 ** minorUnitExponent(currency);
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(`Cannot combine ${left} with ${right} without an explicit conversion`);
    this.name = 'CurrencyMismatchError';
  }
}

export function money(minor: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(minor)) {
    throw new TypeError(`Money.minor must be an integer, received ${minor}`);
  }
  return { minor, currency: currency.toUpperCase() };
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

/**
 * Parses a decimal amount as it appears in a provider response. Providers send
 * prices as strings ("119.90") or numbers (119.9); both must land on the same
 * integer. Rounds half-up at the minor unit, which matches how marketplaces
 * present prices.
 *
 * Returns `null` for anything unparseable so callers produce an UNKNOWN Datum
 * rather than a zero.
 */
export function moneyFromDecimal(
  amount: string | number | null | undefined,
  currency: CurrencyCode | null | undefined,
): Money | null {
  if (amount === null || amount === undefined || !currency) return null;

  const raw = typeof amount === 'number' ? amount : Number.parseFloat(amount.trim());
  if (!Number.isFinite(raw)) return null;

  const factor = minorUnitFactor(currency);
  // Round half away from zero on the scaled value, guarding against binary
  // representation error (e.g. 1.005 * 100 === 100.49999999999999).
  const scaled = raw * factor;
  const minor = Math.round(Number.parseFloat(scaled.toPrecision(15)));
  return money(minor, currency);
}

export function toDecimal(value: Money): number {
  return value.minor / minorUnitFactor(value.currency);
}

/** Decimal string with the currency's canonical precision, e.g. "119.90". */
export function toDecimalString(value: Money): string {
  const exponent = minorUnitExponent(value.currency);
  const sign = value.minor < 0 ? '-' : '';
  const abs = Math.abs(value.minor).toString().padStart(exponent + 1, '0');
  if (exponent === 0) return `${sign}${abs}`;
  const whole = abs.slice(0, abs.length - exponent);
  const fraction = abs.slice(abs.length - exponent);
  return `${sign}${whole}.${fraction}`;
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return money(a.minor - b.minor, a.currency);
}

export function sum(values: ReadonlyArray<Money>, currency: CurrencyCode): Money {
  return values.reduce((acc, value) => add(acc, value), zero(currency));
}

/** Multiplies by a quantity (integer) — used for cart line items. */
export function multiply(value: Money, quantity: number): Money {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new TypeError(`Quantity must be a non-negative integer, received ${quantity}`);
  }
  return money(value.minor * quantity, value.currency);
}

/** Applies a ratio (e.g. a 0.17 VAT rate), rounding half-up. */
export function scale(value: Money, ratio: number): Money {
  if (!Number.isFinite(ratio)) throw new TypeError(`Ratio must be finite, got ${ratio}`);
  return money(Math.round(value.minor * ratio), value.currency);
}

/** Percentage off, e.g. percentOff(money(10000,'ILS'), 15) -> 1500 minor. */
export function percentOff(value: Money, percent: number): Money {
  return scale(value, percent / 100);
}

export function clampAtZero(value: Money): Money {
  return value.minor < 0 ? zero(value.currency) : value;
}

export function compare(a: Money, b: Money): number {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return a.minor - b.minor;
}

export function isZero(value: Money): boolean {
  return value.minor === 0;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/**
 * Locale-aware display string. Deliberately does not round to whole units:
 * showing ₪120 for a ₪119.90 item is the kind of small dishonesty that
 * erodes trust in a comparison product.
 */
export function formatMoney(
  value: Money,
  locale: string,
  options: { readonly showCurrency?: boolean } = {},
): string {
  const exponent = minorUnitExponent(value.currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: options.showCurrency === false ? 'decimal' : 'currency',
      currency: value.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(toDecimal(value));
  } catch {
    return `${toDecimalString(value)} ${value.currency}`;
  }
}

export function formatMoneyRange(low: Money, high: Money, locale: string): string {
  if (low.currency !== high.currency) throw new CurrencyMismatchError(low.currency, high.currency);
  if (equals(low, high)) return formatMoney(low, locale);
  const lowText = formatMoney(low, locale, { showCurrency: false });
  const highText = formatMoney(high, locale);
  return `${lowText}–${highText}`;
}
